import type { Confidence, InterpretationResult, Status } from "@/types/schema";

interface StatusCardProps {
  result: Pick<
    InterpretationResult,
    "act_name" | "section" | "status" | "current_force_status_explanation" | "confidence"
  >;
}

const STATUS_LABEL: Record<Status, string> = {
  in_force: "In force",
  repealed: "Repealed",
  struck_down: "Struck down",
  read_down: "Read down",
  omitted: "Omitted",
};

const STATUS_STYLE: Record<Status, string> = {
  in_force: "bg-surface text-steel",
  repealed: "bg-surface text-steel",
  omitted: "bg-surface text-steel",
  read_down: "bg-accent-amber/10 text-accent-amber",
  struck_down: "bg-accent-red/10 text-accent-red",
};

const CONFIDENCE_LABEL: Record<Confidence, string> = {
  high: "High confidence",
  medium: "Medium confidence",
  low: "Low confidence",
};

const CONFIDENCE_STYLE: Record<Confidence, string> = {
  high: "bg-accent-green/10 text-accent-green",
  medium: "bg-accent-amber/10 text-accent-amber",
  low: "bg-surface text-steel",
};

function Badge({ label, className }: { label: string; className: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-3 py-1 text-body-sm font-medium ${className}`}
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
    </section>
  );
}
