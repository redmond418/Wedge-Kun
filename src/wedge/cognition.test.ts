import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WedgeDecision } from "./cognition-schema.js";

const decisions: WedgeDecision[] = [];

vi.mock("./ollama.js", () => ({
  generateWedgeOllamaDecision: vi.fn(async () => {
    const decision = decisions.shift();
    if (!decision) {
      throw new Error("missing test decision");
    }
    return decision;
  }),
}));

function decision(overrides: Partial<WedgeDecision>): WedgeDecision {
  return {
    thought_summary: "LLMが判断する。",
    interpretation: {
      user_intent: "会話",
      referents: [],
      actor: "wedge",
      confidence: 1,
      ambiguity: null,
    },
    triage: "continue",
    request_level: 0,
    offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
    actions: [],
    continue_loop: false,
    ...overrides,
  };
}

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof import("./storage.js").openWedgeDatabase>>) => Promise<T>) {
  const { openWedgeDatabase } = await import("./storage.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-cognition-"));
  const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
  try {
    return await fn(db);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe("runWedgeCognitionLoop", () => {
  afterEach(() => {
    decisions.length = 0;
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("fails instead of sending a fixed fallback at the iteration limit", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      for (let i = 0; i < 3; i += 1) {
        decisions.push(decision({ actions: [{ type: "nest_stash", name: `石-${i}`, quantity: 1, notes: "loop test" }], continue_loop: true }));
      }

      await expect(
        runWedgeCognitionLoop({
          db,
          maxIterations: 3,
          trigger: { kind: "local_chat", channelId: "c1", userId: "u1", text: "続けて" },
        }),
      ).rejects.toThrow("wedge_cognition_loop_limit");
      expect(db.listRecentLogs("c1").at(-1)?.content).toContain("iteration limit");
    });
  });

  it("uses the LLM-generated block message and stores pending_request", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      const sent: string[] = [];
      decisions.push(
        decision({
          thought_summary: "供物がないので催促する。",
          triage: "block",
          request_level: 3,
          actions: [{ type: "discord_send_message", target_channel_id: "c1", content: "それ、ワシの腹、動かん。何か寄越せ。" }],
        }),
      );

      const result = await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "物語を話して" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(result).toMatchObject({ finalTriage: "block", actionCount: 1 });
      expect(sent[0]).toBe("それ、ワシの腹、動かん。何か寄越せ。");
      expect(db.getConversationState("c1").pendingRequest?.text).toBe("物語を話して");
    });
  });

  it("fulfills pending_request only from an LLM decision", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      const sent: string[] = [];
      const runtime = {
        sendDiscordMessage: async ({ content }: { content: string }) => {
          sent.push(content);
          return { ok: true };
        },
      };
      db.setConversationState("c1", {
        pendingRequest: {
          text: "短い昔話を話して",
          userId: "u1",
          userName: "u1",
          messageId: "m1",
          requestLevel: 3,
          createdAt: Date.now(),
        },
      });
      decisions.push(
        decision({
          thought_summary: "供物で未完了依頼を実行する。",
          request_level: 3,
          offering: { present: true, accepted: true, name: "濃いラーメン", quantity: 1, satisfaction: 4, notes: "昔話の対価" },
          actions: [
            { type: "nest_stash", name: "濃いラーメン", quantity: 1, notes: "昔話の対価" },
            {
              type: "discord_send_message",
              target_channel_id: "c1",
              content:
                "昔、穴の底に小さな灯りがあった。誰も近づかんかったが、ワシだけ見に行った。灯りは腹を空かせていて、影を少し食った。次の朝、村の影は丸くなった。ニンゲンども、それから穴に挨拶するようになった。"
                + "ワシはその穴を巣にした。灯りは今も、ときどき笑う。",
            },
          ],
        }),
      );

      const result = await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m2", userId: "u1", text: "ラーメンあげる" },
        runtime,
      });

      expect(result).toMatchObject({ finalTriage: "continue", actionCount: 2 });
      expect(db.getConversationState("c1").pendingRequest).toBeUndefined();
      expect(db.listNestItems()[0]?.name).toBe("濃いラーメン");
      expect(sent[0]).toContain("灯り");
    });
  });

  it("lets the LLM use nest_look, then lets the next LLM turn explain the tool result", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      db.upsertNestItem({ name: "ドーナツ", quantity: 2, notes: null });
      const sent: string[] = [];
      decisions.push(
        decision({
          thought_summary: "巣を見る。",
          actions: [{ type: "nest_look" }],
          continue_loop: true,
        }),
      );
      decisions.push(
        decision({
          thought_summary: "巣の中身を説明する。",
          actions: [{ type: "discord_send_message", target_channel_id: "c1", content: "巣、ドーナツ二つ。ワシの宝。" }],
          continue_loop: false,
        }),
      );

      const result = await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "巣の中に何がある？" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(result).toMatchObject({ iterations: 2, actionCount: 2 });
      expect(sent[0]).toContain("ドーナツ");
    });
  });

  it("treats LLM text with a stray continue_loop as a structural protocol fix", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      const sent: string[] = [];
      decisions.push(
        decision({
          thought_summary: "返信は決まっているが誤って続行にした。",
          actions: [{ type: "discord_send_message", target_channel_id: "c1", content: "まだ起きてる。" }],
          continue_loop: true,
        }),
      );
      const result = await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "起きてる？" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(result).toMatchObject({ iterations: 1, actionCount: 1 });
      expect(sent).toEqual(["まだ起きてる。"]);
    });
  });

  it("asks the LLM to redo artifact replies that only promise future output", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      const sent: string[] = [];
      decisions.push(
        decision({
          thought_summary: "供物を受け取ったが予告だけで終わっている。",
          request_level: 5,
          offering: { present: true, accepted: true, name: "菓子", quantity: 1, satisfaction: 6, notes: "創作の対価" },
          actions: [
            { type: "nest_stash", name: "菓子", quantity: 1, notes: "創作の対価" },
            { type: "discord_send_message", target_channel_id: "c1", content: "詠んでやる。楽しみに待て。" },
          ],
          continue_loop: false,
        }),
      );
      decisions.push(
        decision({
          thought_summary: "成果物本文を含めて返す。",
          request_level: 5,
          offering: { present: true, accepted: true, name: "菓子", quantity: 1, satisfaction: 6, notes: "創作の対価" },
          actions: [
            { type: "nest_stash", name: "菓子", quantity: 1, notes: "創作の対価" },
            { type: "discord_send_message", target_channel_id: "c1", content: "菓子、受け取った。\n穴の底\n甘い光が\nワシを呼ぶ" },
          ],
          continue_loop: false,
        }),
      );

      const result = await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "お菓子あげるから俳句を詠んで" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(result).toMatchObject({ iterations: 1, actionCount: 2 });
      expect(sent[0]).toContain("穴の底");
      expect(sent[0]).not.toContain("楽しみに待て");
    });
  });

  it("does not feed rejected user-facing content back as conversation fact during protocol redo", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    const { generateWedgeOllamaDecision } = await import("./ollama.js");
    await withDb(async (db) => {
      const sent: string[] = [];
      db.upsertNestItem({ name: "豚骨ラーメン", quantity: 1, notes: null });
      decisions.push(
        decision({
          thought_summary: "消費するが予告だけで終わっている。",
          request_level: 5,
          actions: [
            { type: "nest_consume", name: "豚骨ラーメン", quantity: 1, reason: "味を見る。" },
            { type: "discord_send_message", target_channel_id: "c1", content: "ワシ、待ってろ。" },
          ],
          continue_loop: false,
        }),
      );
      decisions.push(
        decision({
          thought_summary: "実行済みの消費結果を見て感想を返す。",
          request_level: 5,
          actions: [{ type: "discord_send_message", target_channel_id: "c1", content: "食った。濃い。脂、強い。骨の匂い、悪くない。" }],
          continue_loop: false,
        }),
      );

      await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "豚骨ラーメンを食べて、味を聞かせて" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      const calls = vi.mocked(generateWedgeOllamaDecision).mock.calls;
      const reflectPrompt = String(calls[1]?.[0].systemPrompt ?? "");
      expect(reflectPrompt).toContain("nest_consume");
      expect(reflectPrompt).not.toContain("ワシ、待ってろ。");
      expect(sent).toEqual(["食った。濃い。脂、強い。骨の匂い、悪くない。"]);
    });
  });

  it("asks the LLM to redo nest consumption that has no item target", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      const sent: string[] = [];
      db.upsertNestItem({ name: "ビーフジャーキー", quantity: 1, notes: null });
      decisions.push(
        decision({
          thought_summary: "対象を指定せず消費しようとしている。",
          request_level: 5,
          actions: [{ type: "nest_consume", quantity: 1, reason: "味を見る。" } as WedgeDecision["actions"][number]],
          continue_loop: false,
        }),
      );
      decisions.push(
        decision({
          thought_summary: "対象名を指定して消費し、感想を返す。",
          request_level: 5,
          actions: [
            { type: "nest_consume", name: "ビーフジャーキー", quantity: 1, reason: "味を見る。" },
            { type: "discord_send_message", target_channel_id: "c1", content: "噛んだ。肉、濃い。塩、効いてる。" },
          ],
          continue_loop: false,
        }),
      );

      await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "ビーフジャーキーを食べて味を聞かせて" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(db.listNestItems().find((item) => item.name === "ビーフジャーキー")?.quantity).toBe(0);
      expect(sent[0]).toContain("肉");
    });
  });

  it("allows nest consumption with a final taste reply without converting it to offering block", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      const sent: string[] = [];
      db.upsertNestItem({ name: "ビーフジャーキー", quantity: 1, notes: null });
      decisions.push(
        decision({
          thought_summary: "巣のアイテムを消費して味を返す。",
          request_level: 7,
          actions: [
            { type: "nest_consume", name: "ビーフジャーキー", quantity: 1, reason: "味を見る。" },
            { type: "discord_send_message", target_channel_id: "c1", content: "食った。硬い。肉の旨味、じわっと来る。" },
          ],
          continue_loop: false,
        }),
      );

      const result = await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "ビーフジャーキーを食べて、味を聞かせて" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(result.finalTriage).toBe("continue");
      expect(sent[0]).toContain("旨味");
      expect(db.listNestItems().find((item) => item.name === "ビーフジャーキー")?.quantity).toBe(0);
    });
  });

  it("keeps an LLM-authored offering prompt and structurally marks it as blocked", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      const sent: string[] = [];
      decisions.push(
        decision({
          thought_summary: "供物不足なので催促文を返す。",
          triage: "continue",
          request_level: 5,
          offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
          actions: [{ type: "discord_send_message", target_channel_id: "c1", content: "その話、タダでは出ん。対価、持ってこい。" }],
          continue_loop: false,
        }),
      );

      const result = await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "昔話を話して" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(result).toMatchObject({ finalTriage: "block", actionCount: 1 });
      expect(sent).toEqual(["その話、タダでは出ん。対価、持ってこい。"]);
      expect(db.getConversationState("c1").pendingRequest?.text).toBe("昔話を話して");
    });
  });

  it("fails rather than inventing a reply when protocol correction still loops without context tools", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      for (let index = 0; index < 6; index += 1) {
        decisions.push(
          decision({
            thought_summary: `何もしないのに続ける ${index}`,
            actions: [{ type: "none", reason: "会話返信が必要" }],
            continue_loop: true,
          }),
        );
      }

      await expect(
        runWedgeCognitionLoop({
          db,
          trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "大丈夫？" },
        }),
      ).rejects.toThrow("wedge_llm_protocol_invalid");
    });
  });

  it("does not invent a reply when the LLM JSON pipeline fails", async () => {
    vi.resetModules();
    vi.doMock("./ollama.js", () => ({
      generateWedgeOllamaDecision: vi.fn(async () => {
        throw new Error("wedge_llm_json_failed: bad json");
      }),
    }));
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    await withDb(async (db) => {
      const sent: string[] = [];
      await expect(
        runWedgeCognitionLoop({
          db,
          trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "こんにちは" },
          runtime: {
            sendDiscordMessage: async ({ content }) => {
              sent.push(content);
              return { ok: true };
            },
          },
        }),
      ).rejects.toThrow("wedge_llm_json_failed");
      expect(sent).toEqual([]);
    });
  });
});
