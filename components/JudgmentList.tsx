import type { KeyJudgment } from "@/types/schema";
import { classifyCourt } from "@/lib/courtWeight";

interface JudgmentListProps {
  judgments: KeyJudgment[];
  lastAmendmentYear: number | null;
}

function Star({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={filled ? 0 : 1.5}
      strokeLinejoin="round"
    >
      <path d="M12 3.5l2.6 5.6 6.1.7-4.5 4.2 1.2 6-5.4-3-5.4 3 1.2-6-4.5-4.2 6.1-.7L12 3.5z" />
    </svg>
  );
}

function CourtRating({ court }: { court: string }) {
  const { stars } = classifyCourt(court);
  return (
    <span
      className="inline-flex items-center gap-0.5 text-steel"
      role="img"
      aria-label={`Court weight: ${stars} of 5`}
    >
      {Array.from({ length: 5 }, (_, i) => (
        <Star key={i} filled={i < stars} />
      ))}
    </span>
  );
}

export function JudgmentList({ judgments, lastAmendmentYear }: JudgmentListProps) {
  if (judgments.length === 0) {
    return (
      <section className="mt-6">
        <h3 className="text-heading-5 text-ink">Key judgments</h3>
        <p className="mt-2 text-body-sm text-steel">
          No judgments in the retrieved sources were found to actually construe this
          provision&apos;s meaning.
        </p>
      </section>
    );
  }

  return (
    <section className="mt-6">
      <h3 className="text-heading-5 text-ink">Key judgments</h3>
      <ul className="mt-3 divide-y divide-hairline-soft">
        {judgments.map((judgment) => {
          const predatesAmendment =
            lastAmendmentYear !== null && judgment.year < lastAmendmentYear;
          return (
            <li key={`${judgment.case_name}-${judgment.source_url}`} className="py-5 first:pt-0">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <h4 className="text-body-md font-medium text-ink">{judgment.case_name}</h4>
                <span className="flex items-center gap-2 text-body-sm text-steel">
                  {judgment.court} · {judgment.year}
                  <CourtRating court={judgment.court} />
                </span>
              </div>
              <p className="mt-1 max-w-[70ch] text-body-sm text-steel">
                {judgment.effect_on_section}
              </p>
              {predatesAmendment && (
                <p className="mt-1 text-caption text-accent-amber">
                  May predate the Act&apos;s last amendment ({lastAmendmentYear}) — check the
                  wording in force at the time.
                </p>
              )}
              <blockquote className="mt-3 max-w-[70ch] rounded-sm border border-hairline bg-surface px-3 py-2 font-mono text-code-sm text-charcoal">
                &ldquo;{judgment.supporting_quote}&rdquo;
              </blockquote>
              <a
                href={judgment.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-2 inline-block text-body-sm font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
              >
                View source
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
