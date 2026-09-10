import type { KeyJudgment } from "@/types/schema";

interface JudgmentListProps {
  judgments: KeyJudgment[];
}

export function JudgmentList({ judgments }: JudgmentListProps) {
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
        {judgments.map((judgment) => (
          <li key={`${judgment.case_name}-${judgment.source_url}`} className="py-5 first:pt-0">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h4 className="text-body-md font-medium text-ink">{judgment.case_name}</h4>
              <span className="text-body-sm text-steel">
                {judgment.court} · {judgment.year}
              </span>
            </div>
            <p className="mt-1 max-w-[70ch] text-body-sm text-steel">
              {judgment.effect_on_section}
            </p>
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
        ))}
      </ul>
    </section>
  );
}
