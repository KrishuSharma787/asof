import type { CitationEdge } from "@/lib/groq";

interface CitationGraphProps {
  edges: CitationEdge[];
}

const RELATIONSHIP_VERB: Record<CitationEdge["relationship"], string> = {
  follows: "follows",
  distinguishes: "distinguishes",
  overrules: "overrules",
  none: "does not address",
};

export function CitationGraph({ edges }: CitationGraphProps) {
  if (edges.length === 0) return null;

  return (
    <section className="mt-6">
      <h3 className="text-heading-5 text-ink">Citation relationships</h3>
      <ul className="mt-3 divide-y divide-hairline-soft">
        {edges.map((edge) => (
          <li key={`${edge.from_case}-${edge.to_case}`} className="py-4 first:pt-0">
            <p className="text-body-sm text-ink">
              <span className="font-medium">{edge.from_case}</span>{" "}
              {RELATIONSHIP_VERB[edge.relationship]}{" "}
              <span className="font-medium">{edge.to_case}</span>
            </p>
            <blockquote className="mt-2 max-w-[70ch] rounded-sm border border-hairline bg-surface px-3 py-2 font-mono text-code-sm text-charcoal">
              &ldquo;{edge.supporting_quote}&rdquo;
            </blockquote>
            <p className="mt-1 text-caption text-steel">AI-extracted — verify independently</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
