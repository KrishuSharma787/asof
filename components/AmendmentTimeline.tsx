import type { AmendmentTimelineEntry, KeyJudgment } from "@/types/schema";

interface AmendmentTimelineProps {
  entries: AmendmentTimelineEntry[];
  judgments: KeyJudgment[];
}

interface YearBucket {
  year: number;
  amendments: AmendmentTimelineEntry[];
  judgments: KeyJudgment[];
}

const TRACK_HEIGHT = 132;
const AXIS_Y = 84;

// A list stops working at this scale -- the Income-tax Act has 258 recorded
// amendments -- so the timeline is drawn on a real time axis instead, with
// amendments below the line and judgments above it. Detail per event is
// deliberately omitted here: the point of this view is when things happened
// and how they cluster, and the full text of each entry lives in the lists
// below.
export function AmendmentTimeline({ entries, judgments }: AmendmentTimelineProps) {
  if (entries.length === 0 && judgments.length === 0) return null;

  const buckets = new Map<number, YearBucket>();
  const bucketFor = (year: number) => {
    if (!buckets.has(year)) buckets.set(year, { year, amendments: [], judgments: [] });
    return buckets.get(year)!;
  };
  for (const e of entries) bucketFor(e.year).amendments.push(e);
  for (const j of judgments) bucketFor(j.year).judgments.push(j);

  const years = [...buckets.values()].sort((a, b) => a.year - b.year);
  const minYear = years[0].year;
  const maxYear = years[years.length - 1].year;
  const span = Math.max(1, maxYear - minYear);

  const width = 1000;
  const padX = 28;
  const x = (year: number) => padX + ((year - minYear) / span) * (width - padX * 2);

  const maxStack = Math.max(...years.map((y) => Math.max(y.amendments.length, y.judgments.length)));
  // Squash tall stacks so a year with 20 amendments doesn't blow out the
  // track; the count label carries the magnitude instead.
  const stackStep = (count: number) => Math.min(count, 4) * (maxStack > 6 ? 5 : 7);

  const decadeTicks: number[] = [];
  for (let y = Math.ceil(minYear / 10) * 10; y <= maxYear; y += 10) decadeTicks.push(y);

  return (
    <section className="mt-6">
      <h3 className="text-heading-5 text-ink">Timeline</h3>
      <p className="mt-1 text-body-sm text-steel">
        {entries.length} amendment{entries.length === 1 ? "" : "s"} and {judgments.length} key
        judgment{judgments.length === 1 ? "" : "s"}, {minYear}–{maxYear}.
      </p>

      <div className="mt-3 overflow-x-auto rounded-lg border border-hairline bg-canvas p-4">
        <svg
          viewBox={`0 0 ${width} ${TRACK_HEIGHT}`}
          className="h-[132px] w-full min-w-[560px]"
          role="img"
          aria-label={`Timeline from ${minYear} to ${maxYear}: ${entries.length} amendments and ${judgments.length} key judgments`}
        >
          <line
            x1={padX}
            y1={AXIS_Y}
            x2={width - padX}
            y2={AXIS_Y}
            stroke="var(--color-hairline)"
            strokeWidth="1"
          />

          {decadeTicks.map((t) => (
            <g key={t}>
              <line
                x1={x(t)}
                y1={AXIS_Y}
                x2={x(t)}
                y2={AXIS_Y + 5}
                stroke="var(--color-hairline)"
                strokeWidth="1"
              />
              <text
                x={x(t)}
                y={AXIS_Y + 18}
                textAnchor="middle"
                className="fill-stone"
                style={{ fontSize: "11px" }}
              >
                {t}
              </text>
            </g>
          ))}

          {years.map((bucket) => (
            <g key={bucket.year}>
              {bucket.judgments.length > 0 && (
                <>
                  <line
                    x1={x(bucket.year)}
                    y1={AXIS_Y}
                    x2={x(bucket.year)}
                    y2={AXIS_Y - 8 - stackStep(bucket.judgments.length)}
                    stroke="var(--color-brand-error-text)"
                    strokeWidth="1"
                  />
                  <circle
                    cx={x(bucket.year)}
                    cy={AXIS_Y - 10 - stackStep(bucket.judgments.length)}
                    r={bucket.judgments.length > 1 ? 4 : 3}
                    fill="var(--color-brand-error-text)"
                  />
                </>
              )}
              {bucket.amendments.length > 0 && (
                <>
                  <line
                    x1={x(bucket.year)}
                    y1={AXIS_Y}
                    x2={x(bucket.year)}
                    y2={AXIS_Y + 8 + stackStep(bucket.amendments.length)}
                    stroke="var(--color-brand-warn-text)"
                    strokeWidth="1"
                  />
                  <circle
                    cx={x(bucket.year)}
                    cy={AXIS_Y + 10 + stackStep(bucket.amendments.length)}
                    r={bucket.amendments.length > 1 ? 4 : 3}
                    fill="var(--color-brand-warn-text)"
                  />
                  {bucket.amendments.length > 2 && (
                    <text
                      x={x(bucket.year)}
                      y={AXIS_Y + 14 + stackStep(bucket.amendments.length) + 8}
                      textAnchor="middle"
                      className="fill-stone"
                      style={{ fontSize: "11px" }}
                    >
                      {bucket.amendments.length}
                    </text>
                  )}
                </>
              )}
            </g>
          ))}
        </svg>
      </div>

      <div className="mt-2 flex flex-wrap gap-4 text-caption text-steel">
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-brand-error-text" />
          Judgments
        </span>
        <span className="inline-flex items-center gap-2">
          <span className="inline-block h-2 w-2 rounded-full bg-brand-warn-text" />
          Amendments
        </span>
      </div>

      {entries.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-body-sm font-medium text-ink">
            All {entries.length} amendment{entries.length === 1 ? "" : "s"}
          </summary>
          {/* Year and amending Act only. At this volume the useful thing is
              the shape of the record, not a paragraph per entry. */}
          <ul className="mt-3 grid gap-x-6 gap-y-1 sm:grid-cols-2">
            {entries.map((e, i) => (
              <li key={`${e.year}-${e.event}-${i}`} className="flex gap-2 text-body-sm">
                <span className="w-10 shrink-0 tabular-nums text-steel">{e.year}</span>
                <span className="text-ink">{e.event}</span>
              </li>
            ))}
          </ul>
          <a
            href={entries[0].source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block text-caption font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
          >
            Source: India Code
          </a>
        </details>
      )}
    </section>
  );
}
