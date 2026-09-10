import type { ConflictEntry } from "@/lib/conflicts";

interface ConflictBannerProps {
  conflicts: ConflictEntry[];
}

export function ConflictBanner({ conflicts }: ConflictBannerProps) {
  if (conflicts.length === 0) return null;

  return (
    <section className="mt-6 rounded-lg bg-accent-amber/10 p-5">
      <h3 className="text-heading-5 text-ink">Conflicting interpretations found</h3>
      <p className="mt-1 text-body-sm text-steel">
        Courts at the same level reached different readings, and nothing in the retrieved
        sources resolves the split.
      </p>
      <ul className="mt-4 flex flex-col gap-4">
        {conflicts.map((conflict) => (
          <li key={`${conflict.case_a}-${conflict.case_b}`}>
            <p className="text-body-sm text-ink">
              <span className="font-medium">{conflict.case_a}:</span> {conflict.position_a}
            </p>
            <p className="mt-1 text-body-sm text-ink">
              <span className="font-medium">{conflict.case_b}:</span> {conflict.position_b}
            </p>
            <blockquote className="mt-2 max-w-[70ch] rounded-sm border border-hairline bg-canvas px-3 py-2 font-mono text-code-sm text-charcoal">
              &ldquo;{conflict.supporting_quote}&rdquo;
            </blockquote>
            <p className="mt-1 text-caption text-steel">AI-extracted — verify independently</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
