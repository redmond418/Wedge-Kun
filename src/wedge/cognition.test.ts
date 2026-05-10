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

describe("runWedgeCognitionLoop", () => {
  afterEach(() => {
    decisions.length = 0;
    vi.resetModules();
  });

  it("stops at the configured iteration limit", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    const { openWedgeDatabase } = await import("./storage.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-loop-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    try {
      for (let i = 0; i < 3; i += 1) {
        decisions.push({
          thought_summary: `step ${i}`,
          interpretation: {
            user_intent: "継続",
            referents: [],
            actor: "wedge",
            confidence: 1,
            ambiguity: null,
          },
          triage: "continue",
          request_level: 0,
          offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
          actions: [{ type: "nest_look" }],
          continue_loop: true,
        });
      }

      const result = await runWedgeCognitionLoop({
        db,
        maxIterations: 3,
        trigger: { kind: "local_chat", channelId: "c1", userId: "u1", text: "続けて" },
      });

      expect(result).toMatchObject({ iterations: 3, actionCount: 3 });
      expect(db.listRecentLogs("c1").at(-1)?.content).toContain("iteration limit");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("replaces underpaid request output with an offering prompt", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    const { openWedgeDatabase } = await import("./storage.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-offering-gate-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    const sent: string[] = [];
    try {
      decisions.push({
        thought_summary: "供物なしで物語を出そうとしている。",
        interpretation: {
          user_intent: "物語を聞きたい",
          referents: [],
          actor: "wedge",
          confidence: 1,
          ambiguity: null,
        },
        triage: "continue",
        request_level: 3,
        offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
        actions: [{ type: "discord_send_message", target_channel_id: "c1", content: "昔..." }],
        continue_loop: false,
      });

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
      expect(sent[0]).toContain("くれるモノ");
      expect(sent[0]).not.toContain("昔");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not offering-gate fallback decisions", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    const { openWedgeDatabase } = await import("./storage.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-fallback-gate-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    const sent: string[] = [];
    try {
      decisions.push({
        thought_summary: "LLM出力の形式修復に失敗したため、安全な短文で返信する。",
        interpretation: {
          user_intent: "形式崩れにより判定不能",
          referents: [],
          actor: "unclear",
          confidence: 0,
          ambiguity: "parse failed",
        },
        triage: "continue",
        request_level: 0,
        offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
        actions: [{ type: "discord_send_message", target_channel_id: "c1", content: "ワシ、言葉、形、崩れた。" }],
        continue_loop: false,
        internal_source: "fallback",
      });

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

      expect(result).toMatchObject({ finalTriage: "continue", actionCount: 1 });
      expect(sent[0]).toContain("形");
      expect(sent[0]).not.toContain("くれるモノ");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not offering-gate chitchat even when the model invents a request level", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    const { openWedgeDatabase } = await import("./storage.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-chitchat-gate-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    const sent: string[] = [];
    try {
      decisions.push({
        thought_summary: "雑談を誤って作業依頼として扱っている。",
        interpretation: {
          user_intent: "Greeting and small talk",
          referents: ["weather"],
          actor: "user",
          confidence: 1,
          ambiguity: null,
        },
        triage: "continue",
        request_level: 3,
        offering: {
          present: true,
          accepted: false,
          name: "conversation_continuation_response",
          quantity: 1,
          satisfaction: 0,
          notes: "not a real offering",
        },
        actions: [
          {
            type: "discord_send_message",
            target_channel_id: "c1",
            content: "ワシ、起きた。空、よさそう。",
          },
        ],
        continue_loop: false,
      });

      const result = await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "おはよう、今日もいい天気だね" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(result).toMatchObject({ finalTriage: "continue", actionCount: 1 });
      expect(sent[0]).toContain("空");
      expect(sent[0]).not.toContain("くれるモノ");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops non-expanding loops and replaces invalid no-op profile updates for chitchat", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    const { openWedgeDatabase } = await import("./storage.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-noop-loop-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    const sent: string[] = [];
    try {
      decisions.push({
        thought_summary: "雑談なのに不要なprofile更新と再思考を選んでいる。",
        interpretation: {
          user_intent: "Check-in",
          referents: [],
          actor: "user",
          confidence: 1,
          ambiguity: null,
        },
        triage: "continue",
        request_level: 1,
        offering: {
          present: true,
          accepted: false,
          name: "acknowledgement_and_redirection_to_core_topic",
          quantity: 1,
          satisfaction: 0,
          notes: null,
        },
        actions: [{ type: "update_user_profile", user_id: "N/A", details: "No profile update needed." }],
        continue_loop: true,
      });

      const result = await runWedgeCognitionLoop({
        db,
        trigger: { kind: "local_chat", channelId: "c1", messageId: "m1", userId: "u1", text: "大丈夫？" },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(result).toMatchObject({ iterations: 1, finalTriage: "continue", actionCount: 1 });
      expect(sent[0]).not.toContain("くれるモノ");
      expect(sent[0]).toContain("ワシ");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recovers explicit offerings when the model misses them", async () => {
    const { runWedgeCognitionLoop } = await import("./cognition.js");
    const { openWedgeDatabase } = await import("./storage.js");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-offering-recover-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    const sent: string[] = [];
    try {
      decisions.push({
        thought_summary: "供物つき依頼だが供物を見落としている。",
        interpretation: {
          user_intent: "俳句を詠む依頼",
          referents: ["ビーフジャーキー"],
          actor: "wedge",
          confidence: 1,
          ambiguity: null,
        },
        triage: "continue",
        request_level: 3,
        offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
        actions: [
          {
            type: "discord_send_message",
            target_channel_id: "c1",
            content: "干し肉や 風の端っこ 噛む夜ぞ",
          },
        ],
        continue_loop: false,
      });
      decisions.push({
        thought_summary: "供物を巣にしまったので依頼を実行する。",
        interpretation: {
          user_intent: "俳句を詠む依頼",
          referents: ["ビーフジャーキー"],
          actor: "wedge",
          confidence: 1,
          ambiguity: null,
        },
        triage: "continue",
        request_level: 3,
        offering: { present: true, accepted: true, name: "ビーフジャーキー", quantity: 1, satisfaction: 3, notes: null },
        actions: [
          {
            type: "discord_send_message",
            target_channel_id: "c1",
            content: "干し肉や 風の端っこ 噛む夜ぞ",
          },
        ],
        continue_loop: false,
      });

      const result = await runWedgeCognitionLoop({
        db,
        trigger: {
          kind: "local_chat",
          channelId: "c1",
          messageId: "m1",
          userId: "u1",
          text: "ビーフジャーキーあげる。なんでもいいから俳句を詠んでほしい",
        },
        runtime: {
          sendDiscordMessage: async ({ content }) => {
            sent.push(content);
            return { ok: true };
          },
        },
      });

      expect(result).toMatchObject({ iterations: 2, finalTriage: "continue", actionCount: 2 });
      expect(sent[0]).toContain("干し肉");
      expect(sent[0]).not.toContain("くれるモノ");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
