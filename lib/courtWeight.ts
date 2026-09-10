export type CourtTier = "supreme_court" | "high_court" | "tribunal" | "other";

const TIER_STARS: Record<CourtTier, number> = {
  supreme_court: 5,
  high_court: 4,
  tribunal: 3,
  other: 2,
};

export function classifyCourt(courtName: string): { tier: CourtTier; stars: number } {
  const name = courtName.toLowerCase();
  let tier: CourtTier;
  if (name.includes("supreme court")) {
    tier = "supreme_court";
  } else if (name.includes("high court")) {
    tier = "high_court";
  } else if (name.includes("tribunal")) {
    tier = "tribunal";
  } else {
    tier = "other";
  }
  return { tier, stars: TIER_STARS[tier] };
}
