import type { ReactNode } from "react";
import type { HighlightedPhrase } from "@/types/schema";
import { LEGISLATION_SNAPSHOT_LABEL } from "@/lib/legislation-meta";

interface StatutoryTextProps {
  text: string;
  source: "india_code" | "indiankanoon";
  sourceUrl: string | null;
  highlights: HighlightedPhrase[];
}

interface Match {
  start: number;
  end: number;
  noteNumber: number;
}

function findMatches(text: string, highlights: HighlightedPhrase[]): Match[] {
  const matches: Match[] = [];
  highlights.forEach((h, i) => {
    const start = text.indexOf(h.phrase);
    if (start === -1) return;
    matches.push({ start, end: start + h.phrase.length, noteNumber: i + 1 });
  });
  matches.sort((a, b) => a.start - b.start);

  const nonOverlapping: Match[] = [];
  let lastEnd = -1;
  for (const m of matches) {
    if (m.start >= lastEnd) {
      nonOverlapping.push(m);
      lastEnd = m.end;
    }
  }
  return nonOverlapping;
}

function renderHighlighted(text: string, matches: Match[]): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  matches.forEach((m, i) => {
    if (m.start > cursor) nodes.push(text.slice(cursor, m.start));
    nodes.push(
      <a
        key={i}
        href={`#interpretation-note-${m.noteNumber}`}
        className="rounded-xs bg-accent-amber/15 px-0.5 text-ink no-underline"
      >
        {text.slice(m.start, m.end)}
        <sup className="text-accent-amber">{m.noteNumber}</sup>
      </a>,
    );
    cursor = m.end;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

export function StatutoryText({ text, source, sourceUrl, highlights }: StatutoryTextProps) {
  const matches = findMatches(text, highlights);

  return (
    <section className="mt-6">
      <h3 className="text-heading-5 text-ink">Statutory text</h3>
      <p className="mt-3 max-w-[70ch] whitespace-pre-wrap text-body-md text-ink">
        {renderHighlighted(text, matches)}
      </p>

      {source === "india_code" && (
        <p className="mt-2 text-caption text-steel">
          Sourced from a structured dataset snapshot ({LEGISLATION_SNAPSHOT_LABEL}). Legislation
          changes continuously — for the current official text,{" "}
          {sourceUrl ? (
            <a href={sourceUrl} target="_blank" rel="noopener noreferrer" className="underline">
              see the source
            </a>
          ) : (
            "check an official source"
          )}
          .
        </p>
      )}

      {highlights.length > 0 && (
        <ol className="mt-4 flex flex-col gap-3">
          {highlights.map((h, i) => (
            <li key={`${h.phrase}-${i}`} id={`interpretation-note-${i + 1}`} className="text-body-sm">
              <span className="font-medium text-ink">
                {i + 1}. &ldquo;{h.phrase}&rdquo;
              </span>{" "}
              <span className="text-steel">{h.interpretation_note}</span>
              <blockquote className="mt-1 max-w-[70ch] rounded-sm border border-hairline bg-surface px-3 py-2 font-mono text-code-sm text-charcoal">
                &ldquo;{h.supporting_quote}&rdquo;
              </blockquote>
              <a
                href={h.source_url}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 inline-block text-caption font-medium text-ink underline decoration-hairline underline-offset-2 hover:decoration-ink"
              >
                {h.case_name} — view source
              </a>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
