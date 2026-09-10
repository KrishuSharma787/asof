// Structured statutory text from the vaquill/open-india-law dataset (Hugging
// Face, CC BY 4.0), used as the preferred source for verbatim section text --
// official-government-sourced, with explicit in_force/repealed/spent status
// fields, rather than heuristically guessing at a bare-text document from
// general judgment retrieval. It's a point-in-time snapshot (dataset's own
// README: "not current law"), so every render of this data must show that
// snapshot caveat and a link back to the authoritative source.
//
// Central Acts only for now (matches this project's well-litigated-Act
// scope) -- the "legislation" config spans every state, filtered client-side
// to state === "central" below.

const DATASETS_SERVER_BASE = "https://datasets-server.huggingface.co";
const FETCH_TIMEOUT_MS = 15000;
const DATASET_ID = "vaquill/open-india-law";
export const VAQUILL_SNAPSHOT_LABEL = "vaquill/open-india-law, snapshot v2026.08";

export interface StatutoryTextResult {
  text: string;
  actStatus: string | null;
  sectionStatus: string | null;
  sourceUrl: string;
  enactmentYear: number | null;
  amendmentCount: number | null;
}

interface VaquillLegislationRow {
  act_id?: string;
  title?: string;
  section_number?: string;
  section_title?: string;
  text?: string;
  act_status?: string;
  section_status?: string;
  state?: string;
  year?: number;
  amendment_count?: number;
  source_url?: string;
}

async function fetchWithTimeout(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const token = process.env.HF_TOKEN;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function normalizeSection(section: string): string {
  return section.trim().toLowerCase().replace(/^section\s+/, "").replace(/[.\s]/g, "");
}

export async function fetchStatutoryText(
  actName: string,
  section: string,
): Promise<StatutoryTextResult | null> {
  const token = process.env.HF_TOKEN;
  if (!token) return null;

  try {
    const query = `${actName} ${section}`;
    const url = `${DATASETS_SERVER_BASE}/search?dataset=${encodeURIComponent(DATASET_ID)}&config=legislation&split=train&query=${encodeURIComponent(query)}&length=50`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;

    const json = await res.json();
    const rows: VaquillLegislationRow[] = Array.isArray(json?.rows)
      ? json.rows.map((r: { row?: VaquillLegislationRow }) => r.row ?? {})
      : [];
    if (rows.length === 0) return null;

    const targetSection = normalizeSection(section);
    const targetAct = actName.trim().toLowerCase();

    const match = rows.find((row) => {
      const isCentral = (row.state ?? "").toLowerCase() === "central";
      const sectionMatches = normalizeSection(row.section_number ?? "") === targetSection;
      const titleMatches = (row.title ?? "").toLowerCase().includes(
        targetAct.split(",")[0].trim(),
      );
      return isCentral && sectionMatches && titleMatches && !!row.text;
    });
    if (!match || !match.text || !match.source_url) return null;

    return {
      text: match.text,
      actStatus: match.act_status ?? null,
      sectionStatus: match.section_status ?? null,
      sourceUrl: match.source_url,
      enactmentYear: typeof match.year === "number" ? match.year : null,
      amendmentCount: typeof match.amendment_count === "number" ? match.amendment_count : null,
    };
  } catch (err) {
    console.error("[vaquill] statutory text lookup failed:", err);
    return null;
  }
}
