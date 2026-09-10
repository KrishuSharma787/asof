import Groq from "groq-sdk";
import type { KeyJudgment } from "../types/schema";
import type { RetrievedJudgment } from "./retrieval";
import { normalizeForMatch } from "./validation";

const MODEL = "openai/gpt-oss-20b";
const REQUEST_TIMEOUT_MS = 20000;
const MAX_CONCURRENT_CALLS = 5;
const EXCERPT_CHAR_LIMIT = 12000;

// n choose 2 for n=10 (the retrieval hard cap) — enforced again explicitly
// below, not just implied by the judgment count.
const MAX_PAIRS = 45;

export type CitationRelationship = "follows" | "distinguishes" | "overrules" | "none";

export interface CitationEdge {
  from_case: string;
  to_case: string;
  relationship: CitationRelationship;
  supporting_quote: string;
}

const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    relationship: { type: "string", enum: ["follows", "distinguishes", "overrules", "none"] },
    supporting_quote: { type: ["string", "null"] },
  },
  required: ["relationship", "supporting_quote"],
  additionalProperties: false,
};

function buildPrompt(later: KeyJudgment, earlier: KeyJudgment, excerpt: string): string {
  return `You are analyzing whether one Indian court judgment cites another.

Later judgment: "${later.case_name}" (${later.court}, ${later.year})
Earlier judgment being checked for a citation: "${earlier.case_name}" (${earlier.court}, ${earlier.year})

Excerpt from the LATER judgment:
${excerpt}

Does the later judgment's excerpt discuss the earlier judgment, and if so how? Classify the relationship as one of:
- "follows": applies/relies on the earlier judgment's reasoning as binding or persuasive precedent
- "distinguishes": acknowledges the earlier judgment but holds it inapplicable to the present facts
- "overrules": explicitly overturns or holds the earlier judgment was wrongly decided
- "none": the excerpt does not clearly discuss the earlier judgment at all

If relationship is not "none", supporting_quote must be an exact, verbatim substring copied from the excerpt above proving the classification. If you cannot find such an exact quote, you must return relationship "none" and supporting_quote null.`;
}

async function classifyPair(
  client: Groq,
  later: KeyJudgment,
  earlier: KeyJudgment,
  laterText: string,
): Promise<{ relationship: CitationRelationship; quote: string | null }> {
  const excerpt =
    laterText.length > EXCERPT_CHAR_LIMIT ? laterText.slice(0, EXCERPT_CHAR_LIMIT) : laterText;

  const completion = await client.chat.completions.create({
    model: MODEL,
    messages: [{ role: "user", content: buildPrompt(later, earlier, excerpt) }],
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: { name: "citation_classification", schema: RESPONSE_SCHEMA, strict: true },
    },
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return { relationship: "none", quote: null };

  try {
    const parsed = JSON.parse(raw);
    const relationship: CitationRelationship = (
      ["follows", "distinguishes", "overrules", "none"] as const
    ).includes(parsed.relationship)
      ? parsed.relationship
      : "none";
    const quote = typeof parsed.supporting_quote === "string" ? parsed.supporting_quote : null;
    return { relationship, quote };
  } catch {
    return { relationship: "none", quote: null };
  }
}

async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

export async function extractCitationEdges(
  judgments: KeyJudgment[],
  sources: RetrievedJudgment[],
): Promise<CitationEdge[]> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY not set");
  if (judgments.length < 2) return [];

  const client = new Groq({ apiKey, timeout: REQUEST_TIMEOUT_MS });
  const sourceTextByUrl = new Map(sources.map((s) => [s.url, s.text]));
  const textByCaseName = new Map(
    judgments.map((j) => [j.case_name, sourceTextByUrl.get(j.source_url) ?? ""]),
  );

  // Only check whether a LATER judgment cites an EARLIER one — never the reverse.
  const ordered = [...judgments].sort((a, b) => a.year - b.year);
  const pairs: Array<{ later: KeyJudgment; earlier: KeyJudgment }> = [];
  for (let laterIdx = 1; laterIdx < ordered.length; laterIdx++) {
    for (let earlierIdx = 0; earlierIdx < laterIdx; earlierIdx++) {
      pairs.push({ later: ordered[laterIdx], earlier: ordered[earlierIdx] });
    }
  }
  const cappedPairs = pairs.slice(0, MAX_PAIRS);

  const classifications = await runWithConcurrencyLimit(
    cappedPairs,
    MAX_CONCURRENT_CALLS,
    async ({ later, earlier }): Promise<CitationEdge | null> => {
      const laterText = textByCaseName.get(later.case_name) ?? "";
      if (!laterText) return null;
      try {
        const { relationship, quote } = await classifyPair(client, later, earlier, laterText);
        if (relationship === "none" || !quote) return null;
        if (!normalizeForMatch(laterText).includes(normalizeForMatch(quote))) return null;
        return {
          from_case: later.case_name,
          to_case: earlier.case_name,
          relationship,
          supporting_quote: quote,
        };
      } catch (err) {
        console.error("[groq] pairwise classification failed:", err);
        return null;
      }
    },
  );

  return classifications.filter((edge): edge is CitationEdge => edge !== null);
}
