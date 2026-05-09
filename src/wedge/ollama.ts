import { createHash } from "node:crypto";
import { z } from "zod";
import { WedgeDecisionSchema, type WedgeDecision } from "./cognition-schema.js";

const OllamaChatResponseSchema = z
  .object({
    message: z
      .object({
        content: z.string().optional(),
        thinking: z.string().optional(),
      })
      .optional(),
    response: z.string().optional(),
    done_reason: z.string().optional(),
    prompt_eval_count: z.number().optional(),
    eval_count: z.number().optional(),
  })
  .passthrough();

export async function generateWedgeOllamaDecision(params: {
  systemPrompt: string;
  userText: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<WedgeDecision> {
  const first = await callOllama({
    ...params,
    userText: `${params.userText}\n\nJSONだけを返すこと。`,
  });
  const parsed = parseDecision(first.text);
  if (parsed.ok) {
    return parsed.decision;
  }
  const repaired = await callOllama({
    ...params,
    userText: [
      "前回の出力は指定JSON schemaに合わない。",
      `parse_error=${parsed.error}`,
      "前回出力:",
      first.text,
      "正しいJSONだけを返すこと。",
    ].join("\n"),
  });
  const reparsed = parseDecision(repaired.text);
  if (reparsed.ok) {
    return reparsed.decision;
  }
  return fallbackDecision(`json_parse_failed: ${reparsed.error}`);
}

export async function generateWedgeOllamaReply(params: {
  systemPrompt: string;
  userText: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<string> {
  const response = await callOllama(params);
  return response.text || "ワシ、言葉、出ない";
}

function parseDecision(text: string):
  | { ok: true; decision: WedgeDecision }
  | { ok: false; error: string } {
  try {
    const json = extractJson(text);
    return { ok: true, decision: WedgeDecisionSchema.parse(JSON.parse(json)) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function fallbackDecision(reason: string): WedgeDecision {
  return {
    thought_summary: reason,
    triage: "continue",
    request_level: 0,
    offering: {
      present: false,
      accepted: false,
      name: null,
      quantity: 0,
      satisfaction: 0,
      notes: null,
    },
    actions: [{ type: "none", reason }],
    continue_loop: false,
  };
}

async function callOllama(params: {
  systemPrompt: string;
  userText: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<{ text: string }> {
  const controller = new AbortController();
  const timeoutMs = params.timeoutMs ?? 45_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const model = params.model ?? process.env.WEDGE_OLLAMA_MODEL ?? "gemma4:latest";
  const debug = process.env.WEDGE_DEBUG_LLM !== "0";
  try {
    const baseUrl = (params.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434")
      .trim()
      .replace(/\/+$/, "");
    if (debug) {
      console.log(
        `[wedge:llm] request model=${model} timeoutMs=${timeoutMs} systemSha=${digest(params.systemPrompt)} systemChars=${params.systemPrompt.length} user=${JSON.stringify(truncate(params.userText, 500))}`,
      );
      console.log(`[wedge:llm] system-preview=${JSON.stringify(truncate(params.systemPrompt, 1400))}`);
    }
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        think: false,
        format: "json",
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userText },
        ],
        options: {
          num_predict: 1024,
          temperature: 0.4,
        },
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`ollama http ${response.status}`);
    }
    const parsed = OllamaChatResponseSchema.parse(await response.json());
    const text = (parsed.message?.content ?? parsed.response ?? "").trim();
    if (debug) {
      console.log(
        `[wedge:llm] response done=${parsed.done_reason ?? "unknown"} promptTokens=${parsed.prompt_eval_count ?? "unknown"} evalTokens=${parsed.eval_count ?? "unknown"} thinking=${JSON.stringify(truncate(parsed.message?.thinking ?? "", 800))} content=${JSON.stringify(truncate(text, 1600))}`,
      );
    }
    return { text };
  } finally {
    clearTimeout(timeout);
  }
}

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    return trimmed;
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }
  throw new Error("No JSON object found in LLM output.");
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 12);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...<truncated ${text.length - maxLength} chars>`;
}
