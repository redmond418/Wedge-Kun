import cron from "node-cron";
import { executeWedgeAction } from "./actions.js";
import { generateWedgeOllamaDecision } from "./ollama.js";
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
    const prompt = buildMemoryBatchPrompt();
    const decision = await generateWedgeOllamaDecision({
      systemPrompt: prompt,
      userText: JSON.stringify({
        task: "memory_batch",
        rules: [
          "短期ログから重要な継続情報だけを抽出する",
          "生ログをそのまま長期記憶に連結しない",
          "Discord送信や供物要求は絶対にしない",
        ],
        core_memory: db.getCoreMemoryText(),
        logs,
      }),
      fallbackChannelId: MEMORY_BATCH_CHANNEL_ID,
    });
    db.insertCognitionStep({ runId, iteration: 1, prompt, decision });
    let actionCount = 0;
    for (const action of decision.actions) {
      if (!isAllowedMemoryBatchAction(action.type)) {
        db.insertCognitionStep({
          runId,
          iteration: 1,
          prompt,
          action,
          resultJson: JSON.stringify({ skipped: "memory batch cannot run conversational actions" }),
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

function buildMemoryBatchPrompt() {
  return [
    "You are an internal Wedge memory consolidation function.",
    "Return exactly one WedgeDecision JSON object.",
    "This is not a user conversation. Do not roleplay. Do not ask for offerings. Do not send Discord messages.",
    "Allowed actions: write_core_memory, update_user_profile, nest_update, none.",
    "Use request_level=0, offering.present=false, triage=continue, continue_loop=false.",
    "thought_summary must be one short Japanese sentence describing the memory update.",
  ].join("\n");
}

function isAllowedMemoryBatchAction(type: string) {
  return type === "write_core_memory" || type === "update_user_profile" || type === "nest_update" || type === "none";
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
