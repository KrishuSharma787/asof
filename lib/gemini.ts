import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { InterpretationResultSchema } from "../types/schema";
import type { RetrievedJudgment } from "./retrieval";

// Tried in order, falling through on quota exhaustion or an overloaded model.
//
// The free tier's 20 requests/day is scoped per project AND per model
// (quotaId GenerateRequestsPerDayPerProjectPerModel-FreeTier), so issuing a
// new API key inside the same project does nothing -- it inherits the same
// exhausted bucket. Each model, though, has its own allowance and its own
// capacity pool, and this session hit both walls: 3.6-flash ran out of daily
// quota, then 3.8-flash returned 503 "experiencing high demand". Falling
// across models turns either into a slower answer instead of no answer.
// Still a stopgap -- enabling billing removes the daily cap entirely.
const MODELS = ["gemini-3.7-flash", "gemini-3.8-flash", "gemini-3.5-flash"] as const;
// Trimmed from an original 20000 now that retrieval sends more sources per
// request (MAX_JUDGMENTS 10->18, AMENDMENT_SOURCE_CAP 5->8): the relevant
// interpretive passage is usually a fraction of a full judgment, so this
// trades a smaller amount of per-document depth for meaningfully broader
// coverage within a similar total prompt size.
// Judgments are sent as a window around the provision being asked about, not
// as whole documents. At 18 retrieved judgments, full-length excerpts pushed
// the prompt past ~50k tokens and Gemini 504'd on both attempts -- the user
// saw only "temporarily unavailable". A court's construction of a section
// sits around where it discusses that section, so windowing keeps the part
// that matters and drops the procedural bulk that never grounds anything.
const EXCERPT_CHAR_LIMIT = 3500;
// Statute-book hits only need the repealing sentence and its surroundings,
// not the whole Act. Keeping these short matters: with 18 judgments already
// in the prompt, sending four full Acts alongside them pushed Gemini past its
// own deadline and 504'd both attempts.
const STATUTE_BOOK_CHAR_LIMIT = 2500;
const RETRY_BACKOFF_MS = 2000;
const REQUEST_TIMEOUT_MS = 40000;

const RESPONSE_JSON_SCHEMA = z.toJSONSchema(InterpretationResultSchema);

export type GeminiFailureKind = "quota" | "transient" | "other";

export class GeminiError extends Error {
  constructor(
    public readonly kind: GeminiFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

// A daily-quota 429 and a transient 504 need opposite handling. Retrying a
// quota error is worse than pointless: it spends a second request against the
// very allowance that just ran out, and the user still waits for it. Only
// transient failures are worth a second attempt.
function classifyFailure(err: unknown): GeminiFailureKind {
  const status = (err as { status?: number })?.status;
  const message = String((err as { message?: string })?.message ?? "");
  if (status === 429 || /quota|rate limit|RESOURCE_EXHAUSTED/i.test(message)) return "quota";
  if (status === 503 || status === 504 || /DEADLINE_EXCEEDED|UNAVAILABLE/i.test(message)) {
    return "transient";
  }
  return "other";
}

// Deliberately one call, not two: an earlier version split the amendment
// timeline into its own Gemini call and hit two real problems in live
// testing -- the free tier's 20-requests/day cap exhausted almost
// immediately, and one request's paired retries alone summed past the
// route's 60s budget. Folding the timeline back into this single call
// (which already retries once) halves the Gemini calls per lookup.
const SYSTEM_INSTRUCTION = `You are a legal research assistant analyzing how Indian courts have interpreted a specific Act/section, and reconstructing its legislative amendment history. You are given the Act name, an optional section, the verbatim statutory text of the section when available, a numbered list of retrieved JUDGMENT/COMMENTARY sources, and a separate numbered list of retrieved AMENDMENT-HISTORY sources (India Code pages, PRS India summaries, legislative annotations).

Rules, all mandatory:
1. Only include a judgment in key_judgments if its excerpt shows a court actually construing or interpreting the meaning of a provision — not merely citing, quoting, or mentioning it in passing.
1a. When a specific section is given, "the provision" means that section. When NO section is given, the question is about the Act as a whole: include the landmark judgments that construe ANY significant provision of it, and name the section each one construes in effect_on_section (e.g. "Construed 'education' in s. 2(15)"). Returning an empty list because no section was specified is wrong -- an Act-level query is asking which decisions matter most across the whole Act.
2. Every supporting_quote (in key_judgments, highlighted_phrases, and amendment_timeline) must be an exact, verbatim substring copied from that specific entry's own source excerpt. Do not paraphrase, summarize, or combine text from different excerpts.
3. Every source_url must be copied character-for-character from the excerpt list it came from. Never modify or invent a URL.
4. If none of the JUDGMENT sources show a court actually interpreting the provision, set key_judgments to an empty array and reflect that in status/current_force_status_explanation/confidence — never invent an interpretation from your own training knowledge.
5. Do not state any interpretation, effect, or status claim that is not directly grounded in the provided excerpts.
6. status must be exactly one of: in_force, repealed, struck_down, read_down, omitted, unverified. A status is a claim that has to be earned:
   - Set status_evidence to the exact, verbatim sentence proving the status, plus the URL of the source it came from.
   - "repealed" requires a STATUTE-BOOK source showing THIS Act being repealed as a whole (e.g. "The X Act, 1961 is hereby repealed"). Read those sources carefully -- they contain near-misses that do NOT make this Act repealed: a provision repealing a DIFFERENT act (an earlier act of a similar name), or one repealing only a single SECTION of this Act. Match the repealed act's name and year exactly.
   - A statute-book repeal of this Act OUTRANKS any "in force" listing anywhere else in the sources. Newer Acts repeal older ones, and a directory that still lists the old Act as live is simply out of date. If a later Act repeals this one, the status is "repealed", full stop.
   - "struck_down"/"read_down" require a judgment excerpt showing the court doing so.
   - "in_force" is NOT a default. Claim it only if a source positively says this Act/section is in force or currently operative, and quote that.
   - NEVER cite the metadata header at the start of the statutory text (lines like "Act: The X Act, 1961 (Act 43 of 1961) | India | Central | In Force") as status evidence. That header is a dated snapshot label, not a statement of current law -- it has been observed still saying "In Force" for an Act that a later Act had already repealed.
   - If you cannot quote positive evidence for any status, return status "unverified" with status_evidence null. That is the correct, expected answer when the sources simply don't say -- it is never acceptable to fall back to "in_force" because nothing contradicted it.
7. confidence reflects how many/how strong the JUDGMENT grounding excerpts are: high (multiple clear, on-point excerpts, especially from higher courts), medium (some relevant material but limited or lower-tier), low (thin, tangential, or largely absent grounding).
8. highlighted_phrases: ONLY when verbatim statutory text is provided. For each specific word or short phrase in that text whose practical meaning a JUDGMENT excerpt shows has been narrowed, broadened, or otherwise changed from its plain reading, add an entry. "phrase" must be an exact, verbatim substring of the statutory text. If no statutory text is provided, or no phrase's interpretation is actually shown to have shifted, return an empty array.
9. amendment_timeline: built from the AMENDMENT-HISTORY sources AND from amendment footnotes inside the verbatim statutory text, if present. India Code text carries the authoritative record as footnotes -- "Subs. by Act 3 of 1989, s. 23, for ... (w.e.f. 1-4-1989)", "Ins. by Act 4 of 1988", "Omitted by Act 20 of 2002" -- and each is a quotable amendment event: use the amending Act's year (or the w.e.f. date's year) as "year" and quote the footnote verbatim as supporting_quote, with the statutory text's own source_url. Prefer these footnotes over commentary: they are the statute book itself. Never build an entry from a judgment source. Each entry is a legislative event only (enactment, an amending Act, an insertion, an omission) — never a court judgment. "event" is a short label (e.g. "Enacted", "Inserted by the IT (Amendment) Act, 2008"). "description" is one or two sentences of context. Order chronologically by year. If a reference amendment count is given in the prompt and your entries fall short of it, that's expected when sources don't cover every one — do not invent entries to make the count match. If no amendment-history sources describe an actual event, return an empty array.`;

function formatSources(
  sources: RetrievedJudgment[],
  startIndex: number,
  charLimit = EXCERPT_CHAR_LIMIT,
  focusPhrase?: string,
): string {
  return sources
    .map((s, i) => {
      let text = s.text;
      if (text.length > charLimit) {
        // A statute-book hit can be an entire Act, where the one sentence that
        // matters ("...is hereby repealed") may sit thousands of characters in.
        // Window around it rather than truncating from the start, which would
        // cut off the operative words and silently make the source useless.
        const at = focusPhrase ? text.toLowerCase().indexOf(focusPhrase.toLowerCase()) : -1;
        if (at !== -1) {
          const start = Math.max(0, at - Math.floor(charLimit / 2));
          text = `…${text.slice(start, start + charLimit)}…`;
        } else {
          text = `${text.slice(0, charLimit)} …[truncated]`;
        }
      }
      return `[${startIndex + i}] Title: ${s.title}\nCourt/Source: ${s.court}\nURL: ${s.url}\nText: ${text}`;
    })
    .join("\n\n");
}

export interface StatutoryTextInput {
  text: string;
  sourceUrl: string;
}

function buildUserPrompt(
  actName: string,
  section: string | null,
  sources: RetrievedJudgment[],
  amendmentSources: RetrievedJudgment[],
  statuteBookSources: RetrievedJudgment[],
  statutoryText: StatutoryTextInput | null,
): string {
  const statutoryBlock = statutoryText
    ? `\n\nVerbatim statutory text of the section (URL: ${statutoryText.sourceUrl}):\n${statutoryText.text}`
    : "";

  return `Act: ${actName}\nSection: ${section ?? "N/A"}${statutoryBlock}

STATUTE-BOOK sources (use these for force status -- whether this Act has been repealed by a later Act):

${statuteBookSources.length > 0 ? formatSources(statuteBookSources, 1, STATUTE_BOOK_CHAR_LIMIT, "hereby repealed") : "(none retrieved)"}

JUDGMENT/COMMENTARY sources:

${sources.length > 0 ? formatSources(sources, statuteBookSources.length + 1, EXCERPT_CHAR_LIMIT, section ?? actName.split(",")[0]) : "(none retrieved)"}

AMENDMENT-HISTORY sources:

${amendmentSources.length > 0 ? formatSources(amendmentSources, statuteBookSources.length + sources.length + 1) : "(none retrieved)"}

Using ONLY the sources above, produce the JSON result.`;
}

export async function synthesizeInterpretation(
  actName: string,
  section: string | null,
  sources: RetrievedJudgment[],
  amendmentSources: RetrievedJudgment[],
  statuteBookSources: RetrievedJudgment[] = [],
  statutoryText: StatutoryTextInput | null = null,
): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey });
  const userPrompt = buildUserPrompt(
    actName,
    section,
    sources,
    amendmentSources,
    statuteBookSources,
    statutoryText,
  );

  const call = (model: string) =>
    ai.models.generateContent({
      model,
      contents: userPrompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_JSON_SCHEMA,
        temperature: 0,
        httpOptions: { timeout: REQUEST_TIMEOUT_MS },
      },
    });

  let response: Awaited<ReturnType<typeof call>> | undefined;
  let lastKind: GeminiFailureKind = "other";
  let lastMessage = "";

  for (const model of MODELS) {
    try {
      response = await call(model);
      break;
    } catch (err) {
      lastKind = classifyFailure(err);
      lastMessage = String((err as Error).message);
      console.error(`[gemini] ${model} failed (${lastKind}), trying next model:`, lastMessage.slice(0, 200));
      // A quota wall won't clear by waiting, so move straight to the next
      // model. A transient spike might, so give it a moment first.
      if (lastKind !== "quota") {
        await new Promise((resolve) => setTimeout(resolve, RETRY_BACKOFF_MS));
      }
    }
  }

  if (!response) {
    throw new GeminiError(lastKind, lastMessage || "All Gemini models failed");
  }

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini response was not valid JSON: ${(err as Error).message}`);
  }
}
