import { executeWedgeAction, type WedgeActionRuntime } from "./actions.js";
import { generateWedgeOllamaDecision } from "./ollama.js";
import { buildWedgeSystemPrompt, type WedgePromptContext } from "./prompt.js";
import type { WedgeDatabase, WedgeLogInput } from "./storage.js";

const MAX_COGNITION_ITERATIONS = 10;

export type WedgeCognitionTrigger = {
  kind: "discord_message" | "local_chat" | "memory_batch" | "soliloquy";
  messageId?: string;
  channelId: string;
  channelName?: string | null;
  guildId?: string | null;
  userId?: string;
  userName?: string | null;
  userIsBot?: boolean;
  text: string;
  replyToMessageId?: string | null;
  replyToUserId?: string | null;
  attachments?: unknown[];
};

export async function runWedgeCognitionLoop(params: {
  db: WedgeDatabase;
  trigger: WedgeCognitionTrigger;
  runtime?: WedgeActionRuntime;
  maxIterations?: number;
}): Promise<{ iterations: number; finalTriage: string; actionCount: number }> {
  const maxIterations = params.maxIterations ?? MAX_COGNITION_ITERATIONS;
  const runId = params.db.createCognitionRun({
    triggerMessageId: params.trigger.messageId,
    channelId: params.trigger.channelId,
    userId: params.trigger.userId,
  });
  const toolResults: Array<{ action: string; result: unknown }> = [];
  let finalTriage = "continue";
  let actionCount = 0;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const context: WedgePromptContext = {
      trigger: {
        kind: params.trigger.kind,
        channelId: params.trigger.channelId,
        channelName: params.trigger.channelName ?? null,
        guildId: params.trigger.guildId ?? null,
        messageId: params.trigger.messageId ?? null,
        userId: params.trigger.userId ?? null,
        userName: params.trigger.userName ?? null,
        userIsBot: params.trigger.userIsBot ?? false,
        text: params.trigger.text,
        replyToMessageId: params.trigger.replyToMessageId ?? null,
        replyToUserId: params.trigger.replyToUserId ?? null,
        attachments: params.trigger.attachments ?? [],
      },
      recentLogs: params.db.listRecentLogs(params.trigger.channelId, 24),
      toolResults,
      iteration,
    };
    const prompt = buildWedgeSystemPrompt({ db: params.db, context });
    const decision = await generateWedgeOllamaDecision({
      systemPrompt: prompt,
      userText: params.trigger.text,
    });
    finalTriage = decision.triage;
    params.db.insertCognitionStep({ runId, iteration, prompt, decision });
    console.log(
      `[wedge:cognition] iteration=${iteration} triage=${decision.triage} actions=${decision.actions.length} continue=${decision.continue_loop} thought=${decision.thought_summary}`,
    );
    for (const action of decision.actions) {
      try {
        const result = await executeWedgeAction({
          db: params.db,
          action,
          runtime: params.runtime,
          defaultChannelId: params.trigger.channelId,
        });
        actionCount += 1;
        toolResults.push({ action: action.type, result });
        params.db.insertCognitionStep({
          runId,
          iteration,
          prompt,
          action,
          resultJson: JSON.stringify(result),
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolResults.push({ action: action.type, result: { ok: false, error: message } });
        params.db.insertCognitionStep({ runId, iteration, prompt, action, error: message });
      }
    }
    if (!decision.continue_loop) {
      return { iterations: iteration, finalTriage, actionCount };
    }
  }
  params.db.insertLog(createLoopLimitLog(params.trigger));
  return { iterations: maxIterations, finalTriage, actionCount };
}

function createLoopLimitLog(trigger: WedgeCognitionTrigger): WedgeLogInput {
  return {
    messageId: `wedge-loop-limit-${Date.now()}`,
    channelId: trigger.channelId,
    guildId: trigger.guildId ?? undefined,
    content: "Wedge cognition loop reached iteration limit.",
    kind: "system",
  };
}
