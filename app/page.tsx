"use client";

import { useState } from "react";
import { ActInputForm } from "@/components/ActInputForm";
import { StatusCard } from "@/components/StatusCard";
import { JudgmentList } from "@/components/JudgmentList";
import { CitationGraph } from "@/components/CitationGraph";
import { ConflictBanner } from "@/components/ConflictBanner";
import { StatutoryText } from "@/components/StatutoryText";
import { AmendmentTimeline } from "@/components/AmendmentTimeline";
import type { CheckResponseBody } from "@/app/api/check/route";
import type { CitationsResponseBody } from "@/app/api/citations/route";

type CitationState =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "done"; data: CitationsResponseBody };

type RequestState =
  | { phase: "idle" }
  | { phase: "loading"; actName: string; section: string | null }
  | { phase: "error"; message: string }
  | { phase: "success"; data: CheckResponseBody };

export default function Home() {
  const [state, setState] = useState<RequestState>({ phase: "idle" });
  const [citations, setCitations] = useState<CitationState>({ phase: "idle" });

  async function handleSubmit(actName: string, section: string | null) {
    setState({ phase: "loading", actName, section });
    setCitations({ phase: "idle" });
    try {
      const res = await fetch("/api/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actName, section }),
      });
      const json = await res.json();
      if (!res.ok) {
        setState({
          phase: "error",
          message: typeof json?.error === "string" ? json.error : "Something went wrong.",
        });
        return;
      }
      const data = json as CheckResponseBody;
      setState({ phase: "success", data });

      // The citation graph arrives separately so its rate-limited Groq calls
      // don't hold up everything else. Failure here is silent on purpose: the
      // graph is supplementary, and the answer above it is already correct.
      setCitations({ phase: "loading" });
      try {
        const edgeRes = await fetch("/api/citations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ actName, section }),
        });
        if (!edgeRes.ok) throw new Error("citations unavailable");
        setCitations({ phase: "done", data: (await edgeRes.json()) as CitationsResponseBody });
      } catch {
        setCitations({ phase: "done", data: { citation_edges: [], conflicts: [] } });
      }
    } catch {
      setState({
        phase: "error",
        message: "Could not reach the server. Check your connection and try again.",
      });
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-8 px-6 py-10">
      <div>
        <h1 className="text-heading-2 text-ink">asof</h1>
        <p className="mt-2 max-w-[65ch] text-subtitle text-steel">
          Enter an Act (and optionally a section) to see how Indian courts have interpreted it —
          including cases where a judgment changed its practical meaning without any formal
          amendment.
        </p>
      </div>

      <ActInputForm onSubmit={handleSubmit} loading={state.phase === "loading"} />

      {state.phase === "loading" && (
        <p role="status" className="text-body-sm text-steel">
          Researching {state.actName}
          {state.section ? `, Section ${state.section}` : ""}… this can take up to a minute while
          judgments are retrieved and analyzed.
        </p>
      )}

      {state.phase === "error" && (
        <p role="alert" className="text-body-sm font-medium text-brand-error-text">
          {state.message}
        </p>
      )}

      {state.phase === "success" && (
        <div>
          <StatusCard result={state.data} />
          <ConflictBanner conflicts={citations.phase === "done" ? citations.data.conflicts : []} />
          {state.data.statutory_text && state.data.statutory_text_source && (
            <StatutoryText
              text={state.data.statutory_text}
              source={state.data.statutory_text_source}
              sourceUrl={state.data.statutory_text_source_url}
              highlights={state.data.highlighted_phrases}
            />
          )}
          <AmendmentTimeline
            entries={state.data.amendment_timeline}
            judgments={state.data.key_judgments}
          />
          <JudgmentList
            judgments={state.data.key_judgments}
            lastAmendmentYear={state.data.last_amendment_year}
          />
          {citations.phase === "loading" ? (
            <p className="mt-6 text-body-sm text-steel">Working out how these judgments cite each other…</p>
          ) : citations.phase === "done" ? (
            <CitationGraph edges={citations.data.citation_edges} />
          ) : null}
        </div>
      )}
    </main>
  );
}
