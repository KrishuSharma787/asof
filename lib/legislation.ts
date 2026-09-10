import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";
import { actNameWithoutYear } from "./actName";

// Verbatim statutory text from vaquill/open-india-law (CC BY 4.0), read from
// a locally cached copy of the central-legislation parquet rather than
// through Hugging Face's Datasets Server.
//
// Why local: the Datasets Server /filter endpoint builds an index per query
// shape over the whole ~11GB legislation config, which took minutes on a
// cold shape -- unusable inside a request, and it timed out on every real
// lookup during this build. The central-legislation file alone is 25MB and
// parses in ~70ms for all 74,484 rows, so we fetch it once and query in
// memory instead.
//
// Text only -- deliberately NOT status. The snapshot reports
// "The Income-tax Act, 1961" as act_status=in_force months after s.536 of
// the Income Tax Act, 2025 repealed it, and gives it amendment_count=1
// against a real history of 60+ Finance Acts. Force status comes from the
// live statute book instead (see retrieveStatuteBook in lib/retrieval.ts).

const PARQUET_URL =
  "https://huggingface.co/datasets/vaquill/open-india-law/resolve/main/in_central_legislation.parquet";
const CACHE_DIR = process.env.VERCEL ? "/tmp" : path.join(process.cwd(), ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "in_central_legislation.parquet");
const DOWNLOAD_TIMEOUT_MS = 60000;

export { LEGISLATION_SNAPSHOT_LABEL } from "./legislation-meta";

export interface StatutorySection {
  text: string;
  title: string;
  sectionNumber: string;
  sourceUrl: string;
  enactmentYear: number | null;
}

interface LegislationRow {
  act_id?: string;
  chunk_id?: string;
  title?: string;
  section_number?: string;
  text?: string;
  year?: number;
  source_url?: string;
}

let cachedRows: LegislationRow[] | null = null;
let loadInFlight: Promise<LegislationRow[] | null> | null = null;

async function ensureParquetFile(): Promise<string | null> {
  if (existsSync(CACHE_FILE)) return CACHE_FILE;

  const token = process.env.HF_TOKEN;
  if (!token) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(PARQUET_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, Buffer.from(await res.arrayBuffer()));
    return CACHE_FILE;
  } catch (err) {
    console.error("[legislation] snapshot download failed:", err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function loadRows(): Promise<LegislationRow[] | null> {
  if (cachedRows) return cachedRows;
  if (loadInFlight) return loadInFlight;

  loadInFlight = (async () => {
    try {
      const file = await ensureParquetFile();
      if (!file) return null;
      const buf = await readFile(file);
      const arrayBuffer = buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer;
      const rows = (await parquetReadObjects({
        file: arrayBuffer,
        compressors,
        columns: [
          "act_id",
          "chunk_id",
          "title",
          "section_number",
          "text",
          "year",
          "source_url",
        ],
      })) as LegislationRow[];
      cachedRows = rows;
      return rows;
    } catch (err) {
      console.error("[legislation] snapshot parse failed:", err);
      return null;
    } finally {
      loadInFlight = null;
    }
  })();

  return loadInFlight;
}

// India Code text ships wrapped in apparatus that is not part of the law:
// a metadata banner ("Act: ... | India | Central | In Force"), numbered
// footnote markers splicing amended words into the provision ("the
// 2[Assessing Officer]"), and the footnote definitions themselves. The user
// asked for the section "exactly as in the law", and that banner is also the
// stale line the model once cited as proof an Act was in force -- so it is
// stripped before the text is shown, quoted, or matched against.
export function cleanStatutoryText(raw: string, sectionNumber: string): string {
  let text = raw;
  const escapedSection = sectionNumber.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  // The banner runs "Act: <name> | India | Central | In Force" then
  // "Chapter X: <name> | Section N: <the section's own descriptive title>",
  // followed by a blank line before real content starts. This used to stop
  // right after "Section N:", leaving that descriptive title -- sometimes a
  // full sentence -- sitting at the top of the text. Because cleaning runs
  // per chunk, an under-stripped banner repeated once per chunk: confirmed
  // live as the section's own title recurring as clutter through a
  // multi-chunk section (RFCTLARR s.24, 4 chunks, 4 copies of the leftover
  // title interspersed with the actual amendment text). Consuming through
  // the end of the "Section N:" line -- not just the colon -- removes the
  // whole banner, including the earlier "In Force" line it's chained after.
  const header = new RegExp(`^[\\s\\S]*?\\bSection\\s+${escapedSection}\\s*:[^\\n]*\\n+`, "i");
  text = text.replace(header, "");
  // Fall back to cutting at the banner's last pipe if the section label is
  // formatted unusually, so we never leave the "| In Force" line in place.
  if (/\|\s*(In Force|Repealed)\b/i.test(text)) {
    text = text.replace(/^[\s\S]*?\|\s*(?:In Force|Repealed)\b[^\n]*/i, "");
  }

  text = text
    // footnote definitions: "> 3. Subs. by Act 3 of 1989, s. 23, for ... ."
    .replace(/>\s*\d+\.\s*(?:Subs|Ins|Omitted|Added|Substituted|Inserted|Renumbered)\.?\s+by[^\n]*/gi, " ")
    // inline markers that splice amended wording in: "the 2[Assessing Officer]"
    .replace(/\b\d+\s*\*{0,2}\[\*{0,2}/g, "")
    .replace(/\]/g, "")
    .replace(/\*{2,}/g, "")
    // leftover markdown blockquote markers from the PDF-to-text conversion
    .replace(/^\s*>\s?/gm, "")
    // bare code-fence lines: an artifact of the PDF-to-text conversion (the
    // source is legislative text, not code -- these mark a page/column break
    // in the original, not a real fenced block)
    .replace(/^\s*```\s*$/gm, "")
    // markdown heading syntax on genuine structural labels this Act's text
    // carries ("## STATE AMENDMENTS", "## Andhra Pradesh"): keep the label,
    // drop the "#" markers, which our plain-text rendering can't interpret
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*\n\s*/g, "\n\n")
    .trim();

  // India Code states the section heading, then immediately restates it in
  // numbered form ("Income escaping assessment. —If... \n 147. Income
  // escaping assessment. —If..."). Keep the numbered copy, which is the one
  // that continues into the actual provision.
  const numbered = new RegExp(
    `(^|\\n)\\s*${sectionNumber.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}\\s*\\.`,
  );
  const match = numbered.exec(text);
  if (match && match.index > 0) {
    const before = text.slice(0, match.index).replace(/\s+/g, " ").trim();
    const after = text.slice(match.index).replace(/\s+/g, " ").trim();
    if (before.length > 20 && after.includes(before.slice(0, Math.min(before.length, 60)))) {
      text = text.slice(match.index).trimStart();
    }
  }

  return text;
}

export interface ExtractedAmendment {
  year: number;
  event: string;
  supporting_quote: string;
  source_url: string;
  section: string | null;
}

// India Code's footnotes are the authoritative amendment record and they are
// rigidly formatted -- "Subs. by Act 3 of 1989, s. 23, for ... (w.e.f.
// 1-4-1989)". That means they can be parsed exactly rather than handed to a
// model to summarise, which matters three ways: the timeline is complete
// instead of whatever an LLM happened to notice, every entry is verbatim by
// construction so it passes quote-verification automatically, and it costs
// no tokens against a 20-requests/day quota.
const AMENDMENT_PATTERN =
  /\b(Subs|Ins|Omitted|Added|Substituted|Inserted|Renumbered)\.?\s+by\s+(?:the\s+)?(?:Act\s+)?([\w.\s()]{0,40}?\b\d+\s+of\s+(\d{4}))([^.]{0,120}?)(?:\(w\.e\.f\.\s*([\d.\-/]+)\s*\))?[.;]/gi;

const VERB_LABEL: Record<string, string> = {
  subs: "Substituted",
  substituted: "Substituted",
  ins: "Inserted",
  inserted: "Inserted",
  added: "Added",
  omitted: "Omitted",
  renumbered: "Renumbered",
};

function yearFromWef(wef: string | undefined, fallback: number): number {
  if (!wef) return fallback;
  const m = wef.match(/(\d{4})/);
  return m ? Number(m[1]) : fallback;
}

function parseAmendments(
  text: string,
  sourceUrl: string,
  section: string | null,
): ExtractedAmendment[] {
  const out: ExtractedAmendment[] = [];
  for (const m of text.matchAll(AMENDMENT_PATTERN)) {
    const [full, verb, amendingAct, actYear, , wef] = m;
    const enactedYear = Number(actYear);
    if (!Number.isFinite(enactedYear) || enactedYear < 1800 || enactedYear > 2100) continue;
    const label = VERB_LABEL[verb.toLowerCase().replace(".", "")] ?? "Amended";
    out.push({
      // The commencement date is when the change took effect; the amending
      // Act's own year is the fallback when no w.e.f. is stated.
      year: yearFromWef(wef, enactedYear),
      event: `${label} by ${amendingAct.trim().replace(/\s+/g, " ")}`,
      supporting_quote: full.trim(),
      source_url: sourceUrl,
      section,
    });
  }
  return out;
}

// Whole-Act history: every section of the Act is already in memory, so the
// footnotes across all of them add up to the Act's real amendment record.
// This is what makes an Act-level query (no section given) substantive
// instead of returning a single recent bill scraped off a blog.
export async function fetchActAmendments(
  actName: string,
  section: string | null = null,
): Promise<ExtractedAmendment[]> {
  const rows = await loadRows();
  if (!rows) return [];

  const targetAct = normalizeActName(actNameWithoutYear(actName));
  const targetSection = section ? normalizeSection(baseSectionNumber(section)) : null;

  const relevant = rows.filter((row) => {
    if (!row.text || !row.source_url) return false;
    if (!normalizeActName(row.title ?? "").includes(targetAct)) return false;
    if (targetSection && normalizeSection(row.section_number ?? "") !== targetSection) return false;
    return true;
  });
  if (relevant.length === 0) return [];

  const shortestTitle = relevant
    .map((r) => r.title ?? "")
    .sort((a, b) => a.length - b.length)[0];

  const amendments = relevant
    .filter((r) => (r.title ?? "") === shortestTitle)
    .flatMap((r) => parseAmendments(r.text!, r.source_url!, r.section_number ?? null));

  // One amending Act usually touches many sections, each with its own
  // footnote. Collapse to one entry per (year, amending Act) so the timeline
  // reads as legislative events rather than hundreds of near-duplicates.
  const byEvent = new Map<string, ExtractedAmendment>();
  for (const a of amendments) {
    const key = `${a.year}::${a.event}`;
    if (!byEvent.has(key)) byEvent.set(key, a);
  }

  return [...byEvent.values()].sort((a, b) => a.year - b.year);
}

function normalizeSection(section: string): string {
  return section.trim().toLowerCase().replace(/^section\s+/, "").replace(/[.\s]/g, "");
}

// The snapshot stores one row per top-level section, not per sub-section --
// there is no row for "24(2)", only "24", which contains all of 24's
// sub-clauses in its text. Requesting "24(2)" against a snapshot that only
// has "24" previously matched nothing and silently fell through to a much
// worse fallback (see retrieveStatutoryTextFallback in lib/retrieval.ts),
// which had no way to tell a judgment from a statute and returned one as if
// it were the other. Stripping to the base number fixes the lookup; a letter
// glued directly to the number ("66A") is left alone, since that names a
// distinct section, not a sub-clause of the one before it.
function baseSectionNumber(section: string): string {
  const idx = section.indexOf("(");
  return idx === -1 ? section : section.slice(0, idx);
}

function normalizeActName(actName: string): string {
  return actName
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]/g, "");
}

export async function fetchStatutoryText(
  actName: string,
  section: string,
): Promise<StatutorySection | null> {
  const rows = await loadRows();
  if (!rows) return null;

  const targetSection = normalizeSection(baseSectionNumber(section));
  // "Information Technology Act" should match "The Information Technology
  // Act, 2000", so compare on an alphanumeric-only reduction and allow the
  // stored title to merely contain the query. Indian Acts also vary on
  // hyphenation ("Income-tax" vs "Income Tax"), which this collapses too.
  const targetAct = normalizeActName(actNameWithoutYear(actName));

  const matches = rows.filter((row) => {
    if (!row.text || !row.source_url) return false;
    if (normalizeSection(row.section_number ?? "") !== targetSection) return false;
    return normalizeActName(row.title ?? "").includes(targetAct);
  });
  if (matches.length === 0) return null;

  // Prefer the shortest matching title: a query for "Income Tax Act" should
  // land on "The Income-tax Act, 1961", not "The Income Tax (Amendment) Act".
  const bestTitle = matches
    .map((m) => m.title ?? "")
    .sort((a, b) => a.length - b.length)[0];

  // Long sections are stored as several chunks; stitch them back together in
  // chunk_id order. This matters beyond completeness -- India Code's
  // amendment footnotes ("Subs. by Act 3 of 1989, s. 23 ... (w.e.f.
  // 1-4-1989)") are what the amendment timeline is mined from, and they sit
  // at the end of a section, so a single chunk usually misses them.
  const chunks = matches
    .filter((m) => (m.title ?? "") === bestTitle)
    .sort((a, b) => (a.chunk_id ?? "").localeCompare(b.chunk_id ?? "", undefined, { numeric: true }));

  const first = chunks[0];
  const sectionNumber = first.section_number ?? section;

  // Chunks overlap -- a short lead-in chunk is often wholly contained in the
  // next one -- so joining them blindly prints the provision twice.
  // Every chunk of a section repeats the section's opening line as context
  // ("Income escaping assessment. —If the Assessing Officer..."), so joining
  // them verbatim prints that line once per chunk. Strip it everywhere it
  // recurs as a prefix, keeping only the copy that leads the section.
  const cleaned = chunks
    .map((c) => cleanStatutoryText(c.text!, sectionNumber))
    .filter((t) => t.length > 0);

  const repeatedHeader = cleaned[0]?.split("\n")[0]?.trim() ?? "";
  const recurs =
    repeatedHeader.length > 20 &&
    cleaned.filter((c) => c.trimStart().startsWith(repeatedHeader)).length > 1;

  const cleanedChunks = cleaned.map((chunk, i) => {
    if (!recurs || i === 0) return chunk;
    const trimmed = chunk.trimStart();
    return trimmed.startsWith(repeatedHeader)
      ? trimmed.slice(repeatedHeader.length).trimStart()
      : chunk;
  });

  return {
    text: cleanedChunks.join("\n\n"),
    title: first.title ?? actName,
    sectionNumber: first.section_number ?? section,
    sourceUrl: first.source_url!,
    enactmentYear: typeof first.year === "number" ? first.year : null,
  };
}
