// Structured statutory text from the vaquill/open-india-law dataset (Hugging
// Face, CC BY 4.0), used as the preferred source for verbatim section text --
// official-government-sourced, with explicit in_force/act_status fields,
// rather than heuristically guessing at a bare-text document from general
// judgment retrieval. It's a point-in-time snapshot (dataset's own README:
// "not current law"), so every render of this data must show that snapshot
// caveat and a link back to the authoritative source.
//
// Uses the HF Datasets Server /filter endpoint (SQL-like WHERE), not
// /search: live testing during this build found /search hangs indefinitely
// for this dataset, while /filter works -- but only once HF has built an
// index for that exact query shape, which for a first-time shape can itself
// take minutes ("the dataset index is loading"). In practice this means a
// genuinely new lookup will usually time out here and fall through to the
// Indian Kanoon fallback (lib/retrieval.ts's retrieveStatutoryTextFallback)
// rather than winning the race -- confirmed live: Section 66A (struck down,
// so plausibly omitted from the "current law" snapshot's live text entirely)
// never resolved through several minutes of testing. That's an accepted,
// working degradation, not a bug: this function fails closed to null on
// any timeout, error, or no-match, exactly like every other optional
// grounding source in this app.
//
// Central Acts only for now (matches this project's well-litigated-Act
// scope) -- central Act rows have an empty "state" field (state is only
// populated for state-level legislation), confirmed from real query
// results during this build.

const DATASETS_SERVER_BASE = "https://datasets-server.huggingface.co";
const FETCH_TIMEOUT_MS = 20000;
const DATASET_ID = "vaquill/open-india-law";
export const VAQUILL_SNAPSHOT_LABEL = "vaquill/open-india-law, snapshot v2026.08";

export interface StatutoryTextResult {
  text: string;
  actStatus: string | null;
  sourceUrl: string;
  enactmentYear: number | null;
  amendmentCount: number | null;
}

interface VaquillLegislationRow {
  act_id?: string;
  title?: string;
  section_number?: string;
  text?: string;
  act_status?: string;
  in_force?: boolean;
  state?: string;
  year?: number;
  amendment_count?: number;
  source_url?: string;
}

async function fetchWithTimeout(url: string, headers: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSection(section: string): string {
  return section.trim().toLowerCase().replace(/^section\s+/, "").replace(/[.\s]/g, "");
}

function sqlStringLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export async function fetchStatutoryText(
  actName: string,
  section: string,
): Promise<StatutoryTextResult | null> {
  const token = process.env.HF_TOKEN;
  if (!token) return null;

  try {
    const shortActName = actName.split(",")[0].trim();
    const where = `"title" LIKE ${sqlStringLiteral(`%${shortActName}%`)} AND "section_number"=${sqlStringLiteral(section.trim())}`;
    const params = new URLSearchParams({
      dataset: DATASET_ID,
      config: "legislation",
      split: "train",
      where,
      length: "20",
    });
    const url = `${DATASETS_SERVER_BASE}/filter?${params.toString()}`;
    const res = await fetchWithTimeout(url, { Authorization: `Bearer ${token}` });
    if (!res.ok) return null;

    const json = await res.json();
    const rows: VaquillLegislationRow[] = Array.isArray(json?.rows)
      ? json.rows.map((r: { row?: VaquillLegislationRow }) => r.row ?? {})
      : [];
    if (rows.length === 0) return null;

    const targetSection = normalizeSection(section);
    const centralRows = rows.filter(
      (row) =>
        !row.state && normalizeSection(row.section_number ?? "") === targetSection && !!row.text,
    );
    const match = centralRows[0] ?? rows.find((row) => !!row.text);
    if (!match || !match.text || !match.source_url) return null;

    return {
      text: match.text,
      actStatus: match.act_status ?? (match.in_force === false ? "not_in_force" : null),
      sourceUrl: match.source_url,
      enactmentYear: typeof match.year === "number" ? match.year : null,
      amendmentCount: typeof match.amendment_count === "number" ? match.amendment_count : null,
    };
  } catch (err) {
    console.error("[vaquill] statutory text lookup failed:", err);
    return null;
  }
}
