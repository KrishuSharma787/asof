import { tavily } from "@tavily/core";

// Raised from an original 10: live testing found Indian Kanoon reports
// hundreds of matches for well-litigated sections (674 for Section 66A of
// the IT Act) and its default relevance ranking doesn't reliably surface the
// single most important judgment -- Shreya Singhal v. Union of India, the
// case that struck the section down, never appeared in the first 20 general
// results. Fixed by merging in a doctypes:supremecourt-biased search (see
// searchIndianKanoon) rather than raising this alone, but the higher cap
// also meaningfully broadens general coverage.
//
// Settled at 8: at 18 the synthesis prompt grew large enough that Gemini
// 504'd on it repeatedly, and even 12 left a full lookup at ~67s, over the
// 60s serverless ceiling. Because results are ranked by citation count and
// Supreme Court hits are merged first, trimming the tail drops the least
// authoritative results, not the landmark ones.
export const MAX_JUDGMENTS = 8;

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
const IK_FETCH_CONCURRENCY = 6;

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await fn(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

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
  // How many later cases cite this one. Indian Kanoon returns it on the
  // search response itself, so ranking by it costs nothing extra.
  numcitedby?: number;
  publishdate?: string;
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
  // doctypes:judgments restricts this to actual decisions. Without it the
  // pool fills with bare statute pages ("Section 148 in The Income Tax Act,
  // 1961"), which the citation ranking below then promotes to the very top --
  // a statutory section is cited by thousands of cases, far more than any
  // single judgment, so an Act-level query came back with eight statute pages
  // and zero judgments.
  const [generalDocs, supremeCourtDocs] = await Promise.all([
    ikSearch(apiKey, `${query} doctypes:judgments`),
    ikSearch(apiKey, `${query} doctypes:supremecourt`).catch(() => []),
  ]);

  const seenTids = new Set<number>();
  const mergedDocs: IndianKanoonDocSummary[] = [];
  for (const doc of [...supremeCourtDocs, ...generalDocs]) {
    if (seenTids.has(doc.tid)) continue;
    seenTids.add(doc.tid);
    mergedDocs.push(doc);
  }

  // Rank by how often each judgment has been cited, not by search relevance.
  // Relevance ranking skews recent -- it was returning 2023-2026 High Court
  // FIR-quashing orders while omitting the cases that actually decided the
  // provision. Citation count is the profession's own measure of which
  // judgments matter, and it naturally favours landmark decisions across the
  // Act's whole life rather than whatever was decided most recently
  // (Surat Art Silk, 1979, carries 2,322 citing cases).
  const topDocs = [...mergedDocs]
    .sort((a, b) => (b.numcitedby ?? 0) - (a.numcitedby ?? 0))
    .slice(0, MAX_JUDGMENTS);

  // Fetched in batches rather than all at once: firing 18 document requests
  // at Indian Kanoon simultaneously started tripping the per-request timeout,
  // and a timeout here fails the whole IK path over to the weaker Tavily
  // fallback, quietly costing us the better sources.
  const fullDocs = await mapWithConcurrency(
    topDocs,
    IK_FETCH_CONCURRENCY,
    async (doc): Promise<RetrievedJudgment | null> => {
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
    },
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

export const STATUTE_BOOK_CAP = 4;

// Force status has to be checked against the statute book, not inferred from
// judgments. Nothing in the judgment corpus tells you an Act was repealed by
// a later Act -- the Income-tax Act, 1961 was reported "in force" here long
// after s.536 of the Income Tax Act, 2025 repealed it, because no retrieved
// judgment happened to mention it.
//
// IK's doctypes:laws searches the bare statute book, and a repealing
// provision states it in quotable terms ("The Income-tax Act, 1961 is hereby
// repealed"), which feeds our verbatim-quote validator directly. Verified
// discriminating: this returns the repealing provision as the top hit for
// the 1961 Act, and only unrelated noise for an Act that is still live.
export async function retrieveStatuteBook(
  rawActName: string,
): Promise<RetrievedJudgment[]> {
  const apiKey = process.env.INDIANKANOON_API_KEY;
  if (!apiKey) return [];

  const actName = sanitizeInput(rawActName);

  try {
    const docs = await ikSearch(apiKey, `"${actName}" "hereby repealed" doctypes:laws`);
    const topDocs = docs.slice(0, STATUTE_BOOK_CAP);

    const fetched = await Promise.all(
      topDocs.map(async (doc): Promise<RetrievedJudgment | null> => {
        try {
          const docRes = await fetchWithTimeout(`https://api.indiankanoon.org/doc/${doc.tid}/`, {
            method: "POST",
            headers: { Authorization: `Token ${apiKey}` },
          });
          if (!docRes.ok) return null;
          const docJson = await docRes.json();
          const text = stripHtml(typeof docJson?.doc === "string" ? docJson.doc : "");
          if (!text) return null;
          return {
            title: docJson?.title ?? doc.title ?? "Untitled provision",
            court: docJson?.docsource ?? doc.docsource ?? "Statute book",
            url: `https://indiankanoon.org/doc/${doc.tid}/`,
            text,
            source: "indiankanoon",
          };
        } catch {
          return null;
        }
      }),
    );

    return fetched.filter((d): d is RetrievedJudgment => d !== null);
  } catch (err) {
    console.error("[retrieval] statute-book check failed:", err);
    return [];
  }
}

export interface StatutoryTextResult {
  text: string;
  court: string;
  url: string;
}

// Heuristic fallback used only when lib/legislation.ts can't resolve the section
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

    // Only accept a result that looks like a bare statutory-text page. This
    // used to fall back to docs[0] unconditionally when nothing matched,
    // which silently handed back a judgment as if it were the statute --
    // confirmed live for a sub-section query ("24(2)") where no bare-text
    // page exists under that exact label: the fallback returned a High
    // Court judgment's full opinion, rendered under the "Statutory text"
    // heading. Returning null and letting the feature not render is the
    // honest outcome; guessing wrong is not.
    const bareTextDoc = docs.find((d) => /^section\s+\S+\s+in\s+/i.test(d.title ?? ""));
    if (!bareTextDoc) return null;

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
