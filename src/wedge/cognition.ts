import { executeWedgeAction, type WedgeActionRuntime } from "./actions.js";
import type { WedgeDecision } from "./cognition-schema.js";
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
      recentLogs: params.db.listRecentLogs(params.trigger.channelId, 8),
      toolResults,
      iteration,
    };
    const prompt = buildWedgeSystemPrompt({ db: params.db, context });
    const llmDebugEvents: Array<{ phase: string; text?: string; error?: string }> = [];
    const rawDecision = await generateWedgeOllamaDecision({
      systemPrompt: prompt,
      userText: params.trigger.text,
      fallbackChannelId: params.trigger.channelId,
      fallbackReplyToMessageId: params.trigger.messageId ?? null,
      onDebug: (event) => {
        llmDebugEvents.push(event);
      },
    });
    const { decision, guardResult } = applyOfferingConsistencyGuard(
      normalizeDecision(enforceOfferingGate(rawDecision, params.trigger)),
    );
    if (guardResult) {
      toolResults.push({ action: "offering_consistency_guard", result: guardResult });
    }
    finalTriage = decision.triage;
    for (const event of llmDebugEvents) {
      params.db.insertCognitionStep({
        runId,
        iteration,
        prompt,
        resultJson: JSON.stringify({ llm_debug: event }),
        error: event.error,
      });
    }
    params.db.insertCognitionStep({ runId, iteration, prompt, decision });
    if (guardResult) {
      params.db.insertCognitionStep({
        runId,
        iteration,
        prompt,
        resultJson: JSON.stringify({ offering_consistency_guard: guardResult }),
      });
    }
    console.log(
      `[wedge:cognition] iteration=${iteration} triage=${decision.triage} actions=${decision.actions.length} continue=${decision.continue_loop} thought=${decision.thought_summary}`,
    );
    if (process.env.WEDGE_DEBUG_LLM !== "0") {
      console.log(`[wedge:cognition] decision=${JSON.stringify(decision)}`);
    }
    for (const action of decision.actions) {
      if (
        decision.continue_loop &&
        (action.type === "discord_send_message" || action.type === "discord_add_reaction")
      ) {
        const result = { skipped: "deferred user-facing action until final iteration" };
        toolResults.push({ action: action.type, result });
        params.db.insertCognitionStep({
          runId,
          iteration,
          prompt,
          action,
          resultJson: JSON.stringify(result),
        });
        continue;
      }
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

function enforceOfferingGate(decision: WedgeDecision, trigger: WedgeCognitionTrigger): WedgeDecision {
  if (
    decision.internal_source === "fallback" ||
    decision.internal_source === "repair" ||
    (decision.internal_source === "legacy_normalized" && decision.actions.some((action) => action.type === "none"))
  ) {
    return decision;
  }
  const satisfaction = decision.offering.present ? decision.offering.satisfaction : 0;
  if (decision.request_level <= satisfaction) {
    return decision;
  }
  return {
    ...decision,
    thought_summary: "供物不足のため、依頼本文を実行せず催促に差し替える。",
    triage: "block",
    offering: {
      ...decision.offering,
      accepted: false,
    },
    actions: [
      {
        type: "discord_send_message",
        target_channel_id: trigger.channelId,
        reply_to_message_id: trigger.messageId ?? null,
        content: "ワシ、ただでは動かん。くれるモノ、何。",
      },
    ],
    continue_loop: false,
  };
}

function normalizeDecision(decision: WedgeDecision): WedgeDecision {
  let normalized = decision;
  if (
    normalized.offering.present &&
    normalized.offering.satisfaction >= normalized.request_level &&
    !normalized.offering.accepted
  ) {
    normalized = {
      ...normalized,
      offering: {
        ...normalized.offering,
        accepted: true,
      },
    };
  }
  if (!normalized.actions.some((action) => action.type === "nest_consume")) {
    const hasWedgeAction = normalized.actions.some(
      (action) =>
        action.type !== "none" &&
        action.type !== "discord_add_reaction" &&
        action.type !== "discord_send_message",
    );
    if (!hasWedgeAction || normalized.interpretation.actor === "wedge") {
      return normalized;
    }
    return {
      ...normalized,
      interpretation: {
        ...normalized.interpretation,
        actor: "wedge",
        ambiguity:
          normalized.interpretation.ambiguity ??
          "Wedge側の行動 action が選ばれたため、行動主体をウェッジくんとして扱う。",
      },
    };
  }
  if (normalized.interpretation.actor === "wedge") {
    return normalized;
  }
  return {
    ...normalized,
    interpretation: {
      ...normalized.interpretation,
      actor: "wedge",
      ambiguity:
        normalized.interpretation.ambiguity ??
        "巣アイテム消費 action が選ばれたため、行動主体をウェッジくんとして扱う。",
    },
  };
}

function applyOfferingConsistencyGuard(decision: WedgeDecision): {
  decision: WedgeDecision;
  guardResult?: { ok: true; reason: string };
} {
  if (!decision.offering.present || decision.offering.satisfaction < decision.request_level) {
    return { decision };
  }
  const asksForMoreOffering = decision.actions.some((action) => {
    if (action.type !== "discord_send_message") {
      return false;
    }
    return /足りない|くれるモノ/.test(action.content);
  });
  if (!asksForMoreOffering) {
    return { decision };
  }
  return {
    decision: {
      ...decision,
      thought_summary: "供物は足りているため、追加催促を保留して依頼実行のため再思考する。",
      offering: {
        ...decision.offering,
        accepted: true,
      },
      continue_loop: true,
    },
    guardResult: {
      ok: true,
      reason:
        "供物満足度が依頼レベル以上なので、追加供物を求めず、受け取った供物を前提に依頼された成果物を実行すること。",
    },
  };
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
