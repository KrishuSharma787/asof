import { NextRequest, NextResponse } from "next/server";
import { retrieveJudgments } from "@/lib/retrieval";
import { synthesizeInterpretation } from "@/lib/gemini";
import { validateInterpretationResult } from "@/lib/validation";
import { extractCitationEdges, type CitationEdge } from "@/lib/groq";
import { buildCacheKey, getCached, setCached } from "@/lib/cache";
import type { InterpretationResult } from "@/types/schema";

// Retrieval + Gemini + up to 45 Groq calls can, in the worst case, run past
// Vercel's default serverless timeout — extend it. Each upstream call still
// has its own bounded timeout (see lib/retrieval.ts, lib/gemini.ts,
// lib/groq.ts), so this is a ceiling, not a substitute for those.
export const maxDuration = 60;

interface CheckRequestBody {
  actName?: unknown;
  section?: unknown;
}

export interface CheckResponseBody extends InterpretationResult {
  citation_edges: CitationEdge[];
  retrieved_source_count: number;
}

function buildEmptyResult(actName: string, section: string | null): InterpretationResult {
  return {
    act_name: actName,
    section,
    status: "in_force",
    current_force_status_explanation:
      "No judgments discussing judicial interpretation of this Act/section were found in the retrieved sources.",
    plain_summary:
      "We could not find any court judgments that reinterpreted this provision. This does not necessarily mean none exist — only that none were found in this search.",
    technical_summary:
      "No significant judicial reinterpretation was found in the retrieved material. This reflects the absence of matching sources in this search, not a confirmed absence of case law.",
    key_judgments: [],
    confidence: "low",
  };
}

export async function POST(req: NextRequest) {
  let body: CheckRequestBody;
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
  const actName = body.actName;
  const section =
    typeof body.section === "string" && body.section.trim().length > 0 ? body.section : null;

  const cacheKey = buildCacheKey(actName, section);
  const cached = getCached<CheckResponseBody>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  let sources;
  try {
    sources = await retrieveJudgments(actName, section);
  } catch (err) {
    console.error("[api/check] retrieval failed unexpectedly:", err);
    return NextResponse.json(
      { error: "Judgment retrieval is temporarily unavailable. Please try again shortly." },
      { status: 502 },
    );
  }

  if (sources.length === 0) {
    const response: CheckResponseBody = {
      ...buildEmptyResult(actName, section),
      citation_edges: [],
      retrieved_source_count: 0,
    };
    setCached(cacheKey, response);
    return NextResponse.json(response);
  }

  let rawSynthesis: unknown;
  try {
    rawSynthesis = await synthesizeInterpretation(actName, section, sources);
  } catch (err) {
    console.error("[api/check] Gemini synthesis failed:", err);
    return NextResponse.json(
      { error: "The interpretation service is temporarily unavailable. Please try again shortly." },
      { status: 502 },
    );
  }

  const { result, droppedJudgments, errors } = validateInterpretationResult(rawSynthesis, sources);
  if (!result) {
    console.error("[api/check] Gemini output failed schema validation:", errors);
    return NextResponse.json(
      { error: "The interpretation service returned an unexpected response. Please try again." },
      { status: 502 },
    );
  }
  if (droppedJudgments.length > 0) {
    console.warn("[api/check] dropped judgments failing quote verification:", droppedJudgments);
  }

  let citationEdges: CitationEdge[] = [];
  try {
    citationEdges = await extractCitationEdges(result.key_judgments, sources);
  } catch (err) {
    console.error("[api/check] Groq citation extraction failed, continuing without it:", err);
  }

  const response: CheckResponseBody = {
    ...result,
    citation_edges: citationEdges,
    retrieved_source_count: sources.length,
  };
  setCached(cacheKey, response);
  return NextResponse.json(response);
}
