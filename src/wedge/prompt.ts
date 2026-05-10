import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wedgeDecisionJsonSchemaDescription } from "./cognition-schema.js";
import type { WedgeDatabase, WedgeShortTermLog } from "./storage.js";

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
    conversation_focus: buildConversationFocus(params.context.trigger, recentLogs),
    salient_facts: buildSalientFacts(recentLogs, nestItems),
    short_term_logs: recentLogs.slice(-4).map(formatShortTermLog),
    core_memory: truncateForPrompt(params.db.getCoreMemoryText(), 1200) || null,
    registry: params.db.listRegistry(8),
    nest_items: nestItems,
    tool_results: (params.context.toolResults ?? []).slice(-4),
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
  return JSON.stringify(
    [
      {
        type: "discord_send_message",
        purpose: "返信、催促、確認、成果物、結果報告をチャンネルへ送る。",
        required: ["target_channel_id", "content"],
      },
      {
        type: "discord_add_reaction",
        purpose: "返信文が不要な短い反応。",
        required: ["target_channel_id", "target_message_id", "emoji"],
      },
      {
        type: "nest_stash",
        purpose: "供物や取得物を巣に保存する。",
        required: ["name", "quantity"],
      },
      {
        type: "nest_consume",
        purpose: "巣のアイテムを食べる、使う、消費する。",
        required: ["item_id or name", "quantity", "reason"],
      },
      {
        type: "nest_update",
        purpose: "巣アイテムの事務的な修正。消費には使わない。",
        required: ["item_id or name"],
      },
      {
        type: "nest_look",
        purpose: "巣の中身確認、参照先確認。",
        required: [],
      },
      {
        type: "update_user_profile",
        purpose: "継続的に覚えるべきユーザー情報を更新する。",
        required: ["user_id"],
      },
      {
        type: "fetch_user_recent_logs",
        purpose: "特定ユーザーの過去発話を取得する。",
        required: ["user_id"],
      },
      {
        type: "fetch_user_avatar_context",
        purpose: "ユーザーアイコンや画像特徴を取得する。",
        required: ["user_id"],
      },
      {
        type: "write_core_memory",
        purpose: "重要で継続的に覚えるべき情報だけを書く。",
        required: ["body"],
      },
      {
        type: "none",
        purpose: "本当に何もしない。",
        required: [],
      },
    ],
    null,
    2,
  );
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
  for (const log of logs.slice(-8)) {
    if (/あげる|渡す|やる|供物|奢る/.test(log.content)) {
      facts.push(`供物らしい発話: ${log.userName ?? log.userId ?? "unknown"} が「${truncateForPrompt(log.content, 120)}」と言った。`);
    }
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
