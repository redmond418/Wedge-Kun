import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWedgeSystemPrompt } from "./prompt.js";
import { openWedgeDatabase } from "./storage.js";

describe("Wedge short-term conversation context", () => {
  it("injects recent channel logs into the structured system prompt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wedge-context-"));
    const db = openWedgeDatabase(path.join(dir, "memory.sqlite"));
    try {
      db.upsertUser({ id: "u1", name: "Tester", callSign: "ニンゲン", isBot: false });
      db.upsertChannel({ id: "c1", name: "test" });
      db.insertLog({
        messageId: "m1",
        channelId: "c1",
        channelName: "test",
        userId: "u1",
        userName: "Tester",
        content: "お礼を渡す",
        kind: "message",
      });
      db.insertLog({
        messageId: "m2",
        channelId: "c1",
        channelName: "test",
        userId: "u1",
        userName: "Tester",
        content: "それでお願い",
        kind: "message",
      });

      const prompt = buildWedgeSystemPrompt({
        db,
        context: {
          iteration: 1,
          trigger: {
            kind: "local_chat",
            channelId: "c1",
            channelName: "test",
            userId: "u1",
            userName: "Tester",
            text: "それでお願い",
          },
        },
      });

      expect(prompt).toContain("[persona]");
      expect(prompt).toContain("[rules]");
      expect(prompt).toContain("[context_json]");
      expect(prompt).toContain("short_term_logs");
      expect(prompt).toContain("conversation_focus");
      expect(prompt).toContain("previous_same_user_message");
      expect(prompt).toContain("お礼を渡す");
      expect(prompt).toContain("それでお願い");
      expect(prompt).toContain('"call_sign": "ニンゲン"');
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
