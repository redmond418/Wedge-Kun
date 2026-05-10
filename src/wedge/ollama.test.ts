import { afterEach, describe, expect, it, vi } from "vitest";
import { generateWedgeOllamaDecision } from "./ollama.js";

function response(content: string) {
  return {
    ok: true,
    json: async () => ({ message: { content }, done_reason: "stop" }),
  } as Response;
}

describe("generateWedgeOllamaDecision", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not append JSON instructions to the original user message", async () => {
    const fetchMock = vi.fn(async () =>
      response(
        JSON.stringify({
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
          actions: [{ type: "discord_send_message", target_channel_id: "c1", content: "ワシ、いる。" }],
          continue_loop: false,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await generateWedgeOllamaDecision({
      systemPrompt: "system",
      userText: "調子はどう？",
      fallbackChannelId: "c1",
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.messages.at(-1)?.content).toBe("調子はどう？");
  });

  it("normalizes legacy none without repair", async () => {
    const fetchMock = vi.fn(async () => response(JSON.stringify({ action: "none" })));
    vi.stubGlobal("fetch", fetchMock);

    const decision = await generateWedgeOllamaDecision({
      systemPrompt: "system",
      userText: "起きてる？",
      fallbackChannelId: "c1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decision).toMatchObject({
      internal_source: "legacy_normalized",
      request_level: 0,
      actions: [{ type: "none" }],
    });
  });

  it("normalizes legacy send_message for non-request chatter", async () => {
    const fetchMock = vi.fn(async () =>
      response(JSON.stringify({ action: "send_message", content: "ああ、起きてる。" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const decision = await generateWedgeOllamaDecision({
      systemPrompt: "system",
      userText: "起きてる？",
      fallbackChannelId: "c1",
      fallbackReplyToMessageId: "m1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decision.actions[0]).toMatchObject({
      type: "discord_send_message",
      target_channel_id: "c1",
      reply_to_message_id: "m1",
      content: "ああ、起きてる。",
    });
  });

  it("does not normalize legacy send_message for artifact requests", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ action: "send_message", content: "待っててね。" })))
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            thought_summary: "供物を受け取り、依頼を実行する。",
            interpretation: {
              user_intent: "供物つきの俳句作成依頼",
              referents: ["ビーフジャーキー"],
              actor: "wedge",
              confidence: 0.9,
              ambiguity: null,
            },
            triage: "continue",
            request_level: 3,
            offering: { present: true, accepted: true, name: "ビーフジャーキー", quantity: 1, satisfaction: 6, notes: null },
            actions: [
              { type: "nest_stash", name: "ビーフジャーキー", quantity: 1, notes: "俳句の対価。" },
              { type: "discord_send_message", target_channel_id: "c1", content: "ワシ、詠む。" },
            ],
            continue_loop: false,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const decision = await generateWedgeOllamaDecision({
      systemPrompt: "system",
      userText: "ビーフジャーキーあげる。なんでもいいから俳句を詠んでほしい",
      fallbackChannelId: "c1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(decision).toMatchObject({ internal_source: "repair" });
    expect(JSON.stringify(decision)).not.toContain("待っててね");
  });

  it("normalizes thought and response for non-request chatter", async () => {
    const fetchMock = vi.fn(async () => response(JSON.stringify({ thought: "返す。", response: "ワシ、いる。" })));
    vi.stubGlobal("fetch", fetchMock);

    const decision = await generateWedgeOllamaDecision({
      systemPrompt: "system",
      userText: "起きてる？",
      fallbackChannelId: "c1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(decision.actions[0]).toMatchObject({ type: "discord_send_message", content: "ワシ、いる。" });
  });

  it("repairs malformed JSON once with isolated repair prompt", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ action: "unknown_bad" })))
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            thought_summary: "修復済みの返信を返す。",
            interpretation: {
              user_intent: "挨拶",
              referents: [],
              actor: "wedge",
              confidence: 0.5,
              ambiguity: null,
            },
            triage: "continue",
            request_level: 0,
            offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
            actions: [{ type: "discord_send_message", target_channel_id: "c1", content: "直した。" }],
            continue_loop: false,
          }),
        ),
      );
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
    expect(repairBody.messages[1]?.content).toContain("raw_output");
    expect(decision).toMatchObject({ internal_source: "repair" });
    expect(decision.actions[0]).toMatchObject({ type: "discord_send_message", content: "直した。" });
  });

  it("does not treat repair prompt output as a user request", async () => {
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

    const decision = await generateWedgeOllamaDecision({
      systemPrompt: "system",
      userText: "こんにちは",
      fallbackChannelId: "c1",
      fallbackReplyToMessageId: "m1",
    });

    expect(decision).toMatchObject({
      internal_source: "fallback",
      request_level: 0,
      actions: [
        {
          type: "discord_send_message",
          target_channel_id: "c1",
          reply_to_message_id: "m1",
        },
      ],
    });
    expect(JSON.stringify(decision)).not.toContain("くれるモノ");
  });

  it("falls back to a Discord message when repair fails", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(JSON.stringify({ action: "unknown_bad" })))
      .mockResolvedValueOnce(response(JSON.stringify({ action: "still_bad" })));
    vi.stubGlobal("fetch", fetchMock);

    const decision = await generateWedgeOllamaDecision({
      systemPrompt: "system",
      userText: "こんにちは",
      fallbackChannelId: "c1",
      fallbackReplyToMessageId: "m1",
    });

    expect(decision.actions[0]).toMatchObject({
      type: "discord_send_message",
      target_channel_id: "c1",
      reply_to_message_id: "m1",
    });
  });
});
