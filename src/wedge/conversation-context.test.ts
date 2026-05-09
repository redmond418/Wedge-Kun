import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWedgeSystemPrompt } from "./prompt.js";
import { openWedgeDatabase } from "./storage.js";

describe("Wedge short-term conversation context", () => {
  it("injects recent channel logs into the system prompt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-context-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    try {
      db.upsertUser({ id: "u1", name: "Tester", callSign: "ニンゲン", isBot: false });
      db.upsertChannel({ id: "c1", name: "test" });
      db.insertLog({
        messageId: "m1",
        channelId: "c1",
        userId: "u1",
        content: "お礼を渡す",
        kind: "message",
      });
      db.insertLog({
        messageId: "m2",
        channelId: "c1",
        userId: "u1",
        content: "それでお願い",
        kind: "message",
      });

      const prompt = buildWedgeSystemPrompt({ db, channelId: "c1" });

      expect(prompt).toContain("[短期ログコンテキスト]");
      expect(prompt).toContain("お礼を渡す");
      expect(prompt).toContain("それでお願い");
      expect(prompt).toContain("speaker=ニンゲン");
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
