// Isolated from lib/legislation.ts (which imports node:fs) so this can be
// imported anywhere, including client components, without pulling a
// server-only module into the browser bundle -- the same problem that broke
// the Turbopack build once already.

// Was `actName.split(",")[0]`, which assumed the only comma in an Act's name
// sits before its year ("Income Tax Act, 1961"). That breaks for Acts whose
// own official title contains a comma -- "The Right to Fair Compensation and
// Transparency in Land Acquisition, Rehabilitation and Resettlement Act,
// 2013" was truncated to "...in Land Acquisition", silently dropping
// "Rehabilitation and Resettlement Act" from every downstream comparison and
// prompt. Stripping only a trailing ", YYYY" leaves the rest of the title,
// commas included, intact.
export function actNameWithoutYear(actName: string): string {
  return actName.replace(/,?\s*\d{4}\s*$/, "").trim();
}
