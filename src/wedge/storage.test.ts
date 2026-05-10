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

  it("migrates legacy nest items to an autoincrement id primary key", async () => {
    let sqlite: {
      DatabaseSync?: new (path: string) => {
        exec(sql: string): void;
        close(): void;
      };
    };
    try {
      sqlite = (await import("node:sqlite")) as typeof sqlite;
    } catch {
      return;
    }
    if (!sqlite.DatabaseSync) {
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-storage-"));
    const dbPath = path.join(dir, "memory.sqlite");
    const legacy = new sqlite.DatabaseSync(dbPath);
    try {
      legacy.exec(`
        CREATE TABLE nest_items (
          name TEXT NOT NULL UNIQUE,
          notes TEXT,
          quantity INTEGER NOT NULL DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        INSERT INTO nest_items (name, notes, quantity, created_at, updated_at)
        VALUES ('豚骨ラーメン', 'legacy row', 2, 1, 1);
      `);
    } finally {
      legacy.close();
    }

    const db = openWedgeDatabase(dbPath);
    try {
      const [item] = db.listNestItems();
      expect(item).toMatchObject({ name: "豚骨ラーメン", quantity: 2 });
      expect(item?.id).toBeGreaterThan(0);
      const consumed = db.consumeNestItem({ id: item?.id, quantity: 1, reason: "味を見る。" });
      expect(consumed.quantity).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
