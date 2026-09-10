import { InterpretationResultSchema, type InterpretationResult } from "../types/schema";
import type { RetrievedJudgment } from "./retrieval";

export interface ValidationOutcome {
  result: InterpretationResult | null;
  droppedJudgments: string[];
  droppedHighlights: string[];
  droppedTimelineEntries: number;
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

export function validateInterpretationResult(
  raw: unknown,
  sources: RetrievedJudgment[],
  amendmentSources: RetrievedJudgment[],
  statutoryText: string | null = null,
): ValidationOutcome {
  const parsed = InterpretationResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      result: null,
      droppedJudgments: [],
      droppedHighlights: [],
      droppedTimelineEntries: 0,
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
    const source = amendmentSourceByUrl.get(entry.source_url);
    if (!source) {
      droppedTimelineEntries += 1;
      return false;
    }
    if (!normalizeForMatch(source.text).includes(normalizeForMatch(entry.supporting_quote))) {
      droppedTimelineEntries += 1;
      return false;
    }
    return true;
  });

  return {
    result: {
      ...parsed.data,
      key_judgments: verifiedJudgments,
      highlighted_phrases: verifiedHighlights,
      amendment_timeline: verifiedTimeline,
    },
    droppedJudgments,
    droppedHighlights,
    droppedTimelineEntries,
    errors: [],
  };
}
