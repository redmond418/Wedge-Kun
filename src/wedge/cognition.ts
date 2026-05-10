import { executeWedgeAction, type WedgeActionRuntime } from "./actions.js";
import { wedgeDecisionJsonSchemaDescription, type WedgeDecision } from "./cognition-schema.js";
import { generateWedgeOllamaDecision } from "./ollama.js";
import { buildWedgeSystemPrompt, type WedgePromptContext } from "./prompt.js";
import type { WedgeDatabase, WedgeLogInput, WedgePendingRequest } from "./storage.js";

const MAX_COGNITION_ITERATIONS = 10;
const MAX_PROTOCOL_RETRIES = 5;

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
}): Promise<{ iterations: number; finalTriage: string; actionCount: number; llmCallCount: number }> {
  const maxIterations = params.maxIterations ?? MAX_COGNITION_ITERATIONS;
  const runId = params.db.createCognitionRun({
    triggerMessageId: params.trigger.messageId,
    channelId: params.trigger.channelId,
    userId: params.trigger.userId,
  });
  const toolResults: Array<{ action: string; result: unknown }> = [];
  let finalTriage = "continue";
  let actionCount = 0;
  let llmCallCount = 0;
  const pendingRequest = getApplicablePendingRequest(params.db.getConversationState(params.trigger.channelId).pendingRequest, params.trigger);

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    const context = buildPromptContext(params.trigger, params.db, toolResults, pendingRequest, iteration);
    const prompt = buildWedgeSystemPrompt({ db: params.db, context });
    const llmDebugEvents: Array<{ phase: string; text?: string; error?: string }> = [];
    let decision: WedgeDecision;
    try {
      decision = await generateWedgeOllamaDecision({
        systemPrompt: prompt,
        userText: params.trigger.text,
        fallbackChannelId: params.trigger.channelId,
        fallbackReplyToMessageId: params.trigger.messageId ?? null,
        onDebug: (event) => {
          if (event.phase === "raw_output" || event.phase === "retry_raw_output" || event.phase === "repair_raw_output") {
            llmCallCount += 1;
          }
          llmDebugEvents.push(event);
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const event of llmDebugEvents) {
        params.db.insertCognitionStep({
          runId,
          iteration,
          prompt,
          resultJson: JSON.stringify({ llm_debug: event }),
          error: event.error,
        });
      }
      params.db.insertCognitionStep({ runId, iteration, prompt, error: message });
      throw err;
    }

    decision = await resolveProtocolInvalidDecision({
      db: params.db,
      runId,
      iteration,
      prompt,
      trigger: params.trigger,
      decision,
      toolResults,
      pendingRequest,
      llmDebugEvents,
      onLlmCall: () => {
        llmCallCount += 1;
      },
    });

    finalTriage = decision.triage;
    updatePendingRequestState(params.db, params.trigger, decision, pendingRequest);
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
    console.log(
      `[wedge:cognition] iteration=${iteration} triage=${decision.triage} actions=${decision.actions.length} continue=${decision.continue_loop} thought=${decision.thought_summary}`,
    );
    if (process.env.WEDGE_DEBUG_LLM !== "0") {
      console.log(`[wedge:cognition] decision=${JSON.stringify(decision)}`);
    }

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
        params.db.insertCognitionStep({ runId, iteration, prompt, action, resultJson: JSON.stringify(result) });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        toolResults.push({ action: action.type, result: { ok: false, error: message } });
        params.db.insertCognitionStep({ runId, iteration, prompt, action, error: message });
      }
    }

    if (!decision.continue_loop) {
      return { iterations: iteration, finalTriage, actionCount, llmCallCount };
    }
  }

  params.db.insertLog(createLoopLimitLog(params.trigger));
  params.db.insertCognitionStep({
    runId,
    iteration: maxIterations,
    prompt: "[loop_limit]",
    error: "Wedge cognition loop reached iteration limit.",
  });
  throw new Error("wedge_cognition_loop_limit");
}

async function resolveProtocolInvalidDecision(params: {
  db: WedgeDatabase;
  runId: number;
  iteration: number;
  prompt: string;
  trigger: WedgeCognitionTrigger;
  decision: WedgeDecision;
  toolResults: Array<{ action: string; result: unknown }>;
  pendingRequest: WedgePendingRequest | null;
  llmDebugEvents: Array<{ phase: string; text?: string; error?: string }>;
  onLlmCall: () => void;
}): Promise<WedgeDecision> {
  let decision = params.decision;
  for (let attempt = 1; attempt <= MAX_PROTOCOL_RETRIES; attempt += 1) {
    const issue = getDecisionProtocolIssue(decision, params.trigger.text, params.pendingRequest, params.toolResults);
    if (!issue) {
      return decision;
    }
    if (issue === "missing_nest_consume_target") {
      const targetFixed = fillMissingNestConsumeTarget(decision, params.trigger.text, params.db.listNestItems());
      if (targetFixed) {
        params.db.insertCognitionStep({
          runId: params.runId,
          iteration: params.iteration,
          prompt: params.prompt,
          decision: targetFixed,
          resultJson: JSON.stringify({ protocol_structural_fix: issue }),
        });
        decision = targetFixed;
        continue;
      }
    }
    if (issue === "continue_loop_with_final_user_facing_action") {
      const finalized = { ...decision, continue_loop: false };
      params.db.insertCognitionStep({
        runId: params.runId,
        iteration: params.iteration,
        prompt: params.prompt,
        decision: finalized,
        resultJson: JSON.stringify({ protocol_structural_fix: issue }),
      });
      return finalized;
    }
    if (issue === "data_fetch_without_continue_loop") {
      const toolOnly = {
        ...decision,
        actions: decision.actions.filter((action) => isDataFetchingAction(action)),
        continue_loop: true,
      };
      params.db.insertCognitionStep({
        runId: params.runId,
        iteration: params.iteration,
        prompt: params.prompt,
        decision: toolOnly,
        resultJson: JSON.stringify({ protocol_structural_fix: issue }),
      });
      return toolOnly;
    }
    if (issue === "data_fetch_with_final_user_facing_action" && hasOfferingPromptAction(decision)) {
      const finalized = {
        ...decision,
        triage: "block" as const,
        actions: decision.actions.filter((action) => !isDataFetchingAction(action)),
        continue_loop: false,
      };
      params.db.insertCognitionStep({
        runId: params.runId,
        iteration: params.iteration,
        prompt: params.prompt,
        decision: finalized,
        resultJson: JSON.stringify({ protocol_structural_fix: issue }),
      });
      return finalized;
    }
    if (issue === "missing_final_reply_after_consume" && hasValidNestConsumeTarget(decision)) {
      const toolOnly = {
        ...decision,
        actions: decision.actions.filter((action) => action.type === "nest_consume"),
        continue_loop: true,
      };
      params.db.insertCognitionStep({
        runId: params.runId,
        iteration: params.iteration,
        prompt: params.prompt,
        decision: toolOnly,
        resultJson: JSON.stringify({ protocol_structural_fix: issue, action: "execute_consume_then_reflect" }),
      });
      return toolOnly;
    }
    if (issue === "accepted_offering_missing_final_reply" && !params.toolResults.some((toolResult) => toolResult.action === "nest_stash")) {
      const toolOnly = {
        ...decision,
        actions: decision.actions.filter((action) => action.type === "nest_stash"),
        continue_loop: true,
      };
      params.db.insertCognitionStep({
        runId: params.runId,
        iteration: params.iteration,
        prompt: params.prompt,
        decision: toolOnly,
        resultJson: JSON.stringify({ protocol_structural_fix: issue, action: "execute_stash_then_reflect" }),
      });
      return toolOnly;
    }
    if (issue === "insufficient_offering_not_blocked" && hasUserFacingAction(decision) && hasOfferingPromptAction(decision)) {
      const finalized = { ...decision, triage: "block" as const, continue_loop: false };
      params.db.insertCognitionStep({
        runId: params.runId,
        iteration: params.iteration,
        prompt: params.prompt,
        decision: finalized,
        resultJson: JSON.stringify({ protocol_structural_fix: issue }),
      });
      return finalized;
    }
    params.db.insertCognitionStep({
      runId: params.runId,
      iteration: params.iteration,
      prompt: params.prompt,
      decision,
      error: `protocol_invalid:${issue}`,
    });
    const correctionDebugEvents: Array<{ phase: string; text?: string; error?: string }> = [];
    decision = await generateWedgeOllamaDecision({
      systemPrompt: buildProtocolRedoPrompt({
        issue,
        trigger: params.trigger,
        previousDecision: decision,
        toolResults: params.toolResults,
        pendingRequest: params.pendingRequest,
        nestItems: params.db.listNestItems(),
      }),
      userText: params.trigger.text,
      fallbackChannelId: params.trigger.channelId,
      fallbackReplyToMessageId: params.trigger.messageId ?? null,
      allowRepair: false,
      onDebug: (event) => {
        if (event.phase === "raw_output" || event.phase === "retry_raw_output" || event.phase === "repair_raw_output") {
          params.onLlmCall();
        }
        correctionDebugEvents.push(event);
      },
    });
    for (const event of correctionDebugEvents) {
      params.llmDebugEvents.push({ ...event, phase: `protocol_${event.phase}` });
      params.db.insertCognitionStep({
        runId: params.runId,
        iteration: params.iteration,
        prompt: params.prompt,
        resultJson: JSON.stringify({ llm_debug: { ...event, phase: `protocol_${event.phase}` } }),
        error: event.error,
      });
    }
    params.db.insertCognitionStep({
      runId: params.runId,
      iteration: params.iteration,
      prompt: params.prompt,
      decision,
      resultJson: JSON.stringify({ protocol_correction_attempt: attempt, source: "llm" }),
    });
  }
  const issue = getDecisionProtocolIssue(decision, params.trigger.text, params.pendingRequest, params.toolResults);
  if (issue === "continue_loop_with_final_user_facing_action") {
    const finalized = { ...decision, continue_loop: false };
    params.db.insertCognitionStep({
      runId: params.runId,
      iteration: params.iteration,
      prompt: params.prompt,
      decision: finalized,
      resultJson: JSON.stringify({ protocol_structural_fix: issue, after_llm_redo: true }),
    });
    return finalized;
  }
  if (issue) {
    params.db.insertCognitionStep({
      runId: params.runId,
      iteration: params.iteration,
      prompt: params.prompt,
      decision,
      error: `protocol_invalid_after_retry:${issue}`,
    });
    throw new Error(`wedge_llm_protocol_invalid:${issue}`);
  }
  return decision;
}

function buildFinalActionPrompt(basePrompt: string, issue: string): string {
  return [
    "[final_action_task]",
    `前回の判断は ${issue} により最終行動として不完全だった。`,
    "これは前回出力の修理ではない。同じ context と現在のユーザー発話を読み直し、最終 action を最初から再判断するタスクである。",
    "user メッセージは通常のユーザー発話として扱う。内部メタ情報は user メッセージに含まれていない。",
    "会話文、供物判断、頼みごと判断、pending_request の扱いはすべてあなたが context から決める。",
    "固定文や runtime 補完は存在しない。",
    "このタスクでは原則 `continue_loop=false` にする。",
    "ユーザーに返すべき会話なら、あなたが生成した `discord_send_message` を actions に含める。",
    "artifact_reply_promise_only の場合は、予告や受諾だけで終わらせず、依頼された成果物本文または実行結果そのものを `content` に含める。",
    "insufficient_offering_not_blocked の場合は、成果物本文を出さず、あなたの言葉で供物や対価を求める。",
    "accepted_offering_without_nest_stash の場合は、受け取る供物を `nest_stash` し、同じ actions に最終返信も含める。",
    "unauthorized_nest_consume の場合は、巣の中身を勝手に使わず、現在発話と pending_request だけを見て最終行動を決める。",
    "供物や記憶などの state 更新が必要なら、その action と最終 `discord_send_message` を同じ actions に含める。",
    "`none` は、本当に何もしないのが最終行動として自然な場合だけ使う。",
    "tool_results があるなら、その結果を読んでユーザー向けに説明する。再度同じ文脈取得 tool を呼ばない。",
    "JSON オブジェクトだけを返す。",
    "",
    basePrompt,
  ].join("\n");
}

function buildProtocolRedoPrompt(params: {
  issue: string;
  trigger: WedgeCognitionTrigger;
  previousDecision: WedgeDecision;
  toolResults: Array<{ action: string; result: unknown }>;
  pendingRequest: WedgePendingRequest | null;
  nestItems: Array<{ id: number; name: string; quantity: number; notes: string | null }>;
}): string {
  const rejectedSummary = summarizeRejectedDecision(params.previousDecision, params.issue);
  return [
    "[protocol_redo_task]",
    "あなたはウェッジくんの最終行動 JSON を作り直す。これは通常会話ではなく、直前の WedgeDecision が protocol validation failure で破棄されたための短い再判断タスク。",
    "破棄された decision は実行されていない。ユーザーにも送られていない。そこに含まれる発言・消費・保存・回答を会話履歴や事実として扱ってはいけない。",
    "固定文や runtime 補完は存在しない。会話文、供物判定、頼みごと判定、最終 action はあなたが生成する。",
    "出力は WedgeDecision JSON オブジェクトだけ。Markdown と説明文は禁止。",
    "",
    "[persona_min]",
    "ウェッジくん。一人称はワシ、二人称はニンゲン。助詞少なめの短いカタコト。ただし成果物や説明は意味が伝わる長さにする。",
    "",
    "[issue]",
    params.issue,
    "",
    "[issue_rules]",
    "- artifact_reply_promise_only: 予告や受諾だけで終わらせず、依頼された成果物本文または実行結果そのものを discord_send_message.content に含める。pending_request がある場合は、それが今実行すべき依頼本文である。",
    "- insufficient_offering_not_blocked: 成果物本文を出さず、あなたの言葉で供物や対価を求め、triage を block にする。",
    "- accepted_offering_without_nest_stash: 受け取る供物を nest_stash し、同じ actions に最終返信も含める。",
    "- missing_nest_consume_target: nest_consume には巣アイテムの item_id または name が必須。nest_items から対象を選び直す。",
    "- missing_final_reply_after_consume: nest_consume だけで終わらせず、食べた/使った結果や味の感想を discord_send_message.content に含める。",
    "- accepted_offering_missing_final_reply: nest_stash だけで終わらせず、受け取った供物への反応と、現在依頼または pending_request の成果物本文/実行結果を discord_send_message.content に含める。",
    "- unprompted_offering_prompt_after_consume: 巣アイテムを消費して感想を返す依頼では、味や結果だけを伝える。追加の供物や対価を求める文を混ぜない。",
    "- unprompted_offering_prompt_after_accepted_offering: 現在発話の供物を受け取り済みなら、同じ最終返信でさらに供物や対価を求めない。受け取った供物に対する成果物や返答を完了する。",
    "- consume_retry_amnesia: 破棄された出力や再試行中の出力はユーザーに送られていない。tool_results の nest_consume は今このターンで実行された事実として扱い、「もう答えた」「さっき食った」などとは言わず、味や結果をそのまま返す。",
    "- unauthorized_nest_consume: 巣の中身を勝手に使わず、現在発話だけを見て最終行動を決める。",
    "- data_fetch_with_final_user_facing_action: 文脈取得 tool の結果を読まずに返信している。必要なら文脈取得 tool だけを出して continue_loop=true、不要なら tool を外して最終返信する。",
    "- repeated_data_fetch_after_result: tool_results に既に結果がある。同じ tool を再実行せず、その結果を読んで最終返信を書く。",
    "- data_fetch_without_continue_loop: 文脈取得 tool だけを出すなら continue_loop=true にする。結果取得後は同じ tool を再実行せず、tool_results を読んで最終返信を書く。",
    "- nest_look_result_not_reported: tool_results の nest_look 結果を読み、remaining にある巣アイテム名だけを「残っているもの」として最終返信に含める。remaining が空なら空だと説明する。consumed や quantity=0 は消費済みであり、残っているものとして書かない。",
    "- artifact_placeholder_content: プレースホルダや「ここに本文」ではなく、実際の成果物本文を書く。",
    "- pending_request_not_fulfilled_after_offering: pending_request が現在実行対象。現在発話の供物を受け取り、pending_request.text の成果物本文または実行結果を同じ最終返信に含める。別の依頼へ逸らさない。",
    "- unsupported_external_lookup_with_offering_prompt: 外部情報 tool が未実装なら、捏造せず取得手段がないことだけを説明する。供物や対価を求めてはいけない。",
    "- unprompted_offering_prompt_for_low_request: あなた自身の判断で軽い雑談や感謝なら、供物や対価を要求せず自然に返す。",
    "- continue_loop_without_context_action: 返すべき会話があるなら discord_send_message を出し、continue_loop=false にする。",
    "- 前回の discord_send_message.content は無効判定された本文なのでコピーしない。必要な場合は、文脈を読み直して新しい本文を書く。",
    "",
    "[current_user_text]",
    params.trigger.text,
    "",
    "[trigger]",
    JSON.stringify(params.trigger, null, 2),
    "",
    "[pending_request]",
    JSON.stringify(params.pendingRequest, null, 2),
    "",
    "[rejected_output_summary]",
    JSON.stringify(rejectedSummary, null, 2),
    "",
    "[nest_items]",
    JSON.stringify(params.nestItems, null, 2),
    "",
    "[tool_results]",
    JSON.stringify(params.toolResults.slice(-3), null, 2),
    "",
    "[schema]",
    wedgeDecisionJsonSchemaDescription(),
  ].join("\n");
}

function getDecisionProtocolIssue(
  decision: WedgeDecision,
  currentText: string,
  pendingRequest: WedgePendingRequest | null,
  toolResults: Array<{ action: string; result: unknown }>,
): string | null {
  if (hasNestConsumeWithoutTarget(decision)) {
    return "missing_nest_consume_target";
  }
  if (isUnauthorizedNestConsume(decision, currentText)) {
    return "unauthorized_nest_consume";
  }
  if (isNestConsumeMissingFinalReply(decision)) {
    return "missing_final_reply_after_consume";
  }
  if (isAcceptedOfferingMissingFinalReply(decision)) {
    return "accepted_offering_missing_final_reply";
  }
  if (isConsumeResultNotReported(decision, toolResults)) {
    return "missing_final_reply_after_consume";
  }
  if (isUnpromptedOfferingPromptAfterConsume(decision)) {
    return "unprompted_offering_prompt_after_consume";
  }
  if (isUnpromptedOfferingPromptAfterAcceptedOffering(decision)) {
    return "unprompted_offering_prompt_after_accepted_offering";
  }
  if (isConsumeRetryAmnesia(decision, toolResults)) {
    return "consume_retry_amnesia";
  }
  if (isAcceptedOfferingWithoutStash(decision)) {
    return "accepted_offering_without_nest_stash";
  }
  if (isUnsupportedExternalLookupWithOfferingPrompt(decision, currentText)) {
    return "unsupported_external_lookup_with_offering_prompt";
  }
  if (isInsufficientOfferingDecision(decision, currentText, toolResults)) {
    return "insufficient_offering_not_blocked";
  }
  if (isArtifactPromiseOnlyDecision(decision)) {
    return "artifact_reply_promise_only";
  }
  if (hasArtifactPlaceholderContent(decision)) {
    return "artifact_placeholder_content";
  }
  if (isPendingRequestNotFulfilledAfterOffering(decision, pendingRequest)) {
    return "pending_request_not_fulfilled_after_offering";
  }
  if (isNestLookResultNotReported(decision, toolResults)) {
    return "nest_look_result_not_reported";
  }
  if (isUnpromptedOfferingPromptForLowRequest(decision)) {
    return "unprompted_offering_prompt_for_low_request";
  }
  if (isRepeatedDataFetchAfterResult(decision, toolResults)) {
    return "repeated_data_fetch_after_result";
  }
  if (
    !decision.continue_loop &&
    decision.actions.some((action) => isUserFacingAction(action)) &&
    decision.actions.some((action) => isDataFetchingAction(action))
  ) {
    return "data_fetch_with_final_user_facing_action";
  }
  if (
    !decision.continue_loop &&
    decision.actions.some((action) => isDataFetchingAction(action)) &&
    !decision.actions.some((action) => isUserFacingAction(action))
  ) {
    return "data_fetch_without_continue_loop";
  }
  if (!decision.continue_loop) {
    return null;
  }
  if (decision.actions.some((action) => isUserFacingAction(action))) {
    return decision.actions.some((action) => isDataFetchingAction(action))
      ? "continue_loop_with_user_facing_and_data_fetch_action"
      : "continue_loop_with_final_user_facing_action";
  }
  if (!decision.actions.some((action) => isContextAddingAction(action))) {
    return "continue_loop_without_context_action";
  }
  return null;
}

function isInsufficientOfferingDecision(
  decision: WedgeDecision,
  currentText: string,
  toolResults: Array<{ action: string; result: unknown }>,
): boolean {
  if (decision.actions.some((action) => action.type === "nest_stash")) {
    return false;
  }
  if (decision.actions.some((action) => action.type === "nest_consume")) {
    return false;
  }
  if (toolResults.some((toolResult) => toolResult.action === "nest_consume")) {
    return false;
  }
  if (decision.actions.some((action) => isDataFetchingAction(action))) {
    return false;
  }
  if (/巣/.test(currentText)) {
    return false;
  }
  if (/天気|気温|ニュース|現在|最新|リアルタイム/.test(currentText) && /調べられ|取得|手段|未実装|持って|持たね|取れない|読めない/.test(collectUserFacingText(decision))) {
    return false;
  }
  return (
    decision.triage !== "block" &&
    decision.request_level >= 3 &&
    decision.offering.satisfaction < decision.request_level
  );
}

function hasNestConsumeWithoutTarget(decision: WedgeDecision): boolean {
  return decision.actions.some(
    (action) => action.type === "nest_consume" && action.item_id === undefined && action.name === undefined,
  );
}

function hasValidNestConsumeTarget(decision: WedgeDecision): boolean {
  return decision.actions.some(
    (action) => action.type === "nest_consume" && (action.item_id !== undefined || action.name !== undefined),
  );
}

function fillMissingNestConsumeTarget(
  decision: WedgeDecision,
  currentText: string,
  nestItems: Array<{ id: number; name: string; quantity: number; notes: string | null }>,
): WedgeDecision | null {
  if (!hasNestConsumeWithoutTarget(decision)) {
    return null;
  }
  const availableItems = nestItems
    .filter((item) => item.quantity > 0)
    .sort((left, right) => right.name.length - left.name.length);
  const matched = availableItems
    .map((item) => ({ item, score: targetMentionScore(currentText, item.name) }))
    .filter((candidate) => candidate.score >= Math.min(3, candidate.item.name.length))
    .sort((left, right) => right.score - left.score || right.item.name.length - left.item.name.length)[0]?.item;
  if (!matched) {
    return null;
  }
  return {
    ...decision,
    actions: decision.actions.map((action) =>
      action.type === "nest_consume" && action.item_id === undefined && action.name === undefined
        ? { ...action, item_id: matched.id, name: matched.name }
        : action,
    ),
  };
}

function targetMentionScore(text: string, itemName: string): number {
  if (text.includes(itemName)) {
    return itemName.length;
  }
  if (itemName.includes(text)) {
    return text.length;
  }
  let best = 0;
  for (let start = 0; start < itemName.length; start += 1) {
    for (let end = start + 1; end <= itemName.length; end += 1) {
      const fragment = itemName.slice(start, end);
      if (fragment.length > best && text.includes(fragment)) {
        best = fragment.length;
      }
    }
  }
  return best;
}

function isNestConsumeMissingFinalReply(decision: WedgeDecision): boolean {
  if (!decision.actions.some((action) => action.type === "nest_consume")) {
    return false;
  }
  if (!decision.actions.some((action) => action.type === "discord_send_message")) {
    return true;
  }
  const text = collectUserFacingText(decision);
  return !/うま|旨|濃|薄|塩|甘|苦|酸|辛|香|匂|歯ごたえ|コク|脂|肉|骨|スープ|しょっぱ|噛|硬|やわ/.test(text);
}

function isAcceptedOfferingMissingFinalReply(decision: WedgeDecision): boolean {
  return decision.actions.some((action) => action.type === "nest_stash") && !hasUserFacingAction(decision) && !decision.continue_loop;
}

function isConsumeResultNotReported(
  decision: WedgeDecision,
  toolResults: Array<{ action: string; result: unknown }>,
): boolean {
  if (!hasUserFacingAction(decision) || decision.actions.some((action) => action.type === "nest_consume")) {
    return false;
  }
  const latestConsume = [...toolResults].reverse().find((toolResult) => toolResult.action === "nest_consume");
  if (!latestConsume) {
    return false;
  }
  const text = collectUserFacingText(decision);
  return !/うま|旨|濃|薄|塩|甘|苦|酸|辛|香|匂|歯ごたえ|コク|脂|肉|骨|スープ|しょっぱ|噛|硬|やわ/.test(text);
}

function isUnpromptedOfferingPromptAfterConsume(decision: WedgeDecision): boolean {
  return decision.actions.some((action) => action.type === "nest_consume") && hasOfferingPromptAction(decision);
}

function isUnpromptedOfferingPromptAfterAcceptedOffering(decision: WedgeDecision): boolean {
  if (decision.triage === "block" || !decision.offering.present) {
    return false;
  }
  const acceptedInNest = decision.actions.some((action) => action.type === "nest_stash");
  return acceptedInNest && hasOfferingPromptAction(decision);
}

function isConsumeRetryAmnesia(
  decision: WedgeDecision,
  toolResults: Array<{ action: string; result: unknown }>,
): boolean {
  if (!hasUserFacingAction(decision) || !toolResults.some((toolResult) => toolResult.action === "nest_consume")) {
    return false;
  }
  return /もう.*(食|言|答)|何度|さっき|前回|既に|すでに|食ったぞ|言った/.test(collectUserFacingText(decision));
}

function summarizeRejectedDecision(decision: WedgeDecision, issue: string) {
  return {
    issue,
    not_executed: true,
    not_sent_to_user: true,
    do_not_treat_as_fact: true,
    triage: decision.triage,
    request_level: decision.request_level,
    offering: decision.offering,
    action_types: decision.actions.map((action) => action.type),
    consume_targets: decision.actions
      .filter((action): action is Extract<WedgeDecision["actions"][number], { type: "nest_consume" }> => action.type === "nest_consume")
      .map((action) => ({ item_id: action.item_id ?? null, name: action.name ?? null, quantity: action.quantity })),
  };
}

function isAcceptedOfferingWithoutStash(decision: WedgeDecision): boolean {
  return (
    decision.triage !== "block" &&
    decision.request_level >= 3 &&
    decision.offering.present &&
    !decision.actions.some((action) => action.type === "nest_stash")
  );
}

function isUnauthorizedNestConsume(decision: WedgeDecision, currentText: string): boolean {
  if (!decision.actions.some((action) => action.type === "nest_consume")) {
    return false;
  }
  return !/食べ|食う|使|消費|減ら|今.*いい|食べていい|使っていい/.test(currentText);
}

function hasUserFacingAction(decision: WedgeDecision): boolean {
  return decision.actions.some((action) => isUserFacingAction(action));
}

function hasOfferingPromptAction(decision: WedgeDecision): boolean {
  return /くれるモノ|ただでは|対価.*(必要|求|出|くれ|持|なし|なければ)|対価なし|価値ある(もん|もの).*(見せ|くれ|出せ|持)|与えるもの|持ってこい|供物.*(必要|求|出|くれ|よこせ|持|足り|なし|なければ)|供え.*(くれ|よこせ|ろ)|何か.*(もん|もの).*(くれ|よこせ|出せ|持ってこい|見せ)/.test(collectUserFacingText(decision));
}

function collectUserFacingText(decision: WedgeDecision): string {
  return decision.actions
    .filter((action): action is Extract<WedgeDecision["actions"][number], { type: "discord_send_message" }> => action.type === "discord_send_message")
    .map((action) => action.content)
    .join("\n")
    .trim();
}

function isUnpromptedOfferingPromptForLowRequest(decision: WedgeDecision): boolean {
  if (decision.triage === "block" || decision.request_level > 2 || decision.offering.present) {
    return false;
  }
  return hasOfferingPromptAction(decision);
}

function hasArtifactPlaceholderContent(decision: WedgeDecision): boolean {
  return /ここに挿入|本文をここ|物語本文|消費結果を記述|味の感想を盛り込む|味を伝える内容|食べて.*味.*内容|placeholder/i.test(collectUserFacingText(decision));
}

function isPendingRequestNotFulfilledAfterOffering(decision: WedgeDecision, pendingRequest: WedgePendingRequest | null): boolean {
  if (!pendingRequest || decision.triage === "block") {
    return false;
  }
  if (!decision.actions.some((action) => action.type === "nest_stash")) {
    return false;
  }
  const text = collectUserFacingText(decision);
  if (!text) {
    return true;
  }
  if (/昔話|物語|話して/.test(pendingRequest.text)) {
    if (text.length >= 180 && /昔|ある日|旅|村|森|話|物語/.test(text)) {
      return false;
    }
    return text.length < 120 || /しまっとく|貰う/.test(text);
  }
  if (/俳句|詩|作/.test(pendingRequest.text)) {
    return !text.includes("\n") || /しまっとく|受け取|貰う/.test(text);
  }
  return false;
}

function isNestLookResultNotReported(
  decision: WedgeDecision,
  toolResults: Array<{ action: string; result: unknown }>,
): boolean {
  if (!hasUserFacingAction(decision) || decision.actions.some((action) => isDataFetchingAction(action))) {
    return false;
  }
  const latestNestLook = [...toolResults].reverse().find((toolResult) => toolResult.action === "nest_look");
  if (!latestNestLook) {
    return false;
  }
  const resultItems = extractRemainingNestLookItems(latestNestLook.result);
  const consumedItems = extractConsumedNestLookItems(latestNestLook.result);
  const itemNames = resultItems
    .filter((item): item is { name: string; quantity?: number } => {
      if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") {
        return false;
      }
      return !("quantity" in item) || typeof item.quantity !== "number" || item.quantity > 0;
    })
    .map((item) => item.name);
  const text = collectUserFacingText(decision);
  const mentionsConsumedAsRemaining = consumedItems.some((item) => text.includes(item.name)) && /残|中身|ある|全部|ちゃんと/.test(text);
  if (mentionsConsumedAsRemaining) {
    return true;
  }
  if (itemNames.length === 0) {
    return !/空|ない|何も/.test(text);
  }
  return !itemNames.some((name) => text.includes(name));
}

function extractRemainingNestLookItems(result: unknown): Array<{ name: string; quantity?: number }> {
  const unwrapped = unwrapActionResult(result);
  if (Array.isArray(unwrapped)) {
    return unwrapped.filter((item): item is { name: string; quantity?: number } => isNestLookItem(item) && (!("quantity" in item) || typeof item.quantity !== "number" || item.quantity > 0));
  }
  if (unwrapped && typeof unwrapped === "object" && "remaining" in unwrapped) {
    const remaining = (unwrapped as { remaining?: unknown }).remaining;
    if (Array.isArray(remaining)) {
      return remaining.filter((item): item is { name: string; quantity?: number } => isNestLookItem(item));
    }
  }
  return [];
}

function extractConsumedNestLookItems(result: unknown): Array<{ name: string; quantity?: number }> {
  const unwrapped = unwrapActionResult(result);
  if (Array.isArray(unwrapped)) {
    return unwrapped.filter((item): item is { name: string; quantity?: number } => isNestLookItem(item) && "quantity" in item && typeof item.quantity === "number" && item.quantity <= 0);
  }
  if (unwrapped && typeof unwrapped === "object" && "consumed" in unwrapped) {
    const consumed = (unwrapped as { consumed?: unknown }).consumed;
    if (Array.isArray(consumed)) {
      return consumed.filter((item): item is { name: string; quantity?: number } => isNestLookItem(item));
    }
  }
  return [];
}

function unwrapActionResult(result: unknown): unknown {
  if (result && typeof result === "object" && "ok" in result && "result" in result) {
    return (result as { result: unknown }).result;
  }
  return result;
}

function isNestLookItem(item: unknown): item is { name: string; quantity?: number } {
  return Boolean(item && typeof item === "object" && "name" in item && typeof item.name === "string");
}

function isUnsupportedExternalLookupWithOfferingPrompt(decision: WedgeDecision, currentText: string): boolean {
  if (!/天気|気温|ニュース|現在|最新|リアルタイム/.test(currentText)) {
    return false;
  }
  return hasOfferingPromptAction(decision) || decision.actions.some((action) => isDataFetchingAction(action));
}

function isRepeatedDataFetchAfterResult(
  decision: WedgeDecision,
  toolResults: Array<{ action: string; result: unknown }>,
): boolean {
  const fetched = new Set(toolResults.map((toolResult) => toolResult.action));
  return decision.actions.some((action) => isDataFetchingAction(action) && fetched.has(action.type));
}

function isArtifactPromiseOnlyDecision(decision: WedgeDecision): boolean {
  if (decision.triage === "block" || decision.request_level < 3) {
    return false;
  }
  const text = collectUserFacingText(decision);
  if (!text) {
    return false;
  }
  if (text.length >= 120 || text.includes("\n")) {
    return false;
  }
  return /待って|待て|詠む|話す|作ってやる|やってみる|楽しみに|楽しませてやる|準備|吟味する|求めるなら.*これ|聞かせてやる|詠んでやる|話してやる|聞かせろ|期待|見せてやる|力.*見せ|ワシの番|持っとるもん.*出す|聞け/.test(text);
}

function isContextAddingAction(action: WedgeDecision["actions"][number]): boolean {
  return (
    action.type === "nest_look" ||
    action.type === "nest_stash" ||
    action.type === "nest_consume" ||
    action.type === "fetch_user_recent_logs" ||
    action.type === "fetch_user_avatar_context"
  );
}

function isDataFetchingAction(action: WedgeDecision["actions"][number]): boolean {
  return (
    action.type === "nest_look" ||
    action.type === "fetch_user_recent_logs" ||
    action.type === "fetch_user_avatar_context"
  );
}

function buildPromptContext(
  trigger: WedgeCognitionTrigger,
  db: WedgeDatabase,
  toolResults: Array<{ action: string; result: unknown }>,
  pendingRequest: WedgePendingRequest | null,
  iteration: number,
): WedgePromptContext {
  return {
    trigger: {
      kind: trigger.kind,
      channelId: trigger.channelId,
      channelName: trigger.channelName ?? null,
      guildId: trigger.guildId ?? null,
      messageId: trigger.messageId ?? null,
      userId: trigger.userId ?? null,
      userName: trigger.userName ?? null,
      userIsBot: trigger.userIsBot ?? false,
      text: trigger.text,
      replyToMessageId: trigger.replyToMessageId ?? null,
      replyToUserId: trigger.replyToUserId ?? null,
      attachments: trigger.attachments ?? [],
    },
    recentLogs: db.listRecentLogs(trigger.channelId, 8),
    toolResults,
    pendingRequest,
    iteration,
  };
}

function updatePendingRequestState(
  db: WedgeDatabase,
  trigger: WedgeCognitionTrigger,
  decision: WedgeDecision,
  pendingRequest: WedgePendingRequest | null,
) {
  if (shouldStorePendingRequest(decision)) {
    db.setConversationState(trigger.channelId, {
      pendingRequest: {
        text: trigger.text,
        userId: trigger.userId ?? null,
        userName: trigger.userName ?? null,
        messageId: trigger.messageId ?? null,
        requestLevel: Math.max(1, decision.request_level),
        createdAt: Date.now(),
      },
    });
    return;
  }
  if (pendingRequest) {
    db.setConversationState(trigger.channelId, { pendingRequest: null });
  }
}

function shouldStorePendingRequest(decision: WedgeDecision): boolean {
  return decision.triage === "block";
}

function getApplicablePendingRequest(
  pendingRequest: WedgePendingRequest | undefined,
  trigger: WedgeCognitionTrigger,
): WedgePendingRequest | null {
  if (!pendingRequest) {
    return null;
  }
  if (pendingRequest.userId && trigger.userId && pendingRequest.userId !== trigger.userId) {
    return null;
  }
  const ageMs = Date.now() - pendingRequest.createdAt;
  if (pendingRequest.createdAt > 0 && ageMs > 30 * 60 * 1000) {
    return null;
  }
  return pendingRequest;
}

function isUserFacingAction(action: WedgeDecision["actions"][number]): boolean {
  return action.type === "discord_send_message" || action.type === "discord_add_reaction";
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
