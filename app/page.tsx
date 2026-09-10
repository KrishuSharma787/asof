"use client";

import { useState } from "react";
import { ActInputForm } from "@/components/ActInputForm";
import { StatusCard } from "@/components/StatusCard";
import { JudgmentList } from "@/components/JudgmentList";
import { CitationGraph } from "@/components/CitationGraph";
import { ConflictBanner } from "@/components/ConflictBanner";
import type { CheckResponseBody } from "@/app/api/check/route";

type RequestState =
  | { phase: "idle" }
  | { phase: "loading"; actName: string; section: string | null }
  | { phase: "error"; message: string }
  | { phase: "success"; data: CheckResponseBody };

export default function Home() {
  const [state, setState] = useState<RequestState>({ phase: "idle" });

  async function handleSubmit(actName: string, section: string | null) {
    setState({ phase: "loading", actName, section });
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
      setState({ phase: "success", data: json as CheckResponseBody });
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
        <h1 className="text-heading-2 text-ink">Indian Act Status &amp; Interpretation Checker</h1>
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
        <p role="alert" className="text-body-sm font-medium text-accent-red">
          {state.message}
        </p>
      )}

      {state.phase === "success" && (
        <div>
          <StatusCard result={state.data} />
          <ConflictBanner conflicts={state.data.conflicts} />
          <JudgmentList
            judgments={state.data.key_judgments}
            lastAmendmentYear={state.data.last_amendment_year}
          />
          <CitationGraph edges={state.data.citation_edges} />
        </div>
      )}
    </main>
  );
}
