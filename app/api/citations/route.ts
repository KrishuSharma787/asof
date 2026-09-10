import { NextRequest, NextResponse } from "next/server";
import { extractCitationEdges, type CitationEdge } from "@/lib/groq";
import { detectConflicts, type ConflictEntry } from "@/lib/conflicts";
import { buildSourcesCacheKey, getCached } from "@/lib/cache";
import type { KeyJudgment } from "@/types/schema";
import type { RetrievedJudgment } from "@/lib/retrieval";

// Split out of /api/check so the citation graph stops holding up the answer.
// Groq's pairwise calls cost 5-15s and are throttled to 2 in flight by its
// 8,000 tokens/minute free tier, which pushed a full lookup past the 60s
// serverless ceiling. The graph is also the most expendable output: status,
// statutory text, judgments and the timeline are all useful without it.
export const maxDuration = 60;

export interface CitationsResponseBody {
  citation_edges: CitationEdge[];
  conflicts: ConflictEntry[];
}

interface CachedSources {
  sources: RetrievedJudgment[];
  judgments: KeyJudgment[];
}

export async function POST(req: NextRequest) {
  let body: { actName?: unknown; section?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (typeof body.actName !== "string" || body.actName.trim().length === 0) {
    return NextResponse.json(
      { error: "actName is required and must be a non-empty string." },
      { status: 400 },
    );
  }
  const section =
    typeof body.section === "string" && body.section.trim().length > 0 ? body.section : null;

  const cached = getCached<CachedSources>(buildSourcesCacheKey(body.actName, section));
  // Nothing cached means /api/check was never run for this query, or its entry
  // expired. An empty graph is the honest answer -- recomputing retrieval here
  // would duplicate the expensive half of the pipeline.
  if (!cached || cached.judgments.length < 2) {
    return NextResponse.json({ citation_edges: [], conflicts: [] } satisfies CitationsResponseBody);
  }

  let citationEdges: CitationEdge[] = [];
  try {
    citationEdges = await extractCitationEdges(cached.judgments, cached.sources);
  } catch (err) {
    console.error("[api/citations] Groq citation extraction failed:", err);
  }

  return NextResponse.json({
    citation_edges: citationEdges,
    conflicts: detectConflicts(cached.judgments, citationEdges),
  } satisfies CitationsResponseBody);
}
