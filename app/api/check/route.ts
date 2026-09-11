import { NextRequest, NextResponse } from "next/server";
import {
  retrieveJudgments,
  retrieveAmendmentHistory,
  retrieveStatutoryTextFallback,
  retrieveStatuteBook,
  type RetrievedJudgment,
} from "@/lib/retrieval";
import { fetchStatutoryText, fetchActAmendments, resolveActName } from "@/lib/legislation";
import { synthesizeInterpretation, GeminiError } from "@/lib/gemini";
import { validateInterpretationResult } from "@/lib/validation";
import type { CitationEdge } from "@/lib/groq";
import type { ConflictEntry } from "@/lib/conflicts";
import { buildCacheKey, buildSourcesCacheKey, getCached, setCached } from "@/lib/cache";
import type { InterpretationResult } from "@/types/schema";

// Retrieval + 1 Gemini call (with 1 retry) + up to 45 Groq calls can, in the
// worst case, run past Vercel's default serverless timeout — extend it.
// Each upstream call still has its own bounded timeout (see lib/retrieval.ts,
// lib/gemini.ts, lib/groq.ts, lib/legislation.ts), so this is a ceiling, not a
// substitute for those.
export const maxDuration = 60;

// Bump whenever CheckResponseBody's shape OR the synthesis rules that produce
// it change, so a stale entry from before the change is never served. Cached
// answers are as version-bound as the schema: a prompt fix that corrects a
// wrong status is worthless if yesterday's wrong answer is still served.
const RESPONSE_SCHEMA_VERSION = "23";

interface CheckRequestBody {
  actName?: unknown;
  section?: unknown;
}

export interface CheckResponseBody extends InterpretationResult {
  citation_edges: CitationEdge[];
  conflicts: ConflictEntry[];
  retrieved_source_count: number;
  statutory_text: string | null;
  statutory_text_source: "india_code" | "indiankanoon" | null;
  statutory_text_source_url: string | null;
  last_amendment_year: number | null;
}

function buildEmptyResult(actName: string, section: string | null): InterpretationResult {
  return {
    act_name: actName,
    section,
    // Not "in_force": with nothing retrieved we have not established anything
    // about this Act's status, and saying "in force" here is what produced a
    // confidently wrong answer about a repealed Act.
    status: "unverified",
    status_evidence: null,
    current_force_status_explanation:
      "No judgments, statute-book entries, or amendment history for this Act/section were found in the retrieved sources, so its current force status could not be verified.",
    key_judgments: [],
    highlighted_phrases: [],
    amendment_timeline: [],
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
  const section =
    typeof body.section === "string" && body.section.trim().length > 0 ? body.section : null;

  // Free-text input varies from the dataset's own titles in ways that break
  // Indian Kanoon's exact-phrase judgment search but not the parquet lookup
  // (see resolveActName's own comment) -- resolving once here means every
  // downstream retrieval call, and the cache key, work from the same
  // precise name instead of whatever the user typed. A no-op for anything
  // outside the Vaquill snapshot's coverage.
  const actName = await resolveActName(body.actName);

  const cacheKey = `${buildCacheKey(actName, section)}::v${RESPONSE_SCHEMA_VERSION}`;
  const cached = getCached<CheckResponseBody>(cacheKey);
  if (cached) {
    return NextResponse.json(cached);
  }

  const [sources, amendmentSources, statuteBookSources, indiaCodeSection, statuteAmendments] =
    await Promise.all([
    retrieveJudgments(actName, section).catch((err): RetrievedJudgment[] => {
      console.error("[api/check] retrieval failed unexpectedly:", err);
      return [];
    }),
    retrieveAmendmentHistory(actName, section),
    retrieveStatuteBook(actName),
    section ? fetchStatutoryText(actName, section) : Promise.resolve(null),
    // Parsed straight out of India Code's footnotes: complete, verbatim by
    // construction, and free. Only when an Act isn't in the snapshot do we
    // fall back to asking the model to reconstruct a timeline from web
    // commentary, which is what produced "one 2026 bill" for an Act amended
    // every year since 1961.
    fetchActAmendments(actName, section),
  ]);

  let statutoryText: string | null = null;
  let statutoryTextSource: "india_code" | "indiankanoon" | null = null;
  let statutoryTextSourceUrl: string | null = null;

  if (section) {
    if (indiaCodeSection) {
      statutoryText = indiaCodeSection.text;
      statutoryTextSource = "india_code";
      statutoryTextSourceUrl = indiaCodeSection.sourceUrl;
    } else {
      const fallback = await retrieveStatutoryTextFallback(actName, section);
      if (fallback) {
        statutoryText = fallback.text;
        statutoryTextSource = "indiankanoon";
        statutoryTextSourceUrl = fallback.url;
      }
    }
  }

  let interpretationResult: InterpretationResult;
  if (sources.length === 0 && amendmentSources.length === 0 && statuteBookSources.length === 0) {
    interpretationResult = buildEmptyResult(actName, section);
  } else {
    let rawSynthesis: unknown;
    try {
      rawSynthesis = await synthesizeInterpretation(
        actName,
        section,
        sources,
        amendmentSources,
        statuteBookSources,
        statutoryText && statutoryTextSourceUrl
          ? { text: statutoryText, sourceUrl: statutoryTextSourceUrl }
          : null,
      );
    } catch (err) {
      console.error("[api/check] Gemini synthesis failed:", err);
      // Tell the user which wall they hit. "Try again shortly" is actively
      // misleading for a daily quota that resets tomorrow -- they'd sit there
      // retrying a request that cannot succeed.
      if (err instanceof GeminiError && err.kind === "quota") {
        return NextResponse.json(
          {
            error:
              "The daily quota for the AI analysis service has been used up. It resets every 24 hours — or enable billing on the Gemini API key to remove the cap.",
          },
          { status: 429 },
        );
      }
      return NextResponse.json(
        { error: "The interpretation service is temporarily unavailable. Please try again shortly." },
        { status: 502 },
      );
    }

    const {
      result,
      droppedJudgments,
      droppedHighlights,
      droppedTimelineEntries,
      statusDowngraded,
      errors,
    } = validateInterpretationResult(
      rawSynthesis,
      sources,
      amendmentSources,
      statutoryText,
      statuteBookSources,
    );
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
    if (droppedHighlights.length > 0) {
      console.warn("[api/check] dropped highlights failing verbatim verification:", droppedHighlights);
    }
    if (droppedTimelineEntries > 0) {
      console.warn(`[api/check] dropped ${droppedTimelineEntries} timeline entries failing quote verification`);
    }
    if (statusDowngraded) {
      console.warn("[api/check] status downgraded to unverified: evidence quote not found in any retrieved source");
    }
    interpretationResult = result;
  }

  // The parsed statute-book record wins when we have it: it is complete and
  // verbatim, where the model's reconstruction is whatever the web happened
  // to mention. The model's version is kept only as a fallback for Acts
  // missing from the India Code snapshot.
  if (statuteAmendments.length > 0) {
    interpretationResult = {
      ...interpretationResult,
      amendment_timeline: statuteAmendments.map((a) => ({
        year: a.year,
        event: a.event,
        description: a.section ? `Section ${a.section}` : "",
        supporting_quote: a.supporting_quote,
        source_url: a.source_url,
      })),
    };
  }

  const lastAmendmentYear =
    interpretationResult.amendment_timeline.length > 0
      ? Math.max(...interpretationResult.amendment_timeline.map((e) => e.year))
      : null;

  // The citation graph is deliberately absent here and fetched separately by
  // the client from /api/citations. Its Groq calls are throttled to 2 in
  // flight by an 8,000 tokens/minute free tier and cost 5-15s, which pushed
  // this route past the 60s serverless ceiling for the sake of its least
  // essential output. Park the retrieved texts so that request can reuse them.
  setCached(buildSourcesCacheKey(actName, section), {
    sources,
    judgments: interpretationResult.key_judgments,
  });

  const response: CheckResponseBody = {
    ...interpretationResult,
    citation_edges: [],
    conflicts: [],
    retrieved_source_count: sources.length,
    statutory_text: statutoryText,
    statutory_text_source: statutoryTextSource,
    statutory_text_source_url: statutoryTextSourceUrl,
    last_amendment_year: lastAmendmentYear,
  };
  setCached(cacheKey, response);
  return NextResponse.json(response);
}
