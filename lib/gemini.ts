import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { InterpretationResultSchema } from "../types/schema";
import type { RetrievedJudgment } from "./retrieval";

const MODEL = "gemini-3.6-flash";
const EXCERPT_CHAR_LIMIT = 20000;
const REQUEST_TIMEOUT_MS = 30000;

const RESPONSE_JSON_SCHEMA = z.toJSONSchema(InterpretationResultSchema);

const SYSTEM_INSTRUCTION = `You are a legal research assistant analyzing how Indian courts have interpreted a specific Act/section. You are given the Act name, an optional section, and a numbered list of retrieved source excerpts (case law, statutory text, or legal commentary), each with a title, court/source, and URL.

Rules, all mandatory:
1. Only include a judgment in key_judgments if its excerpt shows a court actually construing or interpreting the meaning of the provision — not merely citing, quoting, or mentioning it in passing.
2. Every supporting_quote must be an exact, verbatim substring copied from that judgment's own excerpt text. Do not paraphrase, summarize, or combine text from different excerpts.
3. source_url must be copied character-for-character from the excerpt list provided. Never modify or invent a URL.
4. If none of the excerpts show a court actually interpreting the provision, set key_judgments to an empty array and reflect that in status/current_force_status_explanation/confidence — never invent an interpretation from your own training knowledge.
5. Do not state any interpretation, effect, or status claim that is not directly grounded in the provided excerpts.
6. status must be exactly one of: in_force, repealed, struck_down, read_down, omitted.
7. confidence reflects how many/how strong the grounding excerpts are: high (multiple clear, on-point excerpts, especially from higher courts), medium (some relevant material but limited or lower-tier), low (thin, tangential, or largely absent grounding).
8. last_amendment_year: set this to the year the Act (or this section) was last amended ONLY if an excerpt explicitly states an amendment/enactment year for it. If no excerpt states one, set it to null — never estimate or infer a year.`;

function buildUserPrompt(
  actName: string,
  section: string | null,
  sources: RetrievedJudgment[],
): string {
  const sourceBlocks = sources
    .map((s, i) => {
      const text =
        s.text.length > EXCERPT_CHAR_LIMIT
          ? `${s.text.slice(0, EXCERPT_CHAR_LIMIT)} …[truncated]`
          : s.text;
      return `[${i + 1}] Title: ${s.title}\nCourt/Source: ${s.court}\nURL: ${s.url}\nText: ${text}`;
    })
    .join("\n\n");

  return `Act: ${actName}\nSection: ${section ?? "N/A"}\n\nRetrieved sources:\n\n${sourceBlocks}\n\nUsing ONLY the sources above, produce the JSON result.`;
}

export async function synthesizeInterpretation(
  actName: string,
  section: string | null,
  sources: RetrievedJudgment[],
): Promise<unknown> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  const ai = new GoogleGenAI({ apiKey });
  const userPrompt = buildUserPrompt(actName, section, sources);

  const call = () =>
    ai.models.generateContent({
      model: MODEL,
      contents: userPrompt,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        responseMimeType: "application/json",
        responseJsonSchema: RESPONSE_JSON_SCHEMA,
        temperature: 0,
        httpOptions: { timeout: REQUEST_TIMEOUT_MS },
      },
    });

  let response;
  try {
    response = await call();
  } catch (firstErr) {
    console.error("[gemini] first attempt failed, retrying once:", firstErr);
    response = await call();
  }

  const text = response.text;
  if (!text) throw new Error("Gemini returned an empty response");

  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Gemini response was not valid JSON: ${(err as Error).message}`);
  }
}
