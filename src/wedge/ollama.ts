import { createHash } from "node:crypto";
import { z } from "zod";
import {
  WedgeDecisionSchema,
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
    | "legacy_normalized"
    | "schema_parse_failed"
    | "repair_raw_output"
    | "repair_failed"
    | "fallback_sent";
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
  onDebug?: (event: WedgeLlmDebugEvent) => void;
}): Promise<WedgeDecision> {
  const defaults = {
    channelId: params.fallbackChannelId,
    replyToMessageId: params.fallbackReplyToMessageId,
    userText: params.userText,
  };
  const first = await callOllama(params);
  params.onDebug?.({ phase: "raw_output", text: first.text });
  const parsed = parseDecision(first.text, defaults);
  if (parsed.ok) {
    if (parsed.decision.internal_source === "legacy_normalized") {
      params.onDebug?.({ phase: "legacy_normalized", text: first.text });
    }
    return parsed.decision;
  }

  params.onDebug?.({ phase: "schema_parse_failed", error: parsed.error, text: first.text });
  console.warn(`[wedge:llm] schema parse failed: ${truncate(parsed.error, 600)}`);
  const repaired = await callOllama({
    model: params.model,
    baseUrl: params.baseUrl,
    timeoutMs: params.timeoutMs,
    systemPrompt: [
      "You are a strict JSON repair function.",
      "Convert invalid model output into the WedgeDecision JSON schema.",
      "This is an internal parser recovery call, not a user request.",
      "Do not roleplay. Do not ask for offerings. Do not interpret this repair task as the user's intent.",
      "Return exactly one JSON object and nothing else.",
    ].join("\n"),
    userText: JSON.stringify(
      {
        raw_output: first.text,
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
  if (reparsed.ok && !isRepairMetaDecision(reparsed.decision)) {
    return { ...reparsed.decision, internal_source: "repair" };
  }

  const repairError = reparsed.ok
    ? "repair_output_interpreted_internal_repair_prompt_as_user_request"
    : reparsed.error;
  params.onDebug?.({ phase: "repair_failed", error: repairError, text: repaired.text });
  console.warn(`[wedge:llm] repair failed: ${truncate(repairError, 600)}`);
  params.onDebug?.({ phase: "fallback_sent", error: repairError });
  return fallbackDecision({
    reason: `json_parse_failed: ${repairError}`,
    channelId: params.fallbackChannelId,
    replyToMessageId: params.fallbackReplyToMessageId,
  });
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
  const legacy = legacyDecisionCandidate(candidate, defaults);
  if (legacy) {
    return legacy;
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

function legacyDecisionCandidate(candidate: Record<string, unknown>, defaults: ParseDefaults): WedgeDecision | null {
  const action = stringValue(candidate.action);
  const content =
    stringValue(candidate.content) ??
    stringValue(candidate.reply) ??
    stringValue(candidate.response) ??
    stringValue(candidate.output);
  const thought = stringValue(candidate.thought) ?? stringValue(candidate.thought_summary);
  const source = "legacy_normalized" as const;
  if (action === "none") {
    return {
      ...baseDecision(defaults, "簡易JSONをnone actionとして正規化する。", source),
      actions: [{ type: "none", reason: "legacy action none" }],
    };
  }
  if (content && estimateRequestLevel(defaults.userText ?? "") > 0) {
    return null;
  }
  if ((action === "send_message" || action === "reply") && content) {
    return legacyMessageDecision(defaults, content, thought, source);
  }
  if (content && (thought || stringValue(candidate.response) || stringValue(candidate.output))) {
    return legacyMessageDecision(defaults, content, thought, source);
  }
  return null;
}

function legacyMessageDecision(
  defaults: ParseDefaults,
  content: string,
  thought: string | undefined,
  source: "legacy_normalized",
): WedgeDecision {
  return {
    ...baseDecision(defaults, thought ?? "簡易JSONの返信本文をDiscord送信として正規化する。", source),
    actions: [
      {
        type: "discord_send_message",
        target_channel_id: defaults.channelId ?? "unknown",
        reply_to_message_id: defaults.replyToMessageId ?? null,
        content,
      },
    ],
  };
}

function baseDecision(
  defaults: ParseDefaults,
  thoughtSummary: string,
  source: "legacy_normalized" | "fallback",
): WedgeDecision {
  return {
    thought_summary: thoughtSummary,
    interpretation: {
      user_intent: defaults.userText ?? "判定不能",
      referents: [],
      actor: "wedge",
      confidence: 0.5,
      ambiguity: null,
    },
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
    actions: [],
    continue_loop: false,
    internal_source: source,
  };
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
    stringValue(normalized.target_channel_id) ?? defaults.channelId ?? "unknown";
  normalized.reply_to_message_id =
    stringValue(normalized.reply_to_message_id) ?? defaults.replyToMessageId ?? null;
  delete normalized.target_message;
  delete normalized.target_message_context;
  return normalized;
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

function fallbackDecision(params: {
  reason: string;
  channelId?: string;
  replyToMessageId?: string | null;
}): WedgeDecision {
  const channelId = params.channelId ?? "unknown";
  return {
    ...baseDecision(
      { channelId, replyToMessageId: params.replyToMessageId, userText: "形式崩れにより判定不能" },
      "LLM出力の形式修復に失敗したため、安全な短文で返信する。",
      "fallback",
    ),
    interpretation: {
      user_intent: "形式崩れにより判定不能",
      referents: [],
      actor: "unclear",
      confidence: 0,
      ambiguity: params.reason,
    },
    actions: [
      {
        type: "discord_send_message",
        target_channel_id: channelId,
        reply_to_message_id: params.replyToMessageId ?? null,
        content: "ワシ、言葉、形、崩れた。もう一回、言え。",
      },
    ],
  };
}

function estimateRequestLevel(text: string): number {
  if (/話して|詠んで|作って|調べて|判断して|説明して|見て|書いて|生成して|お願い|してほしい/.test(text)) {
    return 3;
  }
  return 0;
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
