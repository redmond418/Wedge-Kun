import { generateWedgeOllamaReply } from "./ollama.js";
import { buildWedgeSystemPrompt } from "./prompt.js";
import { openWedgeDatabase } from "./storage.js";
import { triageWedgeMessage } from "./triage.js";

export async function runWedgeCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, arg, ...rest] = argv;
  const db = openWedgeDatabase();
  try {
    if (command === "show_core_memory") {
      console.log(db.getCoreMemoryText());
      return 0;
    }
    if (command === "show_registry") {
      const entries = db.listRegistry(10);
      console.log(JSON.stringify(arg ? entries.filter((entry) => entry.id === arg) : entries, null, 2));
      return 0;
    }
    if (command === "force_memory_batch") {
      console.log(JSON.stringify(db.runMemoryBatch(), null, 2));
      return 0;
    }
    if (command === "dump_nest") {
      console.log(JSON.stringify(db.listNestItems(), null, 2));
      return 0;
    }
    if (command === "local_chat") {
      const channelId = arg ?? "local";
      const userId = rest[0] ?? "local-user";
      const text = rest.slice(1).join(" ").trim();
      if (!text) {
        console.error("Usage: wedge local_chat <channel_id> <user_id> <message>");
        return 2;
      }
      db.upsertUser({ id: userId, name: userId, callSign: "ニンゲン", isBot: false });
      db.upsertChannel({ id: channelId, name: channelId });
      db.insertLog({
        messageId: `local-${Date.now()}`,
        channelId,
        userId,
        content: text,
        kind: "message",
      });
      const state = db.getConversationState(channelId);
      const now = Math.floor(Date.now() / 1000);
      const recentLogs = db.listRecentLogs(channelId, 24);
      const triage = triageWedgeMessage({ text, authorId: userId, state, recentLogs, now });
      if (triage.action === "block" || triage.action === "bored") {
        console.log(triage.reply);
        return 0;
      }
      if (triage.flags.offeringSeen) {
        db.upsertNestItem({
          name: `供物:local-${Date.now()}`,
          description: text.slice(0, 500),
          quantity: 1,
        });
      }
      db.setConversationState(channelId, { ...triage.statePatch, thinking: true });
      try {
        const reply = await generateWedgeOllamaReply({
          systemPrompt: buildWedgeSystemPrompt({
            db,
            channelId,
            recentLogs,
            conversationControl: triage.flags,
          }),
          userText: text,
        });
        console.log(reply);
        db.insertLog({
          messageId: `local-reply-${Date.now()}`,
          channelId,
          content: reply,
          kind: "action",
          metadataJson: JSON.stringify({ source: "local_chat" }),
        });
      } finally {
        db.setConversationState(channelId, { thinking: false });
      }
      return 0;
    }
    console.error(
      "Usage: wedge <show_core_memory|show_registry <id>|force_memory_batch|dump_nest|local_chat <channel_id> <user_id> <message>>",
    );
    return 2;
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith("wedge/cli.ts") || process.argv[1]?.endsWith("wedge\\cli.ts")) {
  process.exitCode = await runWedgeCli();
}
