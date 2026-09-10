import { InterpretationResultSchema, type InterpretationResult } from "../types/schema";
import type { RetrievedJudgment } from "./retrieval";

export interface ValidationOutcome {
  result: InterpretationResult | null;
  droppedJudgments: string[];
  droppedHighlights: string[];
  droppedTimelineEntries: number;
  statusDowngraded: boolean;
  errors: string[];
}

// Straight-quote/whitespace normalization only: Gemini's natural-language
// output can render ASCII quotes as curly ones even when copying verbatim,
// which would otherwise cause a false-negative on a genuinely exact quote.
export function normalizeForMatch(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

const COMMON_WORD_STOPLIST = new Set([
  "or", "and", "not", "any", "all", "but", "may", "the", "for", "with",
  "from", "that", "this", "such", "shall", "been", "have", "has", "had",
  "was", "were", "are", "is", "of", "to", "in", "on", "by", "as", "if",
]);

function isTooGenericToHighlight(phrase: string): boolean {
  const words = phrase.trim().split(/\s+/);
  if (words.length > 1) return false;
  const bare = words[0]?.toLowerCase().replace(/[^a-z]/g, "") ?? "";
  return bare.length < 4 || COMMON_WORD_STOPLIST.has(bare);
}

export function validateInterpretationResult(
  raw: unknown,
  sources: RetrievedJudgment[],
  amendmentSources: RetrievedJudgment[],
  statutoryText: string | null = null,
  statuteBookSources: RetrievedJudgment[] = [],
): ValidationOutcome {
  const parsed = InterpretationResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      result: null,
      droppedJudgments: [],
      droppedHighlights: [],
      droppedTimelineEntries: 0,
      statusDowngraded: false,
      errors: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }

  const sourceByUrl = new Map(sources.map((s) => [s.url, s]));
  const droppedJudgments: string[] = [];

  const verifiedJudgments = parsed.data.key_judgments.filter((judgment) => {
    const source = sourceByUrl.get(judgment.source_url);
    if (!source) {
      droppedJudgments.push(judgment.case_name);
      return false;
    }
    const quoteFound = normalizeForMatch(source.text).includes(
      normalizeForMatch(judgment.supporting_quote),
    );
    if (!quoteFound) {
      droppedJudgments.push(judgment.case_name);
      return false;
    }
    return true;
  });

  const droppedHighlights: string[] = [];
  const normalizedStatutoryText = statutoryText ? normalizeForMatch(statutoryText) : null;

  const verifiedHighlights = parsed.data.highlighted_phrases.filter((highlight) => {
    // Backstop independent of the prompt: a bare common word ("or", "and",
    // "shall") verbatim-matches almost any block of English text and, once
    // rendered, matches every occurrence of that word in the DOM -- observed
    // live corrupting the middle of unrelated words ("Auth[or]" from a
    // highlight on the word "or"). The prompt now asks for a full clause
    // instead of the bare word, but this holds regardless of whether the
    // model complies.
    if (isTooGenericToHighlight(highlight.phrase)) {
      droppedHighlights.push(highlight.phrase);
      return false;
    }
    if (
      !normalizedStatutoryText ||
      !normalizedStatutoryText.includes(normalizeForMatch(highlight.phrase))
    ) {
      droppedHighlights.push(highlight.phrase);
      return false;
    }
    const source = sourceByUrl.get(highlight.source_url);
    if (!source) {
      droppedHighlights.push(highlight.phrase);
      return false;
    }
    if (!normalizeForMatch(source.text).includes(normalizeForMatch(highlight.supporting_quote))) {
      droppedHighlights.push(highlight.phrase);
      return false;
    }
    return true;
  });

  const amendmentSourceByUrl = new Map(amendmentSources.map((s) => [s.url, s]));
  let droppedTimelineEntries = 0;

  const verifiedTimeline = parsed.data.amendment_timeline.filter((entry) => {
    const normalizedQuote = normalizeForMatch(entry.supporting_quote);
    // A timeline entry may be grounded either in an amendment-history source
    // or in the statutory text's own India Code amendment footnotes, which
    // are the authoritative record and carry the statutory text's URL.
    const source = amendmentSourceByUrl.get(entry.source_url);
    const groundedInSource =
      !!source && normalizeForMatch(source.text).includes(normalizedQuote);
    const groundedInStatute =
      !!normalizedStatutoryText && normalizedStatutoryText.includes(normalizedQuote);

    if (!groundedInSource && !groundedInStatute) {
      droppedTimelineEntries += 1;
      return false;
    }
    return true;
  });

  // Status has to be backed by a verbatim quote from something we retrieved.
  // If the evidence doesn't check out, the claim doesn't survive: we downgrade
  // to "unverified" rather than letting an unsupported status through, which
  // is exactly how "in force" got asserted about a repealed Act.
  const statusSourceByUrl = new Map(
    [...sources, ...amendmentSources, ...statuteBookSources].map((s) => [s.url, s]),
  );
  const evidence = parsed.data.status_evidence;
  let statusEvidenceHolds = false;
  if (evidence) {
    const normalizedQuote = normalizeForMatch(evidence.supporting_quote);
    const source = statusSourceByUrl.get(evidence.source_url);
    statusEvidenceHolds =
      (!!source && normalizeForMatch(source.text).includes(normalizedQuote)) ||
      (!!normalizedStatutoryText && normalizedStatutoryText.includes(normalizedQuote));
  }

  const statusDowngraded = parsed.data.status !== "unverified" && !statusEvidenceHolds;
  const finalStatus = statusDowngraded ? "unverified" : parsed.data.status;

  return {
    result: {
      ...parsed.data,
      status: finalStatus,
      status_evidence: statusEvidenceHolds ? evidence : null,
      // "Status not verified" next to a "High confidence" badge reads as a
      // contradiction to anyone looking at the card, confirmed live -- and
      // that pairing isn't limited to a downgrade: the model can report
      // "unverified" on its own (correctly, when nothing in the sources
      // says either way) while still rating its judgment-interpretation
      // evidence "high" on the schema's own separate axis. Whatever the
      // reason, unverified status caps confidence at low.
      confidence: finalStatus === "unverified" ? "low" : parsed.data.confidence,
      key_judgments: verifiedJudgments,
      highlighted_phrases: verifiedHighlights,
      amendment_timeline: verifiedTimeline,
    },
    droppedJudgments,
    droppedHighlights,
    droppedTimelineEntries,
    statusDowngraded,
    errors: [],
  };
}
