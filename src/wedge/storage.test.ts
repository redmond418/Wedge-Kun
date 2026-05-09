import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openWedgeDatabase } from "./storage.js";

describe("Wedge storage", () => {
  it("stores structured short-term logs including bot and reply metadata", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-storage-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    try {
      db.insertLog({
        messageId: "m1",
        channelId: "c1",
        channelName: "general",
        userId: "bot1",
        userName: "Wedge",
        userIsBot: true,
        guildId: "g1",
        replyToMessageId: "m0",
        replyToUserId: "u1",
        attachmentsJson: JSON.stringify([{ id: "a1", contentType: "image/png" }]),
        content: "ワシ、記憶する。",
        kind: "message",
      });

      const [log] = db.listRecentLogs("c1");
      expect(log).toMatchObject({
        messageId: "m1",
        channelName: "general",
        userName: "Wedge",
        userIsBot: 1,
        replyToMessageId: "m0",
        replyToUserId: "u1",
      });
      expect(log.attachmentsJson).toContain("image/png");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
