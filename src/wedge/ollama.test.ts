import { afterEach, describe, expect, it, vi } from "vitest";
import { generateWedgeOllamaDecision } from "./ollama.js";

function response(content: string) {
  return {
    ok: true,
    json: async () => ({ message: { content }, done_reason: "stop" }),
  } as Response;
}

function validDecision(content = "ワシ、いる。") {
  return JSON.stringify({
    thought_summary: "短く返信する。",
    interpretation: {
      user_intent: "挨拶",
      referents: [],
      actor: "wedge",
      confidence: 1,
      ambiguity: null,
    },
    triage: "continue",
    request_level: 0,
    offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
    actions: [{ type: "discord_send_message", target_channel_id: "c1", content }],
    continue_loop: false,
  });
}

describe("generateWedgeOllamaDecision", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("does not append JSON instructions to the original user message", async () => {
    const fetchMock = vi.fn(async () => response(validDecision()));
    vi.stubGlobal("fetch", fetchMock);

    await generateWedgeOllamaDecision({
      systemPrompt: "system",
      userText: "調子はどう？",
      fallbackChannelId: "c1",
    });

    const fetchCalls = fetchMock.mock.calls as unknown as Array<[string, { body?: string }]>;
    const body = JSON.parse(String(fetchCalls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
      format: unknown;
      keep_alive: unknown;
    };
    expect(body.messages.at(-1)?.content).toBe("調子はどう？");
    expect(body.format).toMatchObject({ type: "object" });
    expect(body.keep_alive).toBe("0");
  });

  it("retries the same decision prompt before repair", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ action: "unknown_bad" })))
      .mockResolvedValueOnce(response(validDecision("ワシ、いる。")));
    vi.stubGlobal("fetch", fetchMock);

    const decision = await generateWedgeOllamaDecision({
      systemPrompt: "system",
      userText: "起きてる？",
      fallbackChannelId: "c1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as { messages: unknown[] };
    const retryBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { messages: unknown[] };
    expect(retryBody.messages).toEqual(firstBody.messages);
    expect(decision.internal_source).toBeUndefined();
    expect(decision.actions[0]).toMatchObject({ type: "discord_send_message", content: "ワシ、いる。" });
  });

  it("repairs malformed JSON with an isolated repair prompt", async () => {
    vi.stubEnv("WEDGE_OLLAMA_FORMAT_RETRIES", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ action: "unknown_bad" })))
      .mockResolvedValueOnce(response(validDecision("直した。")));
    vi.stubGlobal("fetch", fetchMock);

    const decision = await generateWedgeOllamaDecision({
      systemPrompt: "persona and offering rules must not be reused",
      userText: "こんにちは",
      fallbackChannelId: "c1",
    });

    const repairBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(repairBody.messages[0]?.content).not.toContain("persona");
    expect(repairBody.messages[0]?.content).not.toContain("供物");
    expect(repairBody.messages[1]?.content).toContain("raw_outputs");
    expect(decision).toMatchObject({ internal_source: "repair" });
    expect(decision.actions[0]).toMatchObject({ type: "discord_send_message", content: "直した。" });
  });

  it("throws when repair output interprets the repair task as a user request", async () => {
    vi.stubEnv("WEDGE_OLLAMA_FORMAT_RETRIES", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ action: "unknown_bad" })))
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            thought_summary: "前回のLLM出力をschemaに修復する依頼として扱う。",
            interpretation: {
              user_intent: "前回のLLM出力を指定されたWedgeDecision JSON schemaに修復すること。",
              referents: ["前回のLLM出力"],
              actor: "user",
              confidence: 1,
              ambiguity: null,
            },
            triage: "continue",
            request_level: 10,
            offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
            actions: [{ type: "none", reason: "内部修復なので外部 action は不要。" }],
            continue_loop: false,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateWedgeOllamaDecision({
        systemPrompt: "system",
        userText: "こんにちは",
        fallbackChannelId: "c1",
        fallbackReplyToMessageId: "m1",
      }),
    ).rejects.toThrow("wedge_llm_json_failed");
  });

  it("throws without sending a fallback decision when repair fails", async () => {
    vi.stubEnv("WEDGE_OLLAMA_FORMAT_RETRIES", "0");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ action: "unknown_bad" })))
      .mockResolvedValueOnce(response(JSON.stringify({ action: "still_bad" })));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      generateWedgeOllamaDecision({
        systemPrompt: "system",
        userText: "こんにちは",
        fallbackChannelId: "c1",
        fallbackReplyToMessageId: "m1",
      }),
    ).rejects.toThrow("wedge_llm_json_failed");
  });
});
