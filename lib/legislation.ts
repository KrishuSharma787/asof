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

export interface LegislationRow {
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

// Exposed for scripts/verify-statutory-formatting.mts, which runs
// cleanStatutoryText across every row in the snapshot -- a fix verified
// against one hand-picked Act/section can still be wrong for the other
// 74,000+ rows, which is exactly how repeated formatting bugs kept slipping
// through on this feature.
export async function getAllLegislationRows(): Promise<LegislationRow[] | null> {
  return loadRows();
}

// Free-text input varies from the dataset's own titles in ways
// actNameTokens/actNameMatches already tolerate for the amendment/statutory-
// text lookups (word order, stopwords, hyphenation) -- but that tolerance
// only ever fed a boolean "is this a match" check, never fed BACK into what
// gets searched elsewhere. An extra informal word ("Indian Penal Code ACT,
// 1860" -- IPC is a Code, not an Act, a common colloquial slip) or a
// dropped "The" doesn't break the parquet lookup (word-set matching
// tolerates it), but it does break Indian Kanoon's exact-phrase judgment
// search (see buildQuery in lib/retrieval.ts), which has no such tolerance.
// Resolving to the dataset's own title once, up front, means every
// downstream retrieval call -- not just the one that's specifically
// broken -- works from the same precise, correctly-worded name instead of
// whatever the user typed. A no-op (returns the input unchanged) whenever
// nothing in the snapshot matches -- most commonly a state Act, or any Act
// genuinely outside the snapshot's coverage -- so this never blocks or
// worsens a query that worked before.
// The dataset's own titles carry citation/repeal bookkeeping no one actually
// says out loud: a repealed Act's title runs "<Title>, <N> of <year> (Rep.,
// Act <N> of <year>)" (e.g. "The Indian Penal Code, 45 of 1860 (Rep., Act 45
// of 2023)"), where "<N> of <year>" is India's standard Act-citation format,
// not part of the name. Confirmed live: resolving IPC without this cleanup
// would hand buildQuery that entire string to quote -- worse than the raw
// input, since that exact phrase (repeal annotation included) appears
// nowhere in any judgment. Stripping it here, once, is what turns the
// resolved name into "The Indian Penal Code" -- the specific query already
// confirmed (see buildQuery's own comment) to surface the real landmark
// judgments. A currently-in-force Act's title carries no such suffix and is
// returned unchanged.
function cleanDatasetTitle(title: string): string {
  return title
    .replace(/,?\s*\(Rep\.?,?\s*Act\s+\d+\s+of\s+\d{4}\s*\)/gi, "")
    .replace(/,?\s*\d+\s+of\s+\d{4}\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/,\s*$/, "");
}

// A generic query can match several genuinely DIFFERENT Acts that merely
// share a couple of common words, not just a base Act and its own
// amendment Acts. Confirmed live: "evidence act" (tokens {evidence, act})
// matches 9 titles spanning multiple unrelated, historically separate
// Acts -- and by raw title length, the SHORTEST was "The Bankers Books
// Evidence Act, 1891" (a narrow, specialized Act), beating "The Indian
// Evidence Act, 1872" (the actual general law of evidence, and what
// "evidence act" obviously means) purely because the real Act's title
// carries a longer citation/repeal-annotation suffix. That's not a missed
// enhancement, it's an actively wrong answer.
//
// Section count on record is a far more reliable signal of "which of
// these candidates is the real, major Act": confirmed live, "The Indian
// Evidence Act, 1872" has 175 distinct sections in the snapshot; every
// other "evidence act" candidate has 23 or fewer, most in single digits.
// A comprehensive, significant Act genuinely has far more provisions on
// record than an obscure historical predecessor or a narrow specialized
// Act that happens to share words in its title. This still correctly
// separates a base Act from its own same-named amendment Acts too (the
// original purpose of this tie-break): a base Act's section count
// dwarfs a short amendment Act's by the same logic, without needing the
// length-based fallback to do that work. Title length remains only as
// the tiebreaker for the rare case of an exact section-count tie.
function pickMostComprehensiveTitle(rows: LegislationRow[]): string {
  const sectionsByTitle = new Map<string, Set<string>>();
  for (const row of rows) {
    const title = row.title ?? "";
    if (!sectionsByTitle.has(title)) sectionsByTitle.set(title, new Set());
    sectionsByTitle.get(title)!.add(row.section_number ?? "");
  }

  const titles = [...sectionsByTitle.keys()];
  titles.sort((a, b) => {
    const bySectionCount = sectionsByTitle.get(b)!.size - sectionsByTitle.get(a)!.size;
    return bySectionCount !== 0 ? bySectionCount : a.length - b.length;
  });
  return titles[0];
}

export async function resolveActName(rawActName: string): Promise<string> {
  const rows = await loadRows();
  if (!rows) return rawActName;

  const queryTokens = actNameTokens(actNameWithoutYear(rawActName));
  if (queryTokens.size === 0) return rawActName;

  const matchingRows = rows.filter((row) => row.title && actNameMatches(row.title, queryTokens));
  if (matchingRows.length === 0) return rawActName;

  return cleanDatasetTitle(pickMostComprehensiveTitle(matchingRows));
}

// Square brackets carry at least three different meanings in this corpus,
// and the PDF-to-text conversion doesn't mark which is which:
//   1. an inline splice with its footnote digit still attached -- "the
//      2[Assessing Officer]" -- wrapping the CURRENT (post-amendment)
//      wording, digit pointing at a footnote definition already stripped
//      elsewhere.
//   2. a genuine citation note that isn't a splice at all -- "[Vide Andhra
//      Pradesh Act 22 of 2018, sec. 5 (w.e.f. 1-1-2014)]", "[See section
//      57]" -- meant to stay bracketed exactly as written.
// A splice can itself contain further splices -- an entire inserted
// sub-section wrapped in one outer digit-bracket, with its own nested
// footnote markers inside ("1[(4A) Where... 5[(b) to any other
// establishment...]...]") -- so pairing brackets with a plain (non-nesting)
// regex only ever finds the FIRST inner "]" and gives up, leaving the outer
// "[" -- and every citation bracket downstream of it -- dangling. Confirmed
// live across the snapshot: Income-tax Act s.7's "1[ 80-IE. Special
// provisions..." and RFCTLARR's state-amendment "[ Vide Andhra Pradesh
// Act..." were both left broken by a regex-only pairing attempt, for
// opposite reasons. A single left-to-right scan tracking bracket depth on a
// stack handles both, however deep either nests: a splice's digit and
// brackets are dropped, keeping its wording; a citation's brackets are kept.
// `\b` treats "_" as a word character, so it isn't a boundary between "Vide"
// and a trailing italics underscore -- "[ _Vide_ Andhra Pradesh Act..." was
// confirmed live to fail this check and get unwrapped as if it were a
// splice, because "\bvide\b" doesn't match "vide" immediately followed by
// "_". A negative lookahead for a following letter has the same effect
// without that gap: it rejects "videophone" but accepts "vide" followed by
// "_", punctuation, whitespace, or end of string.
const CITATION_BRACKET = /^\s*_*\s*(?:vide|see)(?![a-zA-Z])/i;
function unwrapBrackets(input: string): string {
  let out = "";
  const stack: Array<"splice" | "citation"> = [];

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (ch === "[") {
      const digitPrefix = /(\d+)(\*{0,2})$/.exec(out);
      if (digitPrefix) {
        out = out.slice(0, out.length - digitPrefix[0].length);
        stack.push("splice");
      } else if (CITATION_BRACKET.test(input.slice(i + 1, i + 20))) {
        stack.push("citation");
        out += ch;
      } else {
        stack.push("splice");
      }
      continue;
    }

    if (ch === "]") {
      const kind = stack.pop();
      if (kind === "citation") out += ch;
      else if (kind === "splice") out = out.replace(/\*{0,2}$/, "");
      else out += ch; // an unmatched "]" already in the source -- leave as-is
      continue;
    }

    out += ch;
  }

  return out;
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
  // The declared section number can also be a bare top-level number
  // ("117") while the chunk itself actually opens mid-section at a
  // sub-clause ("Section 117(2):") -- a chunk boundary can fall there just
  // as easily as at the top of the section -- so a short optional suffix
  // after the number is allowed rather than requiring an exact match.
  const header = new RegExp(`^[\\s\\S]*?\\bSection\\s+${escapedSection}[\\w()]*\\s*:[^\\n]*\\n+`, "i");
  text = text.replace(header, "");
  // Fall back to cutting at the banner's last pipe if the section label is
  // formatted unusually, so we never leave the "| In Force" line in place.
  if (/\|\s*(In Force|Repealed)\b/i.test(text)) {
    text = text.replace(/^[\s\S]*?\|\s*(?:In Force|Repealed)\b[^\n]*/i, "");
  }

  text = text
    // footnote definitions: "> 3. Subs. by Act 3 of 1989, s. 23, for ... ."
    .replace(/>\s*\d+\.\s*(?:Subs|Ins|Omitted|Added|Substituted|Inserted|Renumbered)\.?\s+by[^\n]*/gi, " ")
    // an OCR placeholder for a scanned image/diagram the conversion couldn't
    // render -- not part of the statutory text, e.g. "==> picture [345 x
    // 550] intentionally omitted <=="
    .replace(/\*{0,2}==>\s*picture\s*\[[^\]\n]*\]\s*intentionally omitted\s*<==\*{0,2}/gi, "")
    // a bare footnote-reference marker with no wording attached (a
    // conversion glitch detaches the digit from its wording bracket: "the[3]
    // [Assessing Officer]"), or a standalone "[N]": the definition it points
    // to is already stripped above, so the reference itself is now inert
    .replace(/\s*\[\d{1,3}\]/g, "");

  text = unwrapBrackets(text);

  text = text
    .replace(/\*{2,}/g, "")
    // leftover markdown blockquote markers from the PDF-to-text conversion
    .replace(/^\s*>\s?/gm, "")
    // code-fence markers: an artifact of the PDF-to-text conversion (the
    // source is legislative text, not code -- these mark a page/column
    // break in the original, not a real fenced block). Usually a bare
    // "```" alone on its own line, but at least one Act's conversion
    // produced "```html" inline ahead of real content on the same line, so
    // the marker itself -- with an optional language tag -- is stripped
    // wherever it appears rather than only when it has a line to itself.
    .replace(/```\w*/g, "")
    // markdown heading syntax on genuine structural labels this Act's text
    // carries ("## STATE AMENDMENTS", "## Andhra Pradesh"): keep the label,
    // drop the "#" markers, which our plain-text rendering can't interpret
    .replace(/^#{1,6}\s*/gm, "")
    // leftover markdown italic underscores from the PDF-to-text conversion:
    // the source wraps clause labels and citation terms in italics, which
    // renders as raw litter once flattened to plain text -- "( _1_ )",
    // "( _a_ )", "_Vide_" -- reported live as unprofessional. Keep the text
    // the italics were wrapping, drop the underscores.
    .replace(/_+([^_\n]+?)_+/g, "$1")
    // a lone, unpaired underscore is OCR noise rather than italic markup --
    // confirmed live in a heavily garbled 1866 Act ("this Part_ of this
    // Act") with no second underscore anywhere nearby to pair it with.
    // Underscores play no legitimate role in Indian statutory prose either
    // way, so whatever's left over at this point is dropped outright.
    .replace(/_/g, "")
    // tighten the space the italics left behind inside short parenthetical
    // labels: "( 1 )" -> "(1)", "( a )" -> "(a)"
    .replace(/\(\s+([a-zA-Z0-9]{1,4})\s+\)/g, "($1)")
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

// A STATE amendment is recorded in a completely different format from a
// central one -- not a numbered footnote, but a "STATE AMENDMENTS" prose
// block ending in a citation note: "[ Vide Andhra Pradesh Act 22 of 2018,
// sec. 5 (w.e.f. 1-1-2014).]". AMENDMENT_PATTERN never matches this shape,
// so a section with only state-level amendments (no central footnote at
// all) produced a "0 amendments" timeline sitting directly under statutory
// text visibly showing three of them -- confirmed live on RFCTLARR s.24,
// which has Andhra Pradesh/Maharashtra/Haryana amendments but nothing
// AMENDMENT_PATTERN could see. "Vide_?" (not "\bVide\b") because this runs
// on the RAW, not-yet-cleaned row text, where the word is still wrapped in
// markdown italics ("_Vide_") -- the underscore sits directly against it
// with no space, so a plain word-boundary match misses it entirely.
const STATE_AMENDMENT_PATTERN =
  /Vide_?\s+([A-Za-z][A-Za-z\s]{2,40}?)\s+Act\s+(\d+)\s+of\s+(\d{4}),?\s*sec\.?\s*(\S+?)\s*\(([^)]{3,40})\)/gi;

function parseStateAmendments(
  text: string,
  sourceUrl: string,
  section: string | null,
): ExtractedAmendment[] {
  const out: ExtractedAmendment[] = [];
  for (const m of text.matchAll(STATE_AMENDMENT_PATTERN)) {
    const [full, state, actNum, actYear, , dateInfo] = m;
    const enactedYear = Number(actYear);
    if (!Number.isFinite(enactedYear) || enactedYear < 1800 || enactedYear > 2100) continue;
    out.push({
      // Same preference as the central pattern: the commencement date is
      // when the change actually took effect, the amending Act's own year
      // is the fallback.
      year: yearFromWef(dateInfo, enactedYear),
      event: `${state.trim().replace(/\s+/g, " ")} amendment by Act ${actNum} of ${actYear}`,
      // The underscore sits mid-string ("Vide_ Andhra...", the italics
      // marker matched by STATE_AMENDMENT_PATTERN's "Vide_?"), not at
      // either edge, so trimming only the string's ends leaves it in place
      // -- confirmed live. It's never real content in this dataset (always
      // a markdown-italics artifact), so it's dropped outright rather than
      // anchored.
      supporting_quote: full.replace(/_/g, "").trim(),
      source_url: sourceUrl,
      section,
    });
  }
  return out;
}

// fetchActAmendments and fetchStatutoryText both start the same way: resolve
// a free-text query down to "the rows for one specific Act" (optionally
// scoped to one section), matching by word-set (actNameMatches) and
// preferring the most comprehensive matching title (see
// pickMostComprehensiveTitle) as the real Act. Shared here rather than
// duplicated in both.
//
// The comprehensiveness comparison has to run over EVERY section of a
// candidate Act, before any section filter is applied -- confirmed live
// this was a second bug alongside resolveActName's: filtering to one
// requested section first, then comparing "how many sections does each
// remaining candidate have", makes every candidate trivially "1 section"
// once section-filtered, destroying the exact signal that distinguishes
// a major Act from an obscure same-named one. Comprehensiveness is
// decided from the Act's full row set; the section filter (when a section
// is given) is applied only afterward, to whichever title won.
function findCanonicalRows(
  rows: LegislationRow[],
  actName: string,
  section: string | null,
): LegislationRow[] {
  const targetAct = actNameTokens(actNameWithoutYear(actName));

  const actRows = rows.filter(
    (row) => row.text && row.source_url && actNameMatches(row.title ?? "", targetAct),
  );
  if (actRows.length === 0) return [];

  const bestTitle = pickMostComprehensiveTitle(actRows);

  const targetSection = section ? normalizeSection(baseSectionNumber(section)) : null;
  return actRows.filter((row) => {
    if ((row.title ?? "") !== bestTitle) return false;
    if (targetSection && normalizeSection(row.section_number ?? "") !== targetSection) return false;
    return true;
  });
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

  const relevant = findCanonicalRows(rows, actName, section);
  if (relevant.length === 0) return [];

  const amendments = relevant.flatMap((r) => [
    ...parseAmendments(r.text!, r.source_url!, r.section_number ?? null),
    ...parseStateAmendments(r.text!, r.source_url!, r.section_number ?? null),
  ]);

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

// A plain substring check after stripping punctuation only matches when the
// query's words appear in the SAME ORDER as the official title. That broke
// on "Civil Procedure Code" against the dataset's actual "The Code of Civil
// Procedure, 1908" -- confirmed live: the query's word order ("Civil
// Procedure Code") isn't a substring of the title's ("Code of Civil
// Procedure") even though every word matches, so the Act-level lookup found
// nothing and the amendment timeline silently came back empty despite CPC's
// well-known amendment history. Comparing word SETS instead of a
// concatenated string is order-independent, so "Civil Procedure Code" and
// "Code of Civil Procedure" match as the same three words regardless of
// which one comes first.
const ACT_NAME_STOPWORDS = new Set(["the", "of", "and", "an", "a", "for"]);

export function actNameTokens(actName: string): Set<string> {
  return new Set(
    actName
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 0 && !ACT_NAME_STOPWORDS.has(word)),
  );
}

// True when every significant word in the query also appears somewhere in
// the candidate title -- e.g. query tokens {civil, procedure, code} against
// title tokens {code, of, civil, procedure, 1908} (stopwords and the year
// don't need to match). Multiple titles can still satisfy this at once,
// whether one is an amendment Act of another or the two are entirely
// unrelated Acts that happen to share a couple of common words; callers
// already break that tie by preferring the most comprehensive matching
// title (see pickMostComprehensiveTitle).
export function actNameMatches(rowTitle: string, queryTokens: Set<string>): boolean {
  if (queryTokens.size === 0) return false;
  const rowTokens = actNameTokens(rowTitle);
  for (const token of queryTokens) {
    if (!rowTokens.has(token)) return false;
  }
  return true;
}

// unwrapBrackets pairs brackets within a single chunk's raw text, but a
// splice can straddle a chunk boundary -- opened in one chunk, closed in
// the next -- since the parquet snapshot splits long sections into chunks
// independently of where a splice marker happens to fall. Each chunk is
// cleaned on its own before this point (cleanStatutoryText has no way to
// see past its own chunk), so a boundary-straddling splice's closer is
// left as a stray "]" with no opener anywhere in its own chunk's output.
// Confirmed live across the snapshot on 3900+ chunks, e.g. Income-tax Act
// s.142's "...tax:]\nProvided that...". Run once on the fully joined
// section text, this drops exactly that stray "]" and nothing else: any
// "]" that already has an unclosed "[" before it in the joined text is a
// real, resolvable pair and is left alone.
function stripOrphanedClosingBrackets(text: string): string {
  let depth = 0;
  let out = "";
  for (const ch of text) {
    if (ch === "[") {
      depth++;
      out += ch;
    } else if (ch === "]") {
      if (depth > 0) {
        depth--;
        out += ch;
      }
      // else: no opener anywhere before it in the joined text -- drop it
    } else {
      out += ch;
    }
  }
  return out;
}

// Long sections are stored as several chunks; this stitches them back
// together in chunk_id order. That matters beyond completeness -- India
// Code's amendment footnotes ("Subs. by Act 3 of 1989, s. 23 ... (w.e.f.
// 1-4-1989)") are what the amendment timeline is mined from, and they sit at
// the end of a section, so a single chunk usually misses them.
//
// Exposed (rather than inlined into fetchStatutoryText) for
// scripts/verify-statutory-formatting.mts, which exercises this exact
// stitching logic against every multi-chunk section in the snapshot --
// chunk-spanning artifacts like a splice bracket that opens in one chunk
// and closes in the next only show up once chunks are actually joined, and
// the script would otherwise have to re-scan all 74,000+ rows once per
// section just to reach this code path.
export function stitchSectionText(chunks: LegislationRow[], sectionNumber: string): string {
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

  return stripOrphanedClosingBrackets(cleanedChunks.join("\n\n"));
}

export async function fetchStatutoryText(
  actName: string,
  section: string,
): Promise<StatutorySection | null> {
  const rows = await loadRows();
  if (!rows) return null;

  // "Information Technology Act" should match "The Information Technology
  // Act, 2000", and "Civil Procedure Code" should match "The Code of Civil
  // Procedure, 1908" despite the reversed word order -- word-set comparison
  // (findCanonicalRows -> actNameMatches) handles both, plus the
  // hyphenation variance ("Income-tax" vs "Income Tax") that word-splitting
  // on non-alphanumerics already collapses. It also prefers the most
  // comprehensive matching title: a query for "Income Tax Act" should land
  // on "The Income-tax Act, 1961" (hundreds of sections), not "The Income
  // Tax (Amendment) Act" (a handful) or an unrelated Act that happens to
  // share the words "income" and "act".
  const chunks = findCanonicalRows(rows, actName, section).sort((a, b) =>
    (a.chunk_id ?? "").localeCompare(b.chunk_id ?? "", undefined, { numeric: true }),
  );
  if (chunks.length === 0) return null;

  const first = chunks[0];
  const sectionNumber = first.section_number ?? section;

  return {
    text: stitchSectionText(chunks, sectionNumber),
    title: first.title ?? actName,
    sectionNumber: first.section_number ?? section,
    sourceUrl: first.source_url!,
    enactmentYear: typeof first.year === "number" ? first.year : null,
  };
}
