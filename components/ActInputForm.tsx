"use client";

import { useState, type FormEvent } from "react";

interface ActInputFormProps {
  onSubmit: (actName: string, section: string | null) => void;
  loading: boolean;
}

export function ActInputForm({ onSubmit, loading }: ActInputFormProps) {
  const [actName, setActName] = useState("");
  const [section, setSection] = useState("");

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const trimmedAct = actName.trim();
    if (!trimmedAct) return;
    onSubmit(trimmedAct, section.trim() || null);
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-2">
        <label htmlFor="actName" className="text-body-sm font-medium text-charcoal">
          Act name
        </label>
        <input
          id="actName"
          type="text"
          value={actName}
          onChange={(e) => setActName(e.target.value)}
          placeholder="e.g. Information Technology Act, 2000"
          required
          disabled={loading}
          className="h-10 rounded-md border border-hairline bg-canvas px-3 text-body-md text-ink placeholder:text-muted outline-none focus:border-2 focus:border-brand-green disabled:bg-surface disabled:text-muted"
        />
      </div>
      <div className="flex flex-col gap-2 sm:w-40">
        <label htmlFor="section" className="text-body-sm font-medium text-charcoal">
          Section <span className="text-steel">(optional)</span>
        </label>
        <input
          id="section"
          type="text"
          value={section}
          onChange={(e) => setSection(e.target.value)}
          placeholder="e.g. 66A"
          disabled={loading}
          className="h-10 rounded-md border border-hairline bg-canvas px-3 text-body-md text-ink placeholder:text-muted outline-none focus:border-2 focus:border-brand-green disabled:bg-surface disabled:text-muted"
        />
      </div>
      <button
        type="submit"
        disabled={loading || !actName.trim()}
        className="h-10 shrink-0 rounded-full bg-primary px-5 text-body-sm font-medium text-on-primary transition-colors disabled:bg-hairline disabled:text-muted"
      >
        {loading ? "Checking…" : "Check status"}
      </button>
    </form>
  );
}
