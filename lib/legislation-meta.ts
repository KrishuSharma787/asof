// Kept separate from lib/legislation.ts on purpose: that module imports
// node:fs to read the parquet snapshot, and this label is rendered by a
// client component. Importing it from there pulled fs into the client bundle
// and hard-crashed the Turbopack build ("the chunking context does not
// support external modules (request: node:fs/promises)") -- a break that
// type-checking cannot catch, since the types are perfectly valid.
export const LEGISLATION_SNAPSHOT_LABEL = "vaquill/open-india-law, snapshot v2026.08";
