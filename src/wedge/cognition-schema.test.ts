import { describe, expect, it } from "vitest";
import { WedgeDecisionSchema, wedgeDecisionJsonSchemaDescription } from "./cognition-schema.js";

describe("WedgeDecisionSchema", () => {
  it("accepts a valid JSON cognition decision", () => {
    const decision = WedgeDecisionSchema.parse({
      thought_summary: "供物を受け取り、巣へ保存して返信する。",
      interpretation: {
        user_intent: "軽い依頼への返信",
        referents: ["供物"],
        actor: "wedge",
        confidence: 0.9,
        ambiguity: null,
      },
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

  it("supports explicit nest consumption actions", () => {
    const decision = WedgeDecisionSchema.parse({
      thought_summary: "巣のアイテム消費許可として解釈する。",
      interpretation: {
        user_intent: "巣のアイテムをWedgeが消費してよいという許可",
        referents: ["直近の巣アイテム"],
        actor: "wedge",
        confidence: 0.85,
        ambiguity: null,
      },
      triage: "continue",
      request_level: 0,
      offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
      actions: [{ type: "nest_consume", name: "甘いもの", quantity: 1, reason: "ユーザーが消費を許可した。" }],
      continue_loop: true,
    });

    expect(decision.actions[0]).toMatchObject({ type: "nest_consume" });
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

  it("keeps the schema description readable", () => {
    expect(wedgeDecisionJsonSchemaDescription()).toContain("保存してよい1文");
    expect(wedgeDecisionJsonSchemaDescription()).toContain("nest_consume");
    expect(wedgeDecisionJsonSchemaDescription()).toContain("item_id または name");
  });
});
