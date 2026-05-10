import { executeWedgeAction, type WedgeActionRuntime } from "./actions.js";
import type { WedgeDecision } from "./cognition-schema.js";
import { generateWedgeOllamaDecision } from "./ollama.js";
import { buildWedgeSystemPrompt, type WedgePromptContext } from "./prompt.js";
import type { WedgeDatabase, WedgeLogInput } from "./storage.js";

const MAX_COGNITION_ITERATIONS = 10;

type TriggerIntentKind = "chitchat" | "artifact_request" | "tool_request" | "offering_only" | "ambiguous";

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
    const triggerIntent = classifyTriggerIntent(params.trigger.text);
    const semanticResult = applySemanticGuard(normalizeDecision(rawDecision), params.trigger, triggerIntent, toolResults);
    const { decision, guardResult } = applyOfferingConsistencyGuard(
      enforceOfferingGate(semanticResult.decision, params.trigger, triggerIntent),
    );
    if (semanticResult.guardResult) {
      toolResults.push({ action: "semantic_guard", result: semanticResult.guardResult });
    }
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
    if (semanticResult.guardResult) {
      params.db.insertCognitionStep({
        runId,
        iteration,
        prompt,
        resultJson: JSON.stringify({ semantic_guard: semanticResult.guardResult }),
      });
    }
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

function enforceOfferingGate(
  decision: WedgeDecision,
  trigger: WedgeCognitionTrigger,
  triggerIntent: TriggerIntentKind,
): WedgeDecision {
  if (
    decision.internal_source === "fallback" ||
    decision.internal_source === "repair" ||
    (decision.internal_source === "legacy_normalized" && decision.actions.some((action) => action.type === "none"))
  ) {
    return decision;
  }
  if (triggerIntent !== "artifact_request" && triggerIntent !== "tool_request") {
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

function applySemanticGuard(
  decision: WedgeDecision,
  trigger: WedgeCognitionTrigger,
  triggerIntent: TriggerIntentKind,
  toolResults: Array<{ action: string; result: unknown }>,
): { decision: WedgeDecision; guardResult?: { ok: true; reason: string; intent: TriggerIntentKind } } {
  let guarded = decision;
  const reasons: string[] = [];
  const hasExplicitOffering = hasOfferingCue(trigger.text);
  const extractedOffering = extractOffering(trigger.text);
  if (
    hasExplicitOffering &&
    extractedOffering &&
    (!guarded.offering.present ||
      guarded.offering.name !== extractedOffering ||
      guarded.offering.satisfaction < guarded.request_level)
  ) {
    const satisfaction = Math.max(guarded.offering.satisfaction, Math.max(1, guarded.request_level));
    guarded = {
      ...guarded,
      offering: {
        present: true,
        accepted: satisfaction >= guarded.request_level,
        name: extractedOffering,
        quantity: 1,
        satisfaction: Math.min(10, satisfaction),
        notes: "ユーザー発話から検出した供物。",
      },
    };
    reasons.push("explicit_offering_recovered");
  }
  if (!hasExplicitOffering && looksLikeFakeOffering(guarded.offering.name)) {
    guarded = {
      ...guarded,
      offering: { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
    };
    reasons.push("fake_offering_removed");
  }
  if (triggerIntent === "chitchat") {
    guarded = {
      ...guarded,
      triage: guarded.triage === "block" ? "continue" : guarded.triage,
      request_level: 0,
      offering: hasExplicitOffering
        ? guarded.offering
        : { present: false, accepted: false, name: null, quantity: 0, satisfaction: 0, notes: null },
    };
    reasons.push("chitchat_never_requires_offering");
  }
  const actions = guarded.actions.filter((action) => !isInvalidNoopAction(action));
  if (actions.length !== guarded.actions.length) {
    guarded = { ...guarded, actions };
    reasons.push("invalid_noop_action_removed");
  }
  if (guarded.continue_loop && !guarded.actions.some(isContextExpandingAction)) {
    guarded = { ...guarded, continue_loop: false };
    reasons.push("non_expanding_loop_stopped");
  }
  const offeringAccepted = guarded.offering.present && guarded.offering.accepted && guarded.offering.name;
  const alreadyStashed = toolResults.some((result) => result.action === "nest_stash");
  if (offeringAccepted && !alreadyStashed && !guarded.actions.some((action) => action.type === "nest_stash")) {
    guarded = {
      ...guarded,
      actions: [
        {
          type: "nest_stash",
          name: guarded.offering.name ?? "供物",
          quantity: Math.max(1, guarded.offering.quantity),
          notes: guarded.offering.notes,
        },
        ...guarded.actions,
      ],
      continue_loop: true,
    };
    reasons.push("accepted_offering_stash_added");
  }
  if (
    (triggerIntent === "artifact_request" || triggerIntent === "tool_request") &&
    offeringAccepted &&
    !alreadyStashed &&
    guarded.actions.some(isContextExpandingAction) &&
    guarded.actions.some((action) => action.type === "discord_send_message" && looksLikePromiseOnly(action.content))
  ) {
    guarded = { ...guarded, continue_loop: true };
    reasons.push("promise_only_reply_deferred");
  }
  if (triggerIntent === "chitchat" && !guarded.actions.some(isUserFacingAction)) {
    guarded = {
      ...guarded,
      actions: [
        {
          type: "discord_send_message",
          target_channel_id: trigger.channelId,
          reply_to_message_id: trigger.messageId ?? null,
          content: "ワシ、聞いてる。ニンゲン、話、続けるか。",
        },
      ],
      continue_loop: false,
    };
    reasons.push("chitchat_reply_fallback_added");
  }
  if (reasons.length === 0) {
    return { decision };
  }
  return {
    decision: {
      ...guarded,
      thought_summary:
        triggerIntent === "chitchat"
          ? "雑談として扱い、供物要求や不要な再思考を抑止する。"
          : guarded.thought_summary,
    },
    guardResult: { ok: true, reason: reasons.join(","), intent: triggerIntent },
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
    return /足りない|くれるモノ|供物|ただでは/.test(action.content);
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

function classifyTriggerIntent(text: string): TriggerIntentKind {
  const normalized = text.trim();
  if (!normalized) {
    return "ambiguous";
  }
  const hasOffering = hasOfferingCue(normalized);
  const hasArtifact = hasArtifactRequestCue(normalized);
  const hasTool = hasToolRequestCue(normalized);
  if (hasTool) {
    return "tool_request";
  }
  if (hasArtifact) {
    return "artifact_request";
  }
  if (hasOffering) {
    return "offering_only";
  }
  if (isChitchat(normalized)) {
    return "chitchat";
  }
  return "ambiguous";
}

function hasOfferingCue(text: string): boolean {
  return /あげる|あげた|渡す|渡した|供物|差し入れ|プレゼント|贈る|受け取って|もらって|どうぞ|食べていい|使っていい/.test(
    text,
  );
}

function extractOffering(text: string): string | null {
  const match =
    /(?:これ、?|この)?\s*([^。！？\n]{1,32}?)(?:を)?(?:あげる|渡す|差し入れ|プレゼント|贈る|受け取って|もらって|どうぞ)/.exec(
      text,
    ) ?? /([^。！？\n]{1,32}?)(?:を)?(?:あげた|渡した)/.exec(text);
  const item = match?.[1]?.trim().replace(/[、，\s]+$/g, "");
  if (!item || /^(これ|それ|あれ|何か|なんか)$/.test(item)) {
    return null;
  }
  return item;
}

function hasArtifactRequestCue(text: string): boolean {
  return /してほしい|して欲しい|してくれる|してくれ|話して|語って|詠んで|書いて|作って|描いて|考えて|決めて|調べて|探して|まとめて|説明して|教えて|判断して|観察して|呼び名|あだ名|コード|実装|修正|編集/.test(
    text,
  );
}

function hasToolRequestCue(text: string): boolean {
  return /ファイル|フォルダ|ディレクトリ|保存|削除|実行|コマンド|ターミナル|画像|アイコン|ログ|DB|sqlite|SQLite|検索/.test(
    text,
  );
}

function isChitchat(text: string): boolean {
  if (hasArtifactRequestCue(text) || hasToolRequestCue(text)) {
    return false;
  }
  if (/おはよう|こんにちは|こんばんは|やあ|調子|元気|大丈夫|起きてる|眠い|天気|いい感じ|わくわく|ありがとう|ごめん|ただいま|おやすみ/.test(text)) {
    return true;
  }
  return text.length <= 18 && /[？?]$/.test(text);
}

function looksLikeFakeOffering(name: string | null): boolean {
  if (!name) {
    return false;
  }
  return /conversation|continuation|response|reply|acknowledg|redirection|core_topic|greeting|small.?talk|確認|会話|返答|応答|挨拶|雑談/.test(
    name,
  );
}

function isInvalidNoopAction(action: WedgeDecision["actions"][number]): boolean {
  if (action.type === "none") {
    return true;
  }
  if (action.type === "update_user_profile") {
    const userId = action.user_id.trim().toLowerCase();
    const hasPayload = Boolean(action.call_sign?.trim() || action.details?.trim());
    return !hasPayload || userId === "n/a" || userId === "unknown" || userId === "null";
  }
  return false;
}

function isUserFacingAction(action: WedgeDecision["actions"][number]): boolean {
  return action.type === "discord_send_message" || action.type === "discord_add_reaction";
}

function isContextExpandingAction(action: WedgeDecision["actions"][number]): boolean {
  return (
    action.type === "nest_look" ||
    action.type === "nest_stash" ||
    action.type === "nest_consume" ||
    action.type === "fetch_user_recent_logs" ||
    action.type === "fetch_user_avatar_context"
  );
}

function looksLikePromiseOnly(content: string): boolean {
  if (content.length > 120 || content.includes("\n")) {
    return false;
  }
  return /詠む|話す|作る|説明する|やる|始める|楽しませ|待て|待って|準備|受け取った|貰った/.test(content);
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
