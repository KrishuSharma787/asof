import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { InterpretationResultSchema } from "../types/schema";
import type { RetrievedJudgment } from "./retrieval";

const MODEL = "gemini-3.6-flash";
const EXCERPT_CHAR_LIMIT = 20000;
const REQUEST_TIMEOUT_MS = 30000;

const RESPONSE_JSON_SCHEMA = z.toJSONSchema(InterpretationResultSchema);

// Deliberately one call, not two: an earlier version split the amendment
// timeline into its own Gemini call and hit two real problems in live
// testing -- the free tier's 20-requests/day cap exhausted almost
// immediately, and one request's paired retries alone summed past the
// route's 60s budget. Folding the timeline back into this single call
// (which already retries once) halves the Gemini calls per lookup.
const SYSTEM_INSTRUCTION = `You are a legal research assistant analyzing how Indian courts have interpreted a specific Act/section, and reconstructing its legislative amendment history. You are given the Act name, an optional section, the verbatim statutory text of the section when available, a numbered list of retrieved JUDGMENT/COMMENTARY sources, and a separate numbered list of retrieved AMENDMENT-HISTORY sources (India Code pages, PRS India summaries, legislative annotations).

Rules, all mandatory:
1. Only include a judgment in key_judgments if its excerpt shows a court actually construing or interpreting the meaning of the provision — not merely citing, quoting, or mentioning it in passing.
2. Every supporting_quote (in key_judgments, highlighted_phrases, and amendment_timeline) must be an exact, verbatim substring copied from that specific entry's own source excerpt. Do not paraphrase, summarize, or combine text from different excerpts.
3. Every source_url must be copied character-for-character from the excerpt list it came from. Never modify or invent a URL.
4. If none of the JUDGMENT sources show a court actually interpreting the provision, set key_judgments to an empty array and reflect that in status/current_force_status_explanation/confidence — never invent an interpretation from your own training knowledge.
5. Do not state any interpretation, effect, or status claim that is not directly grounded in the provided excerpts.
6. status must be exactly one of: in_force, repealed, struck_down, read_down, omitted.
7. confidence reflects how many/how strong the JUDGMENT grounding excerpts are: high (multiple clear, on-point excerpts, especially from higher courts), medium (some relevant material but limited or lower-tier), low (thin, tangential, or largely absent grounding).
8. highlighted_phrases: ONLY when verbatim statutory text is provided. For each specific word or short phrase in that text whose practical meaning a JUDGMENT excerpt shows has been narrowed, broadened, or otherwise changed from its plain reading, add an entry. "phrase" must be an exact, verbatim substring of the statutory text. If no statutory text is provided, or no phrase's interpretation is actually shown to have shifted, return an empty array.
9. amendment_timeline: built ONLY from the AMENDMENT-HISTORY sources, not the judgment sources. Each entry is a legislative event only (enactment, an amending Act, an insertion, an omission) — never a court judgment. "event" is a short label (e.g. "Enacted", "Inserted by the IT (Amendment) Act, 2008"). "description" is one or two sentences of context. Order chronologically by year. If a reference amendment count is given in the prompt and your entries fall short of it, that's expected when sources don't cover every one — do not invent entries to make the count match. If no amendment-history sources describe an actual event, return an empty array.`;

function formatSources(sources: RetrievedJudgment[], startIndex: number): string {
  return sources
    .map((s, i) => {
      const text =
        s.text.length > EXCERPT_CHAR_LIMIT
          ? `${s.text.slice(0, EXCERPT_CHAR_LIMIT)} …[truncated]`
          : s.text;
      return `[${startIndex + i}] Title: ${s.title}\nCourt/Source: ${s.court}\nURL: ${s.url}\nText: ${text}`;
    })
    .join("\n\n");
}

interface VaquillAnchor {
  enactmentYear: number | null;
  amendmentCount: number | null;
}

function buildUserPrompt(
  actName: string,
  section: string | null,
  sources: RetrievedJudgment[],
  amendmentSources: RetrievedJudgment[],
  statutoryText: string | null,
  vaquillAnchor: VaquillAnchor | null,
): string {
  const statutoryBlock = statutoryText
    ? `\n\nVerbatim statutory text of the section:\n${statutoryText}`
    : "";
  const anchorBlock =
    vaquillAnchor && (vaquillAnchor.enactmentYear !== null || vaquillAnchor.amendmentCount !== null)
      ? `\n\nReference data from an official structured source: enactment year ${vaquillAnchor.enactmentYear ?? "unknown"}, total recorded amendments ${vaquillAnchor.amendmentCount ?? "unknown"}.`
      : "";

  return `Act: ${actName}\nSection: ${section ?? "N/A"}${statutoryBlock}${anchorBlock}

JUDGMENT/COMMENTARY sources:

${sources.length > 0 ? formatSources(sources, 1) : "(none retrieved)"}

AMENDMENT-HISTORY sources:

${amendmentSources.length > 0 ? formatSources(amendmentSources, sources.length + 1) : "(none retrieved)"}

Using ONLY the sources above, produce the JSON result.`;
}

export async function synthesizeInterpretation(
  actName: string,
  section: string | null,
  sources: RetrievedJudgment[],
  amendmentSources: RetrievedJudgment[],
  statutoryText: string | null = null,
  vaquillAnchor: VaquillAnchor | null = null,
): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey });
  const userPrompt = buildUserPrompt(
    actName,
    section,
    sources,
    amendmentSources,
    statutoryText,
    vaquillAnchor,
  );

  const call = () =>
    ai.models.generateContent({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_JSON_SCHEMA,
        temperature: 0,
        httpOptions: { timeout: REQUEST_TIMEOUT_MS },
      },
    });

  let response;
  try {
    response = await call();
  } catch (firstErr) {
    console.error("[gemini] first attempt failed, retrying once:", firstErr);
    response = await call();
  }

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini response was not valid JSON: ${(err as Error).message}`);
  }
}
