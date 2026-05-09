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
  const registry = params.db.listRegistry(10);
  const recentLogs = params.context.recentLogs ?? params.db.listRecentLogs(params.context.trigger.channelId, 20);
  const payload = {
    now: (params.context.now ?? new Date()).toISOString(),
    iteration: params.context.iteration,
    trigger: params.context.trigger,
    core_memory: params.db.getCoreMemoryText() || null,
    short_term_logs: recentLogs.map(formatShortTermLog),
    registry,
    nest_items: params.db.listNestItems(),
    tool_results: params.context.toolResults ?? [],
  };
  return [
    "[persona]",
    persona,
    "",
    "[rules]",
    cognitionRules,
    "",
    "[context_json]",
    JSON.stringify(payload, null, 2),
    "",
    "[available_actions]",
    [
      "discord_send_message",
      "discord_add_reaction",
      "nest_stash",
      "nest_update",
      "nest_look",
      "update_user_profile",
      "fetch_user_recent_logs",
      "fetch_user_avatar_context",
      "write_core_memory",
      "none",
    ].join(", "),
    "",
    "[output_schema]",
    wedgeDecisionJsonSchemaDescription(),
  ].join("\n");
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
      content: log.content,
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
