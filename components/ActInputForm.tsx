"use client";

import { useState, type FormEvent } from "react";

interface ActInputFormProps {
  onSubmit: (actName: string, section: string | null) => void;
  loading: boolean;
}

function BracketedField({
  id,
  label,
  optional,
  value,
  onChange,
  placeholder,
  required,
  disabled,
}: {
  id: string;
  label: string;
  optional?: boolean;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  required?: boolean;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className="text-body-sm font-medium text-charcoal">
        {label} {optional && <span className="text-steel">(optional)</span>}
      </label>
      <div className="flex items-center gap-2 border border-hairline bg-canvas px-3 focus-within:border-2 focus-within:border-brand-green focus-within:px-[11px]">
        <span aria-hidden="true" className="text-steel">
          [
        </span>
        <input
          id={id}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          disabled={disabled}
          className="h-10 flex-1 bg-transparent text-body-md text-ink outline-none placeholder:text-muted disabled:text-muted"
        />
        <span aria-hidden="true" className="text-steel">
          ]
        </span>
      </div>
    </div>
  );
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
    <form
      onSubmit={handleSubmit}
      className="mx-auto flex w-full max-w-lg flex-col gap-5 border border-hairline p-6"
    >
      <h2 className="text-body-md font-medium text-ink">What law are you researching?</h2>

      <BracketedField
        id="actName"
        label="Act"
        value={actName}
        onChange={setActName}
        placeholder="e.g. Information Technology Act, 2000"
        required
        disabled={loading}
      />

      <BracketedField
        id="section"
        label="Section"
        optional
        value={section}
        onChange={setSection}
        placeholder="e.g. 66A"
        disabled={loading}
      />

      <button
        type="submit"
        disabled={loading || !actName.trim()}
        className="self-end bg-primary px-5 py-2 text-body-sm font-medium text-on-primary transition-colors disabled:bg-hairline disabled:text-muted"
      >
        {loading ? "Exploring…" : "Explore →"}
      </button>
    </form>
  );
}
