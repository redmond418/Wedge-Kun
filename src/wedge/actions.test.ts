import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executeWedgeAction, type WedgeActionRuntime } from "./actions.js";
import { openWedgeDatabase } from "./storage.js";

describe("executeWedgeAction", () => {
  it("executes Discord, nest, profile, consumption, and none actions", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-actions-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    const sent: unknown[] = [];
    const reactions: unknown[] = [];
    const runtime: WedgeActionRuntime = {
      sendDiscordMessage: async (params) => {
        sent.push(params);
        return { id: "sent-1" };
      },
      addDiscordReaction: async (params) => {
        reactions.push(params);
        return { ok: true };
      },
    };
    try {
      db.upsertUser({ id: "u1", name: "Tester", isBot: false });

      await executeWedgeAction({
        db,
        runtime,
        defaultChannelId: "c1",
        action: { type: "nest_stash", name: "小さな供物", quantity: 2, notes: "テスト。" },
      });
      await executeWedgeAction({
        db,
        runtime,
        defaultChannelId: "c1",
        action: { type: "nest_consume", name: "小さな供物", quantity: 1, reason: "消費テスト。" },
      });
      await executeWedgeAction({
        db,
        runtime,
        defaultChannelId: "c1",
        action: { type: "update_user_profile", user_id: "u1", call_sign: "テストのヒト", details: "動作確認をした。" },
      });
      await executeWedgeAction({
        db,
        runtime,
        defaultChannelId: "c1",
        action: { type: "discord_send_message", target_channel_id: "c1", content: "ワシ、動いた。" },
      });
      await executeWedgeAction({
        db,
        runtime,
        defaultChannelId: "c1",
        action: { type: "discord_add_reaction", target_channel_id: "c1", target_message_id: "m1", emoji: "✅" },
      });
      const none = await executeWedgeAction({
        db,
        runtime,
        defaultChannelId: "c1",
        action: { type: "none", reason: "no-op" },
      });

      expect(db.listNestItems()[0]).toMatchObject({ name: "小さな供物", quantity: 1 });
      expect(db.listRegistry(1)[0]).toMatchObject({ id: "u1", callSign: "テストのヒト" });
      expect(sent).toHaveLength(1);
      expect(reactions).toHaveLength(1);
      expect(none).toEqual({ ok: true, result: { reason: "no-op" } });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
