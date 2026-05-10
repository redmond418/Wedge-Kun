import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wedgeDecisionJsonSchemaDescription } from "./cognition-schema.js";
import type { WedgeDatabase, WedgePendingRequest, WedgeShortTermLog } from "./storage.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const promptDirs = [
  path.join(moduleDir, "prompts"),
  path.join(process.cwd(), "src", "wedge", "prompts"),
];

export type WedgePromptContext = {
  trigger: {
    kind: "discord_message" | "local_chat" | "memory_batch" | "soliloquy";
    channelId: string;
    channelName?: string | null;
    guildId?: string | null;
    messageId?: string | null;
    userId?: string | null;
    userName?: string | null;
    userIsBot?: boolean;
    text?: string;
    replyToMessageId?: string | null;
    replyToUserId?: string | null;
    attachments?: unknown[];
  };
  now?: Date;
  recentLogs?: WedgeShortTermLog[];
  toolResults?: Array<{ action: string; result: unknown }>;
  pendingRequest?: WedgePendingRequest | null;
  iteration: number;
};

export function buildWedgeSystemPrompt(params: {
  db: WedgeDatabase;
  context: WedgePromptContext;
}): string {
  const persona = readPromptFile("persona.md");
  const cognitionRules = readPromptFile("cognition-system.md");
  const recentLogs = params.context.recentLogs ?? params.db.listRecentLogs(params.context.trigger.channelId, 8);
  const nestItems = params.db.listNestItems();
  const payload = {
    now: (params.context.now ?? new Date()).toISOString(),
    iteration: params.context.iteration,
    trigger: params.context.trigger,
    pending_request: params.context.pendingRequest ?? null,
    conversation_focus: buildConversationFocus(params.context.trigger, recentLogs),
    salient_facts: buildSalientFacts(recentLogs, nestItems),
    short_term_logs: recentLogs.slice(-3).map(formatShortTermLog),
    core_memory: truncateForPrompt(params.db.getCoreMemoryText(), 800) || null,
    registry: params.db.listRegistry(8),
    nest_items: nestItems,
    tool_results: (params.context.toolResults ?? []).slice(-3),
  };
  return [
    "[persona]",
    persona,
    "",
    "[rules]",
    cognitionRules,
    "",
    "[output_schema]",
    wedgeDecisionJsonSchemaDescription(),
    "",
    "[available_actions]",
    formatAvailableActions(),
    "",
    "[context_json]",
    JSON.stringify(payload, null, 2),
  ].join("\n");
}

function formatAvailableActions(): string {
  return [
    "discord_send_message: 返信/催促/確認/成果物/結果報告。required target_channel_id, content。",
    "discord_add_reaction: 文なしの短い反応。required target_channel_id, target_message_id, emoji。",
    "nest_stash: 供物を巣へ保存。required name, quantity。",
    "nest_consume: 巣の物を食べる/使う。required item_id or name, quantity, reason。",
    "nest_look: 巣の中身確認。巣の確認では供物を要求せず、まずこの tool で文脈を取る。",
    "update_user_profile: 継続的ユーザー情報更新。",
    "fetch_user_recent_logs/fetch_user_avatar_context: 追加文脈取得。",
    "write_core_memory: 重要な長期記憶だけ保存。",
    "none: 本当に何もしない時だけ。雑談返信が必要なら使わない。",
  ].join("\n");
}

function buildConversationFocus(trigger: WedgePromptContext["trigger"], logs: WedgeShortTermLog[]) {
  const previousUserLog = [...logs]
    .reverse()
    .find((log) => log.kind === "message" && log.userId && log.userId !== trigger.userId);
  const previousSameUserLog = [...logs]
    .reverse()
    .find((log) => log.kind === "message" && log.userId === trigger.userId && log.messageId !== trigger.messageId);
  const previousWedgeLog = [...logs].reverse().find((log) => log.kind === "action" || log.userIsBot === 1);
  return {
    current_user_text: trigger.text ?? "",
    previous_same_user_message: previousSameUserLog ? formatFocusLog(previousSameUserLog) : null,
    previous_other_message: previousUserLog ? formatFocusLog(previousUserLog) : null,
    previous_wedge_action_or_reply: previousWedgeLog ? formatFocusLog(previousWedgeLog) : null,
  };
}

function formatFocusLog(log: WedgeShortTermLog) {
  return {
    timestamp: log.createdAt,
    message_id: log.messageId,
    author_name: log.userName,
    author_id: log.userId,
    is_bot: log.userIsBot === 1,
    content: truncateForPrompt(log.content, 180),
  };
}

export function formatShortTermLogs(logs: WedgeShortTermLog[]): string {
  return JSON.stringify(logs.map(formatShortTermLog), null, 2);
}

function formatShortTermLog(log: WedgeShortTermLog) {
  return {
    timestamp: log.createdAt,
    kind: log.kind,
    message: {
      id: log.messageId,
      content: truncateForPrompt(log.content, 240),
      reply_to_message_id: log.replyToMessageId,
      reply_to_user_id: log.replyToUserId,
      attachments: parseJson(log.attachmentsJson),
    },
    author: {
      id: log.userId,
      name: log.userName,
      is_bot: log.userIsBot === 1,
      call_sign: log.callSign,
    },
    channel: {
      id: log.channelId,
      name: log.channelName,
      guild_id: log.guildId,
    },
    metadata: parseJson(log.metadataJson),
  };
}

function buildSalientFacts(logs: WedgeShortTermLog[], nestItems: Array<{ name: string; quantity: number }>): string[] {
  const facts: string[] = [];
  const previous = logs.at(-1);
  const beforePrevious = logs.at(-2);
  if (beforePrevious) {
    facts.push(`1つ前の発話: ${beforePrevious.userName ?? beforePrevious.userId ?? "unknown"}: ${truncateForPrompt(beforePrevious.content, 160)}`);
  }
  if (previous) {
    facts.push(`直近発話: ${previous.userName ?? previous.userId ?? "unknown"}: ${truncateForPrompt(previous.content, 160)}`);
  }
  for (const item of nestItems) {
    if (item.quantity > 0) {
      facts.push(`巣アイテム: ${item.name} x${item.quantity}`);
    }
  }
  return facts.slice(-10);
}

function truncateForPrompt(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function readPromptFile(name: string): string {
  for (const dir of promptDirs) {
    const promptPath = path.join(dir, name);
    if (fs.existsSync(promptPath)) {
      return fs.readFileSync(promptPath, "utf8").trim();
    }
  }
  throw new Error(`Wedge prompt file not found: ${name}`);
}

function parseJson(value: string | null): unknown {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
