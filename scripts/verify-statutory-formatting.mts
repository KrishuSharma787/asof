// Runs the statutory-text cleaning pipeline against every row in the
// vaquill/open-india-law central-legislation snapshot and checks the OUTPUT
// for known formatting artifacts -- markdown litter, unmatched brackets,
// leftover banners -- regardless of how short or long a given Act/section's
// raw text is, and regardless of how many chunks it's split across.
//
// Every formatting bug fixed on this feature so far (repeated section
// titles, stray code fences, raw "##" headers, glued footnote numbers,
// "( _1_ )" litter, a dangling "[" on citation notes, a stray "]" from a
// splice spanning a chunk boundary) was found by hand, one Act/section at a
// time, and each fix was verified only against whichever query had just
// been reported broken. That leaves the rest of the snapshot unchecked --
// this runs the same artifact checks against all of it in one pass, so a
// regression (or a pattern that only shows up in some other Act's text) is
// caught before a user finds it.
//
// Two passes:
//   1. cleanStatutoryText() on every individual chunk in isolation -- the
//      strictest possible check for markdown/banner litter, since a chunk
//      has no cross-chunk context to lean on. This is the full 73,000+ row
//      snapshot.
//   2. stitchSectionText() on every section that has 2+ chunks -- the same
//      join path fetchStatutoryText() uses for a real query. This is what
//      actually exercises chunk-boundary artifacts (a splice bracket opened
//      in one chunk and closed in the next can only be resolved once chunks
//      are joined), so bracket balance is only meaningful here -- a single
//      chunk can legitimately contain half of a splice and isn't a defect
//      for it. ~12,500 multi-chunk sections.
//
// Usage: npm run verify:formatting
import { cleanStatutoryText, getAllLegislationRows, stitchSectionText, type LegislationRow } from "../lib/legislation";

interface Check {
  name: string;
  test: (cleaned: string) => boolean; // true = artifact present (bad)
}

// Applies to a single fragment in isolation as much as to a fully joined
// section -- these are markdown/banner litter that a correct cleaning pass
// should never leave behind, at any granularity.
const COMMON_CHECKS: Check[] = [
  { name: "code fence (```)", test: (t) => t.includes("```") },
  { name: "markdown heading (#...)", test: (t) => /^#{1,6}\s/m.test(t) },
  { name: "blockquote marker (>)", test: (t) => /^\s*>/m.test(t) },
  { name: "bold marker (**)", test: (t) => t.includes("**") },
  { name: "markdown italic underscore (_)", test: (t) => t.includes("_") },
  { name: "loose paren spacing e.g. '( 1 )'", test: (t) => /\(\s+[a-zA-Z0-9]{1,4}\s+\)/.test(t) },
  // A genuine unstripped banner is always at the very start of the text --
  // the stripping regex is anchored there and never leaves a partial banner
  // mid-document. Restricting the check to the first ~150 chars avoids
  // false positives on a genuine Schedule table elsewhere in the section
  // whose own row content happens to contain the word "Repealed".
  {
    name: "leftover metadata banner (| In Force / | Repealed)",
    test: (t) => /\|\s*(In Force|Repealed)\b/i.test(t.slice(0, 150)),
  },
  { name: "leftover 'Section N:' header", test: (t) => /^\s*section\s+\S+\s*:/i.test(t) },
  { name: "OCR image placeholder", test: (t) => /intentionally omitted/i.test(t) },
];

// Bracket balance is a property of a fully assembled section, not of a
// fragment: a splice can legitimately open in one chunk and close in the
// next, so a single chunk viewed on its own can show a "mismatch" that
// isn't actually one -- it's only resolved once stitchSectionText joins
// the chunks and stripOrphanedClosingBrackets runs on the result. Checking
// it per-chunk would just measure how often a section happens to be cut
// mid-splice, not a real defect, so it's asserted only against the fully
// joined text.
const JOINED_ONLY_CHECKS: Check[] = [
  {
    name: "unmatched square bracket",
    test: (t) => (t.match(/\[/g)?.length ?? 0) !== (t.match(/\]/g)?.length ?? 0),
  },
];

interface RunResult {
  checked: number;
  anyFailure: boolean;
}

function runChecks(
  label: string,
  items: Iterable<{ id: string; cleaned: string }>,
  checks: Check[],
): RunResult {
  const counts = new Map<string, number>(checks.map((c) => [c.name, 0]));
  const samples = new Map<string, { id: string; snippet: string }>();

  let checked = 0;
  let totalChars = 0;
  let maxChars = 0;
  let minChars = Infinity;

  for (const { id, cleaned } of items) {
    checked++;
    totalChars += cleaned.length;
    if (cleaned.length > maxChars) maxChars = cleaned.length;
    if (cleaned.length < minChars) minChars = cleaned.length;

    for (const check of checks) {
      if (!check.test(cleaned)) continue;
      counts.set(check.name, (counts.get(check.name) ?? 0) + 1);
      if (!samples.has(check.name)) {
        samples.set(check.name, { id, snippet: cleaned.slice(0, 200).replace(/\s+/g, " ") });
      }
    }
  }

  console.log(
    `\n=== ${label} ===\n` +
      `Checked ${checked} -- cleaned length ${checked ? minChars : 0}-${maxChars} chars, ` +
      `avg ${checked ? Math.round(totalChars / checked) : 0}.\n`,
  );

  let anyFailure = false;
  for (const check of checks) {
    const count = counts.get(check.name) ?? 0;
    const pct = checked ? ((count / checked) * 100).toFixed(3) : "0.000";
    console.log(`${count === 0 ? "PASS" : "FAIL"}  ${check.name}: ${count}/${checked} (${pct}%)`);
    if (count > 0) {
      const sample = samples.get(check.name)!;
      console.log(`      e.g. ${sample.id}: ${JSON.stringify(sample.snippet)}`);
      anyFailure = true;
    }
  }

  return { checked, anyFailure };
}

function* perChunk(rows: LegislationRow[]): Iterable<{ id: string; cleaned: string }> {
  for (const row of rows) {
    if (!row.text || !row.section_number) continue;
    yield {
      id: `"${row.title ?? "(untitled)"}" section ${row.section_number}`,
      cleaned: cleanStatutoryText(row.text, row.section_number),
    };
  }
}

function* multiChunkSections(rows: LegislationRow[]): Iterable<{ id: string; cleaned: string }> {
  interface Group {
    title: string;
    sectionNumber: string;
    chunks: LegislationRow[];
  }
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (!row.text || !row.section_number || !row.title) continue;
    // Group by title+section without concatenating them into a single
    // string key -- an Act title is always full of spaces, so joining and
    // later splitting on " " would misparse the recovered pieces.
    const key = JSON.stringify([row.title, row.section_number]);
    const group = groups.get(key);
    if (group) group.chunks.push(row);
    else groups.set(key, { title: row.title, sectionNumber: row.section_number, chunks: [row] });
  }

  for (const { title, sectionNumber, chunks } of groups.values()) {
    if (chunks.length < 2) continue;
    const sorted = [...chunks].sort((a, b) =>
      (a.chunk_id ?? "").localeCompare(b.chunk_id ?? "", undefined, { numeric: true }),
    );
    yield {
      id: `"${title}" section ${sectionNumber} (${sorted.length} chunks)`,
      cleaned: stitchSectionText(sorted, sectionNumber),
    };
  }
}

async function main() {
  const rows = await getAllLegislationRows();
  if (!rows) {
    console.error("Could not load the legislation snapshot (missing HF_TOKEN, or no .cache file yet).");
    process.exit(1);
  }

  const chunkResult = runChecks("Pass 1: every chunk, cleaned in isolation", perChunk(rows), COMMON_CHECKS);
  const sectionResult = runChecks(
    "Pass 2: every multi-chunk section, joined via stitchSectionText (the real query path)",
    multiChunkSections(rows),
    [...COMMON_CHECKS, ...JOINED_ONLY_CHECKS],
  );

  const anyFailure = chunkResult.anyFailure || sectionResult.anyFailure;
  console.log(
    `\n${anyFailure ? "FAILED" : "PASSED"} -- ${chunkResult.checked} chunks, ` +
      `${sectionResult.checked} multi-chunk sections checked.`,
  );
  process.exit(anyFailure ? 1 : 0);
}

main();
