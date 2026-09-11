import type { Confidence, InterpretationResult, Status } from "@/types/schema";

interface StatusCardProps {
  result: Pick<
    InterpretationResult,
    | "act_name"
    | "section"
    | "status"
    | "status_evidence"
    | "current_force_status_explanation"
    | "confidence"
  >;
}

const STATUS_LABEL: Record<Status, string> = {
  in_force: "In force",
  repealed: "Repealed",
  struck_down: "Struck down",
  read_down: "Read down",
  omitted: "Omitted",
  unverified: "Status not verified",
};

const STATUS_STYLE: Record<Status, string> = {
  in_force: "bg-brand-green-text/10 text-brand-green-text",
  repealed: "bg-brand-error-text/10 text-brand-error-text",
  omitted: "bg-surface text-steel",
  read_down: "bg-brand-warn-text/10 text-brand-warn-text",
  struck_down: "bg-brand-error-text/10 text-brand-error-text",
  unverified: "bg-surface text-steel",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: "bg-brand-green-text/10 text-brand-green-text",
  medium: "bg-brand-warn-text/10 text-brand-warn-text",
  low: "bg-surface text-steel",
};

// DESIGN.md's badge family (badge-required, badge-type, badge-tag) uses
// rounded.sm for status/label chips; rounded.full is reserved for
// interactive pills (buttons, tabs) and the one-off promotional
// badge-discount. These are informational state labels, not controls, so
// they follow the badge precedent rather than the button one.
function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-sm px-3 py-1 text-body-sm font-medium ${className}`}
    >
      {label}
    </span>
  );
}

export function StatusCard({ result }: StatusCardProps) {
  return (
    <section className="rounded-lg border border-hairline bg-canvas p-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h2 className="text-heading-4 text-ink">
          {result.act_name}
          {result.section ? <span className="text-steel"> — Section {result.section}</span> : null}
        </h2>
        <div className="flex flex-wrap gap-2">
          <Badge label={STATUS_LABEL[result.status]} className={STATUS_STYLE[result.status]} />
          <Badge
            label={CONFIDENCE_LABEL[result.confidence]}
            className={CONFIDENCE_STYLE[result.confidence]}
          />
        </div>
      </div>

      <p className="mt-3 max-w-[70ch] text-body-sm text-steel">
        {result.current_force_status_explanation}
      </p>

      {result.status_evidence ? (
        <>
          <blockquote className="mt-3 max-w-[70ch] rounded-sm border border-hairline bg-surface px-3 py-2 font-mono text-code-sm text-charcoal">
            &ldquo;{result.status_evidence.supporting_quote}&rdquo;
          </blockquote>
          <a
            href={result.status_evidence.source_url}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-body-sm font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
          >
            Status source
          </a>
        </>
      ) : (
        <p className="mt-3 max-w-[70ch] text-caption text-steel">
          No source in this search positively confirmed the provision&apos;s current force status.
          Absence of a repeal here is not confirmation that it is in force.
        </p>
      )}
    </section>
  );
}
