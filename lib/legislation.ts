import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { parquetReadObjects } from "hyparquet";
import { compressors } from "hyparquet-compressors";

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

function normalizeSection(section: string): string {
  return section.trim().toLowerCase().replace(/^section\s+/, "").replace(/[.\s]/g, "");
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

  const targetSection = normalizeSection(section);
  // "Information Technology Act" should match "The Information Technology
  // Act, 2000", so compare on an alphanumeric-only reduction and allow the
  // stored title to merely contain the query. Indian Acts also vary on
  // hyphenation ("Income-tax" vs "Income Tax"), which this collapses too.
  const targetAct = normalizeActName(actName.split(",")[0]);

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
  return {
    text: chunks.map((c) => c.text!).join("\n\n"),
    title: first.title ?? actName,
    sectionNumber: first.section_number ?? section,
    sourceUrl: first.source_url!,
    enactmentYear: typeof first.year === "number" ? first.year : null,
  };
}
