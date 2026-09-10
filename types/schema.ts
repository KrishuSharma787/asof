import { z } from "zod";

// "unverified" exists because the original five values had no way to say
// "we didn't find out". Without it, in_force was a silent default: a query
// that surfaced nothing rendered identically to one that confirmed the Act
// is live. That shipped a real wrong answer -- the Income-tax Act, 1961 was
// reported "in force / high confidence" months after s.536 of the Income Tax
// Act, 2025 repealed it.
export const STATUS_VALUES = [
  "in_force",
  "repealed",
  "struck_down",
  "read_down",
  "omitted",
  "unverified",
] as const;

export const CONFIDENCE_VALUES = ["high", "medium", "low"] as const;

export const KeyJudgmentSchema = z.object({
  case_name: z.string().min(1),
  court: z.string().min(1),
  year: z.number().int(),
  effect_on_section: z.string().min(1),
  supporting_quote: z.string().min(1),
  source_url: z.url(),
});

export const HighlightedPhraseSchema = z.object({
  phrase: z.string().min(1),
  interpretation_note: z.string().min(1),
  case_name: z.string().min(1),
  supporting_quote: z.string().min(1),
  source_url: z.url(),
});

export const AmendmentTimelineEntrySchema = z.object({
  year: z.number().int(),
  event: z.string().min(1),
  description: z.string().min(1),
  supporting_quote: z.string().min(1),
  source_url: z.url(),
});

// A status claim has to point at the text that supports it. Validation drops
// the evidence if the quote isn't verbatim in a retrieved source, and the
// route then downgrades the status to "unverified" -- so an unsupported
// status can never reach the UI wearing a confident badge.
export const StatusEvidenceSchema = z.object({
  supporting_quote: z.string().min(1),
  source_url: z.url(),
});

export const InterpretationResultSchema = z.object({
  act_name: z.string().min(1),
  section: z.string().nullable(),
  status: z.enum(STATUS_VALUES),
  status_evidence: StatusEvidenceSchema.nullable(),
  current_force_status_explanation: z.string().min(1),
  key_judgments: z.array(KeyJudgmentSchema),
  highlighted_phrases: z.array(HighlightedPhraseSchema),
  amendment_timeline: z.array(AmendmentTimelineEntrySchema),
  confidence: z.enum(CONFIDENCE_VALUES),
});

export type Status = (typeof STATUS_VALUES)[number];
export type Confidence = (typeof CONFIDENCE_VALUES)[number];
export type KeyJudgment = z.infer<typeof KeyJudgmentSchema>;
export type StatusEvidence = z.infer<typeof StatusEvidenceSchema>;
export type HighlightedPhrase = z.infer<typeof HighlightedPhraseSchema>;
export type InterpretationResult = z.infer<typeof InterpretationResultSchema>;
export type AmendmentTimelineEntry = z.infer<typeof AmendmentTimelineEntrySchema>;
