# asof

**Know the law as of.**

A time-aware legal research engine for Indian legislation. Give it an Act
(and optionally a section) and it tells you three things a static copy of
the statute book can't: whether the provision is actually still in force,
which words in its verbatim text have had their practical meaning changed
by a court without any formal amendment, and what the real legislative
history looks like — not "one 2026 bill," but every amendment on record.

Live at [asof-sand.vercel.app](https://asof-sand.vercel.app).

## Why

A section can read exactly as it did in 1950 and mean something completely
different today. Section 66A of the IT Act is still printed in most copies
of the Act — it was struck down by the Supreme Court in 2015, not repealed
by Parliament. The Income-tax Act, 1961 was reported "in force" by more
than one tracker months after it was actually repealed. `asof` treats a
provision's status and meaning as something to be *verified against live
sources*, not assumed from the text alone — and when it can't verify
something, it says so instead of defaulting to "in force."

## How it works

1. **Resolve** the Act name against a local snapshot of India's central
   legislation (`vaquill/open-india-law`, cached as parquet) to canonicalize
   informal or partial input before anything else runs.
2. **Retrieve**, in parallel: verbatim statutory text and amendment
   footnotes from the snapshot, live judgments from Indian Kanoon (ranked by
   citation count, not just search relevance), the current statute-book
   listing for force/repeal status, and a Tavily fallback for anything the
   snapshot doesn't cover.
3. **Synthesize** with Gemini, constrained to ground every claim in a
   retrieved excerpt — a status, a highlighted phrase, an amendment entry —
   never in the model's own training knowledge.
4. **Validate**: every quote the model returns is checked verbatim against
   the actual retrieved sources. Anything that doesn't match is dropped, and
   a status without surviving evidence is downgraded to `unverified` rather
   than shown with false confidence.
5. **Cross-reference** key judgments against each other with Groq (`follows`
   / `distinguishes` / `overrules`), fetched separately so a slow citation
   graph never holds up the primary answer.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind CSS v4 · Zod

- **Gemini** (`@google/genai`) — synthesis, with a six-model fallback chain
  and a shared time budget so a struggling model degrades to a clean error
  instead of running the request past Vercel's function timeout.
- **Indian Kanoon API** — judgment search and full-text retrieval.
- **Tavily** — web-search fallback for amendment history and Acts outside
  the local snapshot.
- **Groq** — pairwise citation-relationship extraction for the citation
  graph.
- **hyparquet** — reads the `vaquill/open-india-law` legislation snapshot
  (Hugging Face, CC BY 4.0) from a locally cached parquet file.

## Getting started

```bash
npm install
cp .env.example .env.local   # fill in the keys below
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

### Environment variables

| Variable | Used for |
|---|---|
| `GEMINI_API_KEY` | Interpretation synthesis |
| `GROQ_API_KEY` | Citation-relationship extraction |
| `TAVILY_API_KEY` | Web-search fallback retrieval |
| `INDIANKANOON_API_KEY` | Judgment and statute-book search |
| `HF_TOKEN` | Downloads the legislation snapshot on first run |

### Scripts

| Command | Does |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` | Production build |
| `npm run start` | Serve a production build |
| `npm run lint` | ESLint |
| `npm run verify:formatting` | Dataset-wide regression check for statutory-text cleanup, across every row in the legislation snapshot |

## Design

Dark, monospace, boxed-terminal aesthetic — every color and spacing value
is a token, not a literal, so the whole app re-themes from `app/globals.css`
alone. See [`DESIGN.md`](./DESIGN.md) for the full token reference.

## Disclaimer

`asof` summarizes AI-retrieved court judgments. It is not legal advice and
does not replace professional legal research.
