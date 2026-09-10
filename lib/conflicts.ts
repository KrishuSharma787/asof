import type { KeyJudgment } from "../types/schema";
import type { CitationEdge } from "./groq";
import { classifyCourt, type CourtTier } from "./courtWeight";

export interface ConflictEntry {
  case_a: string;
  case_b: string;
  court_tier: CourtTier;
  position_a: string;
  position_b: string;
  supporting_quote: string;
}

// Pure logic over already-computed data (key_judgments + citation_edges) --
// no new API calls. A same-tier "distinguishes" edge is treated as the
// mechanical signal for a live conflict; if any judgment later overrules
// either side, the split is resolved rather than live, so it's excluded.
export function detectConflicts(
  judgments: KeyJudgment[],
  edges: CitationEdge[],
): ConflictEntry[] {
  const tierByCase = new Map(judgments.map((j) => [j.case_name, classifyCourt(j.court).tier]));
  const overruled = new Set(
    edges.filter((e) => e.relationship === "overrules").map((e) => e.to_case),
  );

  const conflicts: ConflictEntry[] = [];
  const seenPairs = new Set<string>();

  for (const edge of edges) {
    if (edge.relationship !== "distinguishes") continue;
    if (overruled.has(edge.from_case) || overruled.has(edge.to_case)) continue;

    const tierA = tierByCase.get(edge.from_case);
    const tierB = tierByCase.get(edge.to_case);
    if (!tierA || !tierB || tierA !== tierB) continue;

    const pairKey = [edge.from_case, edge.to_case].sort().join("::");
    if (seenPairs.has(pairKey)) continue;
    seenPairs.add(pairKey);

    const judgmentA = judgments.find((j) => j.case_name === edge.from_case);
    const judgmentB = judgments.find((j) => j.case_name === edge.to_case);
    if (!judgmentA || !judgmentB) continue;

    conflicts.push({
      case_a: judgmentA.case_name,
      case_b: judgmentB.case_name,
      court_tier: tierA,
      position_a: judgmentA.effect_on_section,
      position_b: judgmentB.effect_on_section,
      supporting_quote: edge.supporting_quote,
    });
  }

  return conflicts;
}
