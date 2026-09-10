import type { AmendmentTimelineEntry } from "@/types/schema";

interface AmendmentTimelineProps {
  entries: AmendmentTimelineEntry[];
}

export function AmendmentTimeline({ entries }: AmendmentTimelineProps) {
  if (entries.length === 0) return null;

  return (
    <section className="mt-6">
      <h3 className="text-heading-5 text-ink">Amendment timeline</h3>
      <ul className="mt-3 divide-y divide-hairline-soft">
        {entries.map((entry, i) => (
          <li key={`${entry.year}-${entry.event}-${i}`} className="py-4 first:pt-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="text-body-sm font-medium text-ink">{entry.year}</span>
              <span className="text-body-sm text-ink">{entry.event}</span>
            </div>
            <p className="mt-1 max-w-[70ch] text-body-sm text-steel">{entry.description}</p>
            <blockquote className="mt-2 max-w-[70ch] rounded-sm border border-hairline bg-surface px-3 py-2 font-mono text-code-sm text-charcoal">
              &ldquo;{entry.supporting_quote}&rdquo;
            </blockquote>
            <a
              href={entry.source_url}
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
