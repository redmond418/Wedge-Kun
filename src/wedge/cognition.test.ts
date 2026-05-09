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
});
