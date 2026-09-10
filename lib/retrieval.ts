import { tavily } from "@tavily/core";

export const MAX_JUDGMENTS = 10;

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

async function searchIndianKanoon(
  actName: string,
  section: string | null,
): Promise<RetrievedJudgment[]> {
  const apiKey = process.env.INDIANKANOON_API_KEY;
  if (!apiKey) throw new Error("INDIANKANOON_API_KEY not set");

  const query = buildQuery(actName, section);
  const searchUrl = `https://api.indiankanoon.org/search/?formInput=${encodeURIComponent(query)}&pagenum=0`;
  const searchRes = await fetchWithTimeout(searchUrl, {
    method: "POST",
    headers: { Authorization: `Token ${apiKey}` },
  });
  if (!searchRes.ok) {
    throw new Error(`Indian Kanoon search failed: ${searchRes.status} ${searchRes.statusText}`);
  }
  const searchJson = await searchRes.json();
  const docs: IndianKanoonDocSummary[] = Array.isArray(searchJson?.docs) ? searchJson.docs : [];
  const topDocs = docs.slice(0, MAX_JUDGMENTS);

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

async function searchTavilyFallback(
  actName: string,
  section: string | null,
): Promise<RetrievedJudgment[]> {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) throw new Error("TAVILY_API_KEY not set");

  const client = tavily({ apiKey });
  const query = section
    ? `${actName} Section ${section} judicial interpretation`
    : `${actName} judicial interpretation`;

  const response = await client.search(query, {
    searchDepth: "advanced",
    maxResults: MAX_JUDGMENTS,
    includeDomains: TRUSTED_DOMAINS,
    includeDomainsMode: "filter",
    includeRawContent: "text",
  });

  // Belt-and-suspenders: enforce the trusted-domain scope in code even though
  // includeDomainsMode: "filter" already asks Tavily to do it server-side.
  const scoped = response.results.filter((r) =>
    TRUSTED_DOMAINS.some((domain) => safeHostname(r.url).endsWith(domain)),
  );

  // Some sites (e.g. PRS India's blog pager) return the same article under many
  // query-string variants (?page=2&per-page=1) — dedupe by origin+pathname so
  // the MAX_JUDGMENTS cap isn't spent on repeats of one page.
  const seenCanonicalUrls = new Set<string>();
  const deduped = scoped.filter((r) => {
    if (seenCanonicalUrls.has(canonicalUrl(r.url))) return false;
    seenCanonicalUrls.add(canonicalUrl(r.url));
    return true;
  });

  return deduped.slice(0, MAX_JUDGMENTS).map((r) => ({
    title: r.title,
    court: safeHostname(r.url),
    url: r.url,
    text: r.rawContent && r.rawContent.length > 0 ? r.rawContent : r.content,
    source: "tavily" as const,
  }));
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
