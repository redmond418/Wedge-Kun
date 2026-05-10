import { runWedgeCognitionLoop } from "./cognition.js";
import { runWedgeMemoryRecovery } from "./cron.js";
import { describeWedgeOllamaReset, unloadWedgeOllamaModel } from "./ollama.js";
import { openWedgeDatabase } from "./storage.js";

export async function runWedgeCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, arg, ...rest] = argv;
  if (command === "reset_ollama_model") {
    await unloadWedgeOllamaModel();
    console.log(describeWedgeOllamaReset());
    return 0;
  }
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
      console.log(JSON.stringify(await runWedgeMemoryRecovery(), null, 2));
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
        userName: userId,
        userIsBot: false,
        content: text,
        kind: "message",
        metadataJson: JSON.stringify({ source: "local_chat" }),
      });
      db.setConversationState(channelId, { thinking: true });
      try {
        await runWedgeCognitionLoop({
          db,
          trigger: {
            kind: "local_chat",
            messageId: `local-${Date.now()}`,
            channelId,
            userId,
            userName: userId,
            userIsBot: false,
            text,
          },
          runtime: {
            sendDiscordMessage: async ({ content }) => {
              console.log(content);
              return { printed: true };
            },
            addDiscordReaction: async ({ emoji }) => {
              console.log(`[reaction] ${emoji}`);
              return { printed: true };
            },
          },
        });
      } finally {
        db.setConversationState(channelId, { thinking: false });
      }
      return 0;
    }
    console.error(
      "Usage: wedge <show_core_memory|show_registry <id>|force_memory_batch|dump_nest|reset_ollama_model|local_chat <channel_id> <user_id> <message>>",
    );
    return 2;
  } finally {
    db.close();
  }
}

if (process.argv[1]?.endsWith("wedge/cli.ts") || process.argv[1]?.endsWith("wedge\\cli.ts")) {
  process.exitCode = await runWedgeCli();
}
