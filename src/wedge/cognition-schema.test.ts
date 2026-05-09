import { describe, expect, it } from "vitest";
import { WedgeDecisionSchema } from "./cognition-schema.js";

describe("WedgeDecisionSchema", () => {
  it("accepts a valid JSON cognition decision", () => {
    const decision = WedgeDecisionSchema.parse({
      thought_summary: "供物あり。巣に保存して返答する。",
      triage: "continue",
      request_level: 2,
      offering: {
        present: true,
        accepted: true,
        name: "甘いもの",
        quantity: 1,
        satisfaction: 5,
        notes: "頼みごとの対価として受け取った。",
      },
      actions: [
        { type: "nest_stash", name: "甘いもの", quantity: 1, notes: "頼みごとの対価。" },
        { type: "discord_send_message", target_channel_id: "c1", content: "ワシ、受け取った。" },
      ],
      continue_loop: false,
    });

    expect(decision.actions).toHaveLength(2);
  });

  it("rejects non-JSON-shaped cognition decisions", () => {
    expect(() =>
      WedgeDecisionSchema.parse({
        triage: "continue",
        actions: [],
        continue_loop: false,
      }),
    ).toThrow();
  });
});
