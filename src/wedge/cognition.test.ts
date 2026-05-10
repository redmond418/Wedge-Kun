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
          actions: [{ type: "none", reason: "keep looping" }],
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
});
