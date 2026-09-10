import { tavily } from "@tavily/core";

// Raised from an original 10: live testing found Indian Kanoon reports
// hundreds of matches for well-litigated sections (674 for Section 66A of
// the IT Act) and its default relevance ranking doesn't reliably surface the
// single most important judgment -- Shreya Singhal v. Union of India, the
// case that struck the section down, never appeared in the first 20 general
// results. Fixed by merging in a doctypes:supremecourt-biased search (see
// searchIndianKanoon) rather than raising this alone, but the higher cap
// also meaningfully broadens general coverage.
export const MAX_JUDGMENTS = 18;

export const TRUSTED_DOMAINS = [
  "indiankanoon.org",
  "prsindia.org",
  "indiacode.nic.in",
  "livelaw.in",
  "barandbench.com",
  "main.sci.gov.in",
];

export interface RetrievedJudgment {
  title: string;
  court: string;
  url: string;
  text: string;
  source: "indiankanoon" | "tavily";
}

const FETCH_TIMEOUT_MS = 15000;

function sanitizeInput(input: string): string {
  return input.replace(/[\r\n\t]/g, " ").trim().slice(0, 200);
}

function buildQuery(actName: string, section: string | null): string {
  return section ? `"${actName}" ${section}` : `"${actName}"`;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const codePoint = entity[1] === "x" || entity[1] === "X"
        ? parseInt(entity.slice(2), 16)
        : parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

function stripHtml(html: string): string {
  return decodeHtmlEntities(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

interface IndianKanoonDocSummary {
  tid: number;
  title?: string;
  docsource?: string;
}

async function ikSearch(
  apiKey: string,
  query: string,
): Promise<IndianKanoonDocSummary[]> {
  const searchUrl = `https://api.indiankanoon.org/search/?formInput=${encodeURIComponent(query)}&pagenum=0`;
  const searchRes = await fetchWithTimeout(searchUrl, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}` },
  });
  if (!searchRes.ok) {
    throw new Error(`Indian Kanoon search failed: ${searchRes.status} ${searchRes.statusText}`);
  }
  const searchJson = await searchRes.json();
  return Array.isArray(searchJson?.docs) ? searchJson.docs : [];
}

async function searchIndianKanoon(
  actName: string,
  section: string | null,
): Promise<RetrievedJudgment[]> {
  const apiKey = process.env.INDIANKANOON_API_KEY;
  if (!apiKey) throw new Error("INDIANKANOON_API_KEY not set");

  const query = buildQuery(actName, section);

  // Indian Kanoon's default relevance ranking doesn't reliably surface the
  // single most authoritative judgment on a provision (confirmed live:
  // Shreya Singhal v. Union of India, the case that struck down Section 66A,
  // never appeared in the general query's results at all). A second search
  // scoped to doctypes:supremecourt (an IK query-string operator, not a URL
  // param) fills that gap; results are merged ahead of the general list so
  // top-court precedent is never squeezed out by cap slicing.
  const [generalDocs, supremeCourtDocs] = await Promise.all([
    ikSearch(apiKey, query),
    ikSearch(apiKey, `${query} doctypes:supremecourt`).catch(() => []),
  ]);

  const seenTids = new Set<number>();
  const mergedDocs: IndianKanoonDocSummary[] = [];
  for (const doc of [...supremeCourtDocs, ...generalDocs]) {
    if (seenTids.has(doc.tid)) continue;
    seenTids.add(doc.tid);
    mergedDocs.push(doc);
  }
  const topDocs = mergedDocs.slice(0, MAX_JUDGMENTS);

  const fullDocs = await Promise.all(
    topDocs.map(async (doc): Promise<RetrievedJudgment | null> => {
      try {
        const docUrl = `https://api.indiankanoon.org/doc/${doc.tid}/`;
        const docRes = await fetchWithTimeout(docUrl, {
          method: "POST",
          headers: { Authorization: `Token ${apiKey}` },
        });
        if (!docRes.ok) return null;
        const docJson = await docRes.json();
        const rawText: string = typeof docJson?.doc === "string" ? docJson.doc : "";
        const text = stripHtml(rawText);
        if (!text) return null;
        return {
          title: docJson?.title ?? doc.title ?? "Untitled judgment",
          court: docJson?.docsource ?? doc.docsource ?? "Unknown court",
          url: `https://indiankanoon.org/doc/${doc.tid}/`,
          text,
          source: "indiankanoon",
        };
      } catch {
        return null;
      }
    }),
  );

  return fullDocs.filter((d): d is RetrievedJudgment => d !== null);
}

async function tavilySearch(
  queryOrQueries: string | string[],
  domains: string[],
  cap: number,
): Promise<RetrievedJudgment[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  const client = tavily({ apiKey });
  const queries = Array.isArray(queryOrQueries) ? queryOrQueries : [queryOrQueries];
  const responses = await Promise.all(
    queries.map((query) =>
      client.search(query, {
        searchDepth: "advanced",
        maxResults: cap,
        includeDomains: domains,
        includeDomainsMode: "filter",
        includeRawContent: "text",
      }),
    ),
  );
  const allResults = responses.flatMap((r) => r.results);

  // Belt-and-suspenders: enforce the trusted-domain scope in code even though
  // includeDomainsMode: "filter" already asks Tavily to do it server-side.
  const scoped = allResults.filter((r) =>
    domains.some((domain) => safeHostname(r.url).endsWith(domain)),
  );

  // Some sites (e.g. PRS India's blog pager) return the same article under many
  // query-string variants (?page=2&per-page=1) — dedupe by origin+pathname so
  // the cap isn't spent on repeats of one page.
  const seenCanonicalUrls = new Set<string>();
  const deduped = scoped.filter((r) => {
    if (seenCanonicalUrls.has(canonicalUrl(r.url))) return false;
    seenCanonicalUrls.add(canonicalUrl(r.url));
    return true;
  });

  return deduped.slice(0, cap).map((r) => ({
    title: r.title,
    court: safeHostname(r.url),
    url: r.url,
    text: r.rawContent && r.rawContent.length > 0 ? r.rawContent : r.content,
    source: "tavily" as const,
  }));
}

async function searchTavilyFallback(
  actName: string,
  section: string | null,
): Promise<RetrievedJudgment[]> {
  const query = section
    ? `${actName} Section ${section} judicial interpretation`
    : `${actName} judicial interpretation`;
  return tavilySearch(query, TRUSTED_DOMAINS, MAX_JUDGMENTS);
}

// Some feeds double-encode their query string into the path (e.g.
// "...2000%3Fpage%3D2%26per-page%3D1"); decode first so the real "?" is
// recognized and stripped, otherwise pagination variants dedupe as distinct.
function canonicalUrl(rawUrl: string): string {
  let decoded = rawUrl;
  try {
    decoded = decodeURIComponent(rawUrl);
  } catch {
    // not decodable — fall through and use the raw string
  }
  try {
    const parsed = new URL(decoded);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return decoded.split("?")[0];
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "Unknown source";
  }
}

// Raised from an original 5 alongside MAX_JUDGMENTS for the same reason:
// live testing found the amendment timeline came back with only a single
// entry (the 2009 insertion of Section 66A) when the Act's real history
// includes its 2000 enactment and other amendments -- a thin source pool,
// not a synthesis failure.
export const AMENDMENT_SOURCE_CAP = 8;

const AMENDMENT_TRUSTED_DOMAINS = [
  "indiacode.nic.in",
  "prsindia.org",
  "legislative.gov.in",
  "indiankanoon.org",
];

export async function retrieveAmendmentHistory(
  rawActName: string,
  rawSection: string | null,
): Promise<RetrievedJudgment[]> {
  const actName = sanitizeInput(rawActName);
  const section = rawSection ? sanitizeInput(rawSection) : null;

  // Two queries, merged: a section-specific one (finds section-level
  // commentary, e.g. PRS India background pieces) and an Act-level one
  // (finds India Code's own Act/amendment pages) -- confirmed live that
  // the section-specific query alone misses India Code's official
  // "<Act> Amendment" page entirely, since it's the Act-level query that
  // surfaces it.
  const queries = [
    section
      ? `${actName} Section ${section} enactment amendment history`
      : `${actName} enactment amendment history legislative`,
    `${actName} amendment history India Code`,
  ];

  try {
    return await tavilySearch(queries, AMENDMENT_TRUSTED_DOMAINS, AMENDMENT_SOURCE_CAP);
  } catch (err) {
    console.error("[retrieval] amendment-history search failed:", err);
    return [];
  }
}

export interface StatutoryTextResult {
  text: string;
  court: string;
  url: string;
}

// Heuristic fallback used only when lib/vaquill.ts can't resolve the section
// (no token, no match, etc.): Indian Kanoon's phrase search on `"<act>" <section>`
// reliably surfaces the bare section-text document (title pattern
// "Section X in The Y Act, YYYY") as a top hit — confirmed empirically during
// this build. One targeted search + one doc fetch, not part of the
// MAX_JUDGMENTS-capped general retrieval.
export async function retrieveStatutoryTextFallback(
  rawActName: string,
  rawSection: string,
): Promise<StatutoryTextResult | null> {
  const apiKey = process.env.INDIANKANOON_API_KEY;
  if (!apiKey) return null;

  const actName = sanitizeInput(rawActName);
  const section = sanitizeInput(rawSection);

  try {
    const query = `"${actName}" ${section}`;
    const searchUrl = `https://api.indiankanoon.org/search/?formInput=${encodeURIComponent(query)}&pagenum=0`;
    const searchRes = await fetchWithTimeout(searchUrl, {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (!searchRes.ok) return null;
    const searchJson = await searchRes.json();
    const docs: IndianKanoonDocSummary[] = Array.isArray(searchJson?.docs) ? searchJson.docs : [];
    if (docs.length === 0) return null;

    const bareTextDoc =
      docs.find((d) => /^section\s+\S+\s+in\s+/i.test(d.title ?? "")) ?? docs[0];

    const docUrl = `https://api.indiankanoon.org/doc/${bareTextDoc.tid}/`;
    const docRes = await fetchWithTimeout(docUrl, {
      method: "POST",
      headers: { Authorization: `Token ${apiKey}` },
    });
    if (!docRes.ok) return null;
    const docJson = await docRes.json();
    const rawText: string = typeof docJson?.doc === "string" ? docJson.doc : "";
    const text = stripHtml(rawText);
    if (!text) return null;

    return {
      text,
      court: docJson?.docsource ?? bareTextDoc.docsource ?? "Indian Kanoon",
      url: `https://indiankanoon.org/doc/${bareTextDoc.tid}/`,
    };
  } catch (err) {
    console.error("[retrieval] statutory-text fallback failed:", err);
    return null;
  }
}

export async function retrieveJudgments(
  rawActName: string,
  rawSection: string | null,
): Promise<RetrievedJudgment[]> {
  const actName = sanitizeInput(rawActName);
  const section = rawSection ? sanitizeInput(rawSection) : null;

  try {
    const results = await searchIndianKanoon(actName, section);
    if (results.length > 0) return results.slice(0, MAX_JUDGMENTS);
  } catch (err) {
    console.error("[retrieval] Indian Kanoon failed, falling back to Tavily:", err);
  }

  try {
    return (await searchTavilyFallback(actName, section)).slice(0, MAX_JUDGMENTS);
  } catch (err) {
    console.error("[retrieval] Tavily fallback failed:", err);
    return [];
  }
}
