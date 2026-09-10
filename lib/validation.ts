import { InterpretationResultSchema, type InterpretationResult } from "../types/schema";
import type { RetrievedJudgment } from "./retrieval";

export interface ValidationOutcome {
  result: InterpretationResult | null;
  droppedJudgments: string[];
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
): ValidationOutcome {
  const parsed = InterpretationResultSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      result: null,
      droppedJudgments: [],
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

  return {
    result: { ...parsed.data, key_judgments: verifiedJudgments },
    droppedJudgments,
    errors: [],
  };
}
