import cron from "node-cron";
import { executeWedgeAction } from "./actions.js";
import { generateWedgeOllamaDecision } from "./ollama.js";
import { buildWedgeSystemPrompt } from "./prompt.js";
import { openWedgeDatabase } from "./storage.js";

const MEMORY_BATCH_CHANNEL_ID = "wedge-memory-batch";

export async function runWedgeMemoryRecovery() {
  const db = openWedgeDatabase();
  try {
    const logs = db.listMemoryBatchLogs(200);
    if (logs.length === 0) {
      return { logCount: 0, actionCount: 0 };
    }
    const maxLogId = Math.max(...logs.map((log) => log.id));
    const runId = db.createCognitionRun({
      triggerMessageId: `memory-batch-${Date.now()}`,
      channelId: MEMORY_BATCH_CHANNEL_ID,
    });
    const prompt = buildWedgeSystemPrompt({
      db,
      context: {
        iteration: 1,
        recentLogs: logs,
        trigger: {
          kind: "memory_batch",
          channelId: MEMORY_BATCH_CHANNEL_ID,
          text: [
            "短期ログを整理する。",
            "重要な継続情報だけを core memory、users.details、channels.purpose、nest notes に統合する。",
            "生ログの連結を core memory に書いてはいけない。",
          ].join("\n"),
        },
      },
    });
    const decision = await generateWedgeOllamaDecision({
      systemPrompt: prompt,
      userText: "短期ログから長期記憶へ統合する JSON action を返すこと。",
    });
    db.insertCognitionStep({ runId, iteration: 1, prompt, decision });
    let actionCount = 0;
    for (const action of decision.actions) {
      if (action.type === "discord_send_message" || action.type === "discord_add_reaction") {
        db.insertCognitionStep({
          runId,
          iteration: 1,
          prompt,
          action,
          resultJson: JSON.stringify({ skipped: "memory batch cannot send discord actions" }),
        });
        continue;
      }
      const result = await executeWedgeAction({ db, action, defaultChannelId: MEMORY_BATCH_CHANNEL_ID });
      actionCount += 1;
      db.insertCognitionStep({
        runId,
        iteration: 1,
        prompt,
        action,
        resultJson: JSON.stringify(result),
      });
    }
    db.runMemoryBatch();
    db.deleteShortTermLogsThrough(maxLogId);
    return { logCount: logs.length, actionCount };
  } finally {
    db.close();
  }
}

export function startWedgeDailyMemoryBatch() {
  void runWedgeMemoryRecovery().catch((err) => {
    console.warn("[wedge] memory recovery skipped:", err);
  });
  return cron.schedule("0 4 * * *", () => {
    void runWedgeMemoryRecovery().catch((err) => {
      console.warn("[wedge] memory batch failed:", err);
    });
  });
}
