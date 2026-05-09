import { createHash } from "node:crypto";
import { z } from "zod";

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

export async function generateWedgeOllamaReply(params: {
  systemPrompt: string;
  userText: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<string> {
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
        messages: [
          { role: "system", content: params.systemPrompt },
          { role: "user", content: params.userText },
        ],
        options: {
          num_predict: 768,
          temperature: 0.75,
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
        `[wedge:llm] response done=${parsed.done_reason ?? "unknown"} promptTokens=${parsed.prompt_eval_count ?? "unknown"} evalTokens=${parsed.eval_count ?? "unknown"} thinking=${JSON.stringify(truncate(parsed.message?.thinking ?? "", 800))} content=${JSON.stringify(truncate(text, 1200))}`,
      );
    }
    return text || "ワシ、言葉、出ない";
  } finally {
    clearTimeout(timeout);
  }
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
