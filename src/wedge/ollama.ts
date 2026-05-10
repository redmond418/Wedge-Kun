import { createHash } from "node:crypto";
import { z } from "zod";
import {
  WedgeDecisionSchema,
  wedgeDecisionOllamaFormatSchema,
  wedgeDecisionJsonSchemaDescription,
  type WedgeDecision,
} from "./cognition-schema.js";

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

type ParseDefaults = {
  channelId?: string;
  replyToMessageId?: string | null;
  userText?: string;
};

export type WedgeLlmDebugEvent = {
  phase:
    | "raw_output"
    | "retry_raw_output"
    | "schema_parse_failed"
    | "repair_raw_output"
    | "repair_failed";
  text?: string;
  error?: string;
};

export async function generateWedgeOllamaDecision(params: {
  systemPrompt: string;
  userText: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fallbackChannelId?: string;
  fallbackReplyToMessageId?: string | null;
  allowRepair?: boolean;
  onDebug?: (event: WedgeLlmDebugEvent) => void;
}): Promise<WedgeDecision> {
  const defaults = {
    channelId: params.fallbackChannelId,
    replyToMessageId: params.fallbackReplyToMessageId,
    userText: params.userText,
  };
  const first = await callOllama({ ...params, useWedgeDecisionSchema: true });
  params.onDebug?.({ phase: "raw_output", text: first.text });
  let parsed = parseDecision(first.text, defaults);
  if (parsed.ok) {
    return parsed.decision;
  }

  const failedOutputs = [first.text];
  const maxRetries = Number.parseInt(process.env.WEDGE_OLLAMA_FORMAT_RETRIES ?? "2", 10);
  for (let attempt = 1; attempt <= Math.max(0, maxRetries); attempt += 1) {
    params.onDebug?.({ phase: "schema_parse_failed", error: parsed.error, text: failedOutputs.at(-1) });
    console.warn(`[wedge:llm] schema parse failed attempt=${attempt}: ${truncate(parsed.error, 600)}`);
    const retry = await callOllama({ ...params, useWedgeDecisionSchema: true });
    params.onDebug?.({ phase: "retry_raw_output", text: retry.text });
    failedOutputs.push(retry.text);
    parsed = parseDecision(retry.text, defaults);
    if (parsed.ok) {
      return parsed.decision;
    }
  }

  params.onDebug?.({ phase: "schema_parse_failed", error: parsed.error, text: first.text });
  console.warn(`[wedge:llm] schema parse failed: ${truncate(parsed.error, 600)}`);
  if (params.allowRepair === false) {
    throw new Error(`wedge_llm_json_failed: ${parsed.error}`);
  }
  const repaired = await callOllama({
    model: params.model,
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
    useWedgeDecisionSchema: true,
    systemPrompt: [
      "You are a strict JSON repair function.",
      "Convert invalid model output into the WedgeDecision JSON schema.",
      "This is an internal parser recovery call, not a user request.",
      "Do not roleplay. Do not ask for offerings. Do not interpret this repair task as the user's intent.",
      "Return exactly one JSON object and nothing else.",
    ].join("\n"),
    userText: JSON.stringify(
      {
        raw_outputs: failedOutputs,
        parse_error: parsed.error,
        original_user_text: params.userText,
        defaults: {
          target_channel_id: params.fallbackChannelId ?? "unknown",
          reply_to_message_id: params.fallbackReplyToMessageId ?? null,
        },
        target_schema: wedgeDecisionJsonSchemaDescription(),
      },
      null,
      2,
    ),
  });
  params.onDebug?.({ phase: "repair_raw_output", text: repaired.text });
  const reparsed = parseDecision(repaired.text, defaults);
  if (reparsed.ok && !isRepairMetaDecision(reparsed.decision) && !hasUnsafeRepairedUserMessage(reparsed.decision)) {
    return { ...reparsed.decision, internal_source: "repair" };
  }

  const repairError = reparsed.ok
    ? "repair_output_interpreted_internal_repair_prompt_or_unsafe_user_message"
    : reparsed.error;
  params.onDebug?.({ phase: "repair_failed", error: repairError, text: repaired.text });
  console.warn(`[wedge:llm] repair failed: ${truncate(repairError, 600)}`);
  throw new Error(`wedge_llm_json_failed: ${repairError}`);
}

export async function generateWedgeOllamaReply(params: {
  systemPrompt: string;
  userText: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<string> {
  const response = await callOllama(params);
  return response.text || "ワシ、言葉、出ない。";
}

export async function unloadWedgeOllamaModel(params: {
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
} = {}): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), params.timeoutMs ?? 10_000);
  try {
    const model = params.model ?? process.env.WEDGE_OLLAMA_MODEL ?? "gemma4:latest";
    const baseUrl = (params.baseUrl ?? process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434")
      .trim()
      .replace(/\/+$/, "");
    await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [],
        stream: false,
        keep_alive: 0,
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function describeWedgeOllamaReset(): string {
  return [
    "Ollama /api/chat は送信した messages 配列を会話履歴として扱う。",
    "Wedge は毎回 system と user の2件だけを送るため、Ollamaサーバー側の会話履歴は使っていない。",
    "モデル常駐を避けて完全に冷やすには keep_alive=0 を送るか、ollama stop <model> を実行する。",
    "Wedge は既定で keep_alive=0 を送る。速度優先なら WEDGE_OLLAMA_KEEP_ALIVE=5m などで上書きできる。",
  ].join("\n");
}

function parseDecision(
  text: string,
  defaults: ParseDefaults,
): { ok: true; decision: WedgeDecision } | { ok: false; error: string } {
  try {
    const json = extractJson(text);
    const raw = JSON.parse(json) as unknown;
    const normalized = normalizeDecisionCandidate(raw, defaults);
    return { ok: true, decision: WedgeDecisionSchema.parse(normalized) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function normalizeDecisionCandidate(candidate: unknown, defaults: ParseDefaults): unknown {
  if (!isRecord(candidate)) {
    return candidate;
  }
  const root: Record<string, unknown> = { ...candidate };
  if (typeof root.continue_loop !== "boolean") {
    root.continue_loop = false;
  }
  if (Array.isArray(root.actions)) {
    root.actions = root.actions.map((action) => normalizeActionCandidate(action, defaults));
  }
  return root;
}

function normalizeActionCandidate(action: unknown, defaults: ParseDefaults): unknown {
  if (!isRecord(action) || action.type !== "discord_send_message") {
    return action;
  }
  const normalized: Record<string, unknown> = { ...action };
  const content =
    stringValue(normalized.content) ??
    stringValue(normalized.target_message) ??
    stringValue(normalized.target_message_context);
  if (content) {
    normalized.content = content;
  }
  normalized.target_channel_id =
    normalizeChannelId(stringValue(normalized.target_channel_id), defaults.channelId);
  normalized.reply_to_message_id =
    stringValue(normalized.reply_to_message_id) ?? defaults.replyToMessageId ?? null;
  delete normalized.target_message;
  delete normalized.target_message_context;
  return normalized;
}

function normalizeChannelId(value: string | undefined, fallback: string | undefined): string {
  const trimmed = value?.trim();
  if (
    !trimmed ||
    trimmed === "N/A" ||
    trimmed === "unknown" ||
    trimmed === "channel_id" ||
    trimmed === "channel_id_placeholder" ||
    trimmed === "..."
  ) {
    return fallback ?? "unknown";
  }
  return trimmed;
}

function isRepairMetaDecision(decision: WedgeDecision): boolean {
  const haystack = [
    decision.thought_summary,
    decision.interpretation.user_intent,
    decision.interpretation.ambiguity ?? "",
    ...decision.interpretation.referents,
  ].join("\n");
  const mentionsRepairTask = /schema|スキーマ|JSON|修復|LLM出力|parse_error|raw_output|前回の出力/.test(haystack);
  const hasOnlyNoOp = decision.actions.every((action) => action.type === "none");
  const asksForRepairAsTask = decision.request_level >= 8 && mentionsRepairTask;
  return hasOnlyNoOp && asksForRepairAsTask;
}

function hasUnsafeRepairedUserMessage(decision: WedgeDecision): boolean {
  return decision.actions.some((action) => {
    if (action.type !== "discord_send_message") {
      return false;
    }
    const asciiLetters = action.content.match(/[A-Za-z]/g)?.length ?? 0;
    const japanese = action.content.match(/[\u3040-\u30ff\u3400-\u9fff]/g)?.length ?? 0;
    return asciiLetters > 20 && asciiLetters > japanese;
  });
}

async function callOllama(params: {
  systemPrompt: string;
  userText: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  useWedgeDecisionSchema?: boolean;
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
        format: params.useWedgeDecisionSchema ? wedgeDecisionOllamaFormatSchema() : "json",
        keep_alive: process.env.WEDGE_OLLAMA_KEEP_ALIVE ?? "0",
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userText },
        ],
        options: {
          num_ctx: Number.parseInt(process.env.WEDGE_OLLAMA_NUM_CTX ?? "8192", 10),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
