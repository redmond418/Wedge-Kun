import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import type { WedgeAction, WedgeDecision } from "./cognition-schema.js";
import { getWedgeDatabasePath } from "./config.js";

const require = createRequire(import.meta.url);
let reportedSqliteFallback = false;

type SqliteParams = Record<string, unknown> | unknown[];
type SqliteStatement = {
  run(...params: [SqliteParams] | unknown[]): { lastInsertRowid?: number | bigint } | unknown;
  get(...params: [SqliteParams] | unknown[]): unknown;
  all(...params: [SqliteParams] | unknown[]): unknown[];
};
type SqliteConnection = {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  pragma?(sql: string): void;
  close(): void;
};
type NodeSqliteModule = {
  DatabaseSync: new (path: string) => SqliteConnection;
};

const DiscordEntitySchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  callSign: z.string().optional(),
  details: z.string().optional(),
  isBot: z.boolean().optional(),
  guildId: z.string().optional(),
});

const LogInputSchema = z.object({
  messageId: z.string().min(1),
  channelId: z.string().min(1),
  channelName: z.string().optional(),
  userId: z.string().optional(),
  userName: z.string().optional(),
  userIsBot: z.boolean().optional(),
  guildId: z.string().optional(),
  replyToMessageId: z.string().optional(),
  replyToUserId: z.string().optional(),
  attachmentsJson: z.string().optional(),
  content: z.string(),
  kind: z.enum(["message", "action", "interrupt", "admin", "system"]),
  metadataJson: z.string().optional(),
});

const NestItemSchema = z
  .object({
    id: z.number().int().positive().optional(),
    name: z.string().min(1).optional(),
    notes: z.string().optional().nullable(),
    quantity: z.number().int().optional(),
  })
  .refine((value) => value.id !== undefined || value.name !== undefined, {
    message: "nest item requires id or name",
  });

export type WedgeLogInput = z.infer<typeof LogInputSchema>;
export type WedgeShortTermLog = {
  id: number;
  messageId: string;
  channelId: string;
  channelName: string | null;
  userId: string | null;
  userName: string | null;
  userIsBot: 0 | 1;
  guildId: string | null;
  kind: WedgeLogInput["kind"];
  content: string;
  replyToMessageId: string | null;
  replyToUserId: string | null;
  attachmentsJson: string | null;
  metadataJson: string | null;
  createdAt: number;
  callSign: string | null;
};
export type WedgeConversationState = {
  thinking: boolean;
  turnCount: number;
  lastTopic?: string;
  lastUserId?: string;
  lastMessageAt?: number;
  sleepUntil?: number;
  offeringSeenAt?: number;
  boredUntil?: number;
};
export type WedgeRegistryEntry = {
  id: string;
  guildId: string | null;
  name: string | null;
  callSign: string | null;
  details: string | null;
  isBot: 0 | 1;
};
export type WedgeNestItem = {
  id: number;
  name: string;
  notes: string | null;
  quantity: number;
  createdAt: number;
  updatedAt: number;
};

export type WedgeDatabase = {
  path: string;
  close: () => void;
  upsertUser(input: z.infer<typeof DiscordEntitySchema>): void;
  updateUserProfile(input: { id: string; callSign?: string | null; details?: string | null }): void;
  upsertChannel(input: z.infer<typeof DiscordEntitySchema> & { purpose?: string }): void;
  insertLog(input: WedgeLogInput): void;
  listRecentLogs(channelId: string, limit?: number): WedgeShortTermLog[];
  listMemoryBatchLogs(limit?: number): WedgeShortTermLog[];
  listUserRecentLogs(userId: string, limit?: number): WedgeShortTermLog[];
  deleteShortTermLogsThrough(maxId: number): void;
  appendInterrupt(channelId: string, content: string): void;
  setConversationState(
    channelId: string,
    patch: {
      thinking?: boolean;
      sleepUntil?: number | null;
      turnCount?: number;
      lastTopic?: string | null;
      lastUserId?: string | null;
      offeringSeenAt?: number | null;
      boredUntil?: number | null;
    },
  ): void;
  getConversationState(channelId: string): WedgeConversationState;
  resetConversation(channelId?: string): void;
  getCoreMemoryText(): string;
  setCoreMemoryText(body: string): void;
  listRegistry(limit?: number): WedgeRegistryEntry[];
  listNestItems(): WedgeNestItem[];
  upsertNestItem(input: z.infer<typeof NestItemSchema>): WedgeNestItem;
  consumeNestItem(input: { id?: number; name?: string; quantity: number; reason: string }): WedgeNestItem;
  runMemoryBatch(now?: number): { logCount: number };
  createCognitionRun(input: { triggerMessageId?: string; channelId: string; userId?: string }): number;
  insertCognitionStep(input: {
    runId: number;
    iteration: number;
    prompt: string;
    decision?: WedgeDecision;
    action?: WedgeAction;
    resultJson?: string;
    error?: string;
  }): void;
};

export function openWedgeDatabase(dbPath = getWedgeDatabasePath()): WedgeDatabase {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = openSqliteConnection(dbPath);
  applyPragma(db, "journal_mode = WAL");
  applyPragma(db, "foreign_keys = ON");
  initializeWedgeSchema(db);
  return {
    path: dbPath,
    close: () => db.close(),
    upsertUser(input: z.infer<typeof DiscordEntitySchema>) {
      const value = DiscordEntitySchema.parse(input);
      db.prepare(
        `INSERT INTO users (id, guild_id, name, call_sign, details, is_bot, updated_at)
         VALUES (@id, @guildId, @name, @callSign, @details, @isBot, unixepoch())
         ON CONFLICT(id) DO UPDATE SET
           guild_id = COALESCE(excluded.guild_id, users.guild_id),
           name = excluded.name,
           call_sign = COALESCE(excluded.call_sign, users.call_sign),
           details = COALESCE(excluded.details, users.details),
           is_bot = excluded.is_bot,
           updated_at = unixepoch()`,
      ).run({
        id: value.id,
        guildId: value.guildId ?? null,
        name: value.name ?? null,
        callSign: value.callSign ?? (value.isBot ? value.name ?? "Bot" : "ニンゲン"),
        details: value.details ?? null,
        isBot: value.isBot ? 1 : 0,
      });
    },
    updateUserProfile(input: { id: string; callSign?: string | null; details?: string | null }) {
      db.prepare(
        `UPDATE users
         SET call_sign = COALESCE(@callSign, call_sign),
             details = COALESCE(@details, details),
             updated_at = unixepoch()
         WHERE id = @id`,
      ).run({ id: input.id, callSign: input.callSign ?? null, details: input.details ?? null });
    },
    upsertChannel(input: z.infer<typeof DiscordEntitySchema> & { purpose?: string }) {
      const value = DiscordEntitySchema.parse(input);
      db.prepare(
        `INSERT INTO channels (id, guild_id, name, purpose, updated_at)
         VALUES (@id, @guildId, @name, @purpose, unixepoch())
         ON CONFLICT(id) DO UPDATE SET
           guild_id = COALESCE(excluded.guild_id, channels.guild_id),
           name = COALESCE(excluded.name, channels.name),
           purpose = COALESCE(excluded.purpose, channels.purpose),
           updated_at = unixepoch()`,
      ).run({
        id: value.id,
        guildId: value.guildId ?? null,
        name: value.name ?? null,
        purpose: input.purpose ?? null,
      });
    },
    insertLog(input: WedgeLogInput) {
      const value = LogInputSchema.parse(input);
      db.prepare(
        `INSERT INTO short_term_logs
          (message_id, channel_id, channel_name, user_id, user_name, user_is_bot, guild_id,
           kind, content, reply_to_message_id, reply_to_user_id, attachments_json, metadata_json, created_at)
         VALUES
          (@messageId, @channelId, @channelName, @userId, @userName, @userIsBot, @guildId,
           @kind, @content, @replyToMessageId, @replyToUserId, @attachmentsJson, @metadataJson, unixepoch())`,
      ).run({
        messageId: value.messageId,
        channelId: value.channelId,
        channelName: value.channelName ?? null,
        userId: value.userId ?? null,
        userName: value.userName ?? null,
        userIsBot: value.userIsBot ? 1 : 0,
        guildId: value.guildId ?? null,
        kind: value.kind,
        content: value.content,
        replyToMessageId: value.replyToMessageId ?? null,
        replyToUserId: value.replyToUserId ?? null,
        attachmentsJson: value.attachmentsJson ?? null,
        metadataJson: value.metadataJson ?? null,
      });
    },
    listRecentLogs(channelId: string, limit = 20) {
      return selectLogs(
        db,
        `WHERE l.channel_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
        [channelId, limit],
      ).reverse();
    },
    listUserRecentLogs(userId: string, limit = 10) {
      return selectLogs(
        db,
        `WHERE l.user_id = ? ORDER BY l.created_at DESC, l.id DESC LIMIT ?`,
        [userId, limit],
      ).reverse();
    },
    listMemoryBatchLogs(limit = 200) {
      return selectLogs(
        db,
        `WHERE l.kind IN ('message', 'action', 'interrupt', 'system')
         ORDER BY l.created_at ASC, l.id ASC LIMIT ?`,
        [limit],
      );
    },
    deleteShortTermLogsThrough(maxId: number) {
      db.prepare("DELETE FROM short_term_logs WHERE id <= ?").run(maxId);
    },
    appendInterrupt(channelId: string, content: string) {
      this.insertLog({
        messageId: `interrupt-${Date.now()}`,
        channelId,
        kind: "interrupt",
        content,
      });
    },
    setConversationState(
      channelId: string,
      patch: {
        thinking?: boolean;
        sleepUntil?: number | null;
        turnCount?: number;
        lastTopic?: string | null;
        lastUserId?: string | null;
        offeringSeenAt?: number | null;
        boredUntil?: number | null;
      },
    ) {
      const current = this.getConversationState(channelId);
      db.prepare(
        `INSERT INTO conversation_state
          (channel_id, thinking, turn_count, last_topic, last_user_id, last_message_at, sleep_until, offering_seen_at, bored_until)
         VALUES
          (@channelId, @thinking, @turnCount, @lastTopic, @lastUserId, unixepoch(), @sleepUntil, @offeringSeenAt, @boredUntil)
         ON CONFLICT(channel_id) DO UPDATE SET
           thinking = excluded.thinking,
           turn_count = excluded.turn_count,
           last_topic = excluded.last_topic,
           last_user_id = excluded.last_user_id,
           last_message_at = excluded.last_message_at,
           sleep_until = excluded.sleep_until,
           offering_seen_at = excluded.offering_seen_at,
           bored_until = excluded.bored_until`,
      ).run({
        channelId,
        thinking: (patch.thinking ?? current.thinking) ? 1 : 0,
        turnCount: patch.turnCount ?? current.turnCount,
        lastTopic: patch.lastTopic === undefined ? (current.lastTopic ?? null) : patch.lastTopic,
        lastUserId: patch.lastUserId === undefined ? (current.lastUserId ?? null) : patch.lastUserId,
        sleepUntil: patch.sleepUntil === undefined ? (current.sleepUntil ?? null) : patch.sleepUntil,
        offeringSeenAt:
          patch.offeringSeenAt === undefined ? (current.offeringSeenAt ?? null) : patch.offeringSeenAt,
        boredUntil: patch.boredUntil === undefined ? (current.boredUntil ?? null) : patch.boredUntil,
      });
    },
    getConversationState(channelId: string) {
      const row = db
        .prepare(
          `SELECT thinking,
                  turn_count AS turnCount,
                  last_topic AS lastTopic,
                  last_user_id AS lastUserId,
                  last_message_at AS lastMessageAt,
                  sleep_until AS sleepUntil,
                  offering_seen_at AS offeringSeenAt,
                  bored_until AS boredUntil
           FROM conversation_state WHERE channel_id = ?`,
        )
        .get(channelId) as
        | {
            thinking: number;
            turnCount: number;
            lastTopic: string | null;
            lastUserId: string | null;
            lastMessageAt: number | null;
            sleepUntil: number | null;
            offeringSeenAt: number | null;
            boredUntil: number | null;
          }
        | undefined;
      return {
        thinking: row?.thinking === 1,
        turnCount: row?.turnCount ?? 0,
        lastTopic: row?.lastTopic ?? undefined,
        lastUserId: row?.lastUserId ?? undefined,
        lastMessageAt: row?.lastMessageAt ?? undefined,
        sleepUntil: row?.sleepUntil ?? undefined,
        offeringSeenAt: row?.offeringSeenAt ?? undefined,
        boredUntil: row?.boredUntil ?? undefined,
      };
    },
    resetConversation(channelId?: string) {
      if (channelId) {
        db.prepare("DELETE FROM conversation_state WHERE channel_id = ?").run(channelId);
        return;
      }
      db.prepare("DELETE FROM conversation_state").run();
    },
    getCoreMemoryText() {
      const row = db
        .prepare("SELECT body FROM core_memory WHERE id = 'default'")
        .get() as { body: string } | undefined;
      return row?.body ?? "";
    },
    setCoreMemoryText(body: string) {
      db.prepare(
        `INSERT INTO core_memory (id, body, updated_at)
         VALUES ('default', ?, unixepoch())
         ON CONFLICT(id) DO UPDATE SET body = excluded.body, updated_at = unixepoch()`,
      ).run(body);
    },
    listRegistry(limit = 10) {
      return db
        .prepare(
          `SELECT id, guild_id AS guildId, name, call_sign AS callSign, details, is_bot AS isBot
           FROM users ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(limit) as WedgeRegistryEntry[];
    },
    listNestItems() {
      return db
        .prepare(
          `SELECT id, name, notes, quantity, created_at AS createdAt, updated_at AS updatedAt
           FROM nest_items ORDER BY updated_at DESC, id DESC`,
        )
        .all() as WedgeNestItem[];
    },
    upsertNestItem(input: z.infer<typeof NestItemSchema>) {
      const value = NestItemSchema.parse(input);
      if (value.id) {
        db.prepare(
          `UPDATE nest_items
           SET name = COALESCE(@name, name),
               notes = COALESCE(@notes, notes),
               quantity = MAX(0, quantity + @quantity),
               updated_at = unixepoch()
           WHERE id = @id`,
        ).run({
          id: value.id,
          name: value.name ?? null,
          notes: value.notes ?? null,
          quantity: value.quantity ?? 0,
        });
        const row = db
          .prepare(
            `SELECT id, name, notes, quantity, created_at AS createdAt, updated_at AS updatedAt
             FROM nest_items WHERE id = ?`,
          )
          .get(value.id) as WedgeNestItem | undefined;
        if (row) {
          return row;
        }
      }
      if (!value.name) {
        throw new Error("nest item not found");
      }
      const existing = db
        .prepare(
          `SELECT id, name, notes, quantity, created_at AS createdAt, updated_at AS updatedAt
           FROM nest_items WHERE name = ?`,
        )
        .get(value.name) as WedgeNestItem | undefined;
      if (existing) {
        db.prepare(
          `UPDATE nest_items
           SET notes = COALESCE(@notes, notes),
               quantity = MAX(0, quantity + @quantity),
               updated_at = unixepoch()
           WHERE id = @id`,
        ).run({ id: existing.id, notes: value.notes ?? null, quantity: value.quantity ?? 1 });
        return {
          ...existing,
          notes: value.notes ?? existing.notes,
          quantity: Math.max(0, existing.quantity + (value.quantity ?? 1)),
          updatedAt: Math.floor(Date.now() / 1000),
        };
      }
      const result = db
        .prepare(
          `INSERT INTO nest_items (name, notes, quantity, created_at, updated_at)
           VALUES (@name, @notes, @quantity, unixepoch(), unixepoch())`,
        )
        .run({ name: value.name, notes: value.notes ?? null, quantity: value.quantity ?? 1 });
      const id = getLastInsertRowId(result);
      return {
        id,
        name: value.name,
        notes: value.notes ?? null,
        quantity: value.quantity ?? 1,
        createdAt: Math.floor(Date.now() / 1000),
        updatedAt: Math.floor(Date.now() / 1000),
      };
    },
    consumeNestItem(input: { id?: number; name?: string; quantity: number; reason: string }) {
      const quantity = Math.max(1, Math.trunc(input.quantity));
      const row = input.id
        ? (db
            .prepare(
              `SELECT id, name, notes, quantity, created_at AS createdAt, updated_at AS updatedAt
               FROM nest_items WHERE id = ?`,
            )
            .get(input.id) as WedgeNestItem | undefined)
        : (db
            .prepare(
              `SELECT id, name, notes, quantity, created_at AS createdAt, updated_at AS updatedAt
               FROM nest_items WHERE name = ?`,
            )
            .get(input.name ?? "") as WedgeNestItem | undefined);
      if (!row) {
        throw new Error("nest item not found");
      }
      const nextQuantity = Math.max(0, row.quantity - quantity);
      const nextNotes = [row.notes, `消費: ${input.reason}`].filter(Boolean).join("\n");
      db.prepare(
        `UPDATE nest_items
         SET quantity = @quantity,
             notes = @notes,
             updated_at = unixepoch()
         WHERE id = @id`,
      ).run({ id: row.id, quantity: nextQuantity, notes: nextNotes });
      return {
        ...row,
        quantity: nextQuantity,
        notes: nextNotes,
        updatedAt: Math.floor(Date.now() / 1000),
      };
    },
    runMemoryBatch(now = Math.floor(Date.now() / 1000)) {
      const logs = selectLogs(
        db,
        `WHERE l.kind IN ('message', 'action', 'interrupt', 'system')
         ORDER BY l.created_at ASC, l.id ASC LIMIT 200`,
        [],
      );
      db.prepare(
        "INSERT INTO memory_batch_runs (ran_at, status, log_count) VALUES (?, 'completed', ?)",
      ).run(now, logs.length);
      return { logCount: logs.length };
    },
    createCognitionRun(input: { triggerMessageId?: string; channelId: string; userId?: string }) {
      const result = db
        .prepare(
          `INSERT INTO cognition_runs (trigger_message_id, channel_id, user_id, started_at, status)
           VALUES (@triggerMessageId, @channelId, @userId, unixepoch(), 'running')`,
        )
        .run({
          triggerMessageId: input.triggerMessageId ?? null,
          channelId: input.channelId,
          userId: input.userId ?? null,
        });
      return getLastInsertRowId(result);
    },
    insertCognitionStep(input: {
      runId: number;
      iteration: number;
      prompt: string;
      decision?: WedgeDecision;
      action?: WedgeAction;
      resultJson?: string;
      error?: string;
    }) {
      db.prepare(
        `INSERT INTO cognition_steps
          (run_id, iteration, prompt, decision_json, action_json, result_json, error, created_at)
         VALUES
          (@runId, @iteration, @prompt, @decisionJson, @actionJson, @resultJson, @error, unixepoch())`,
      ).run({
        runId: input.runId,
        iteration: input.iteration,
        prompt: input.prompt,
        decisionJson: input.decision ? JSON.stringify(input.decision) : null,
        actionJson: input.action ? JSON.stringify(input.action) : null,
        resultJson: input.resultJson ?? null,
        error: input.error ?? null,
      });
    },
  };
}

function selectLogs(db: SqliteConnection, whereSql: string, params: unknown[]): WedgeShortTermLog[] {
  return db
    .prepare(
      `SELECT l.id,
              l.message_id AS messageId,
              l.channel_id AS channelId,
              l.channel_name AS channelName,
              l.user_id AS userId,
              COALESCE(l.user_name, u.name) AS userName,
              l.user_is_bot AS userIsBot,
              l.guild_id AS guildId,
              l.kind,
              l.content,
              l.reply_to_message_id AS replyToMessageId,
              l.reply_to_user_id AS replyToUserId,
              l.attachments_json AS attachmentsJson,
              l.metadata_json AS metadataJson,
              l.created_at AS createdAt,
              u.call_sign AS callSign
       FROM short_term_logs l
       LEFT JOIN users u ON u.id = l.user_id
       ${whereSql}`,
    )
    .all(...params) as WedgeShortTermLog[];
}

function openSqliteConnection(dbPath: string): SqliteConnection {
  try {
    return new Database(dbPath);
  } catch (err) {
    const nodeSqlite = require("node:sqlite") as NodeSqliteModule;
    if (!reportedSqliteFallback) {
      reportedSqliteFallback = true;
      const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
      console.warn(`[wedge] better-sqlite3 unavailable; falling back to node:sqlite: ${detail}`);
    }
    return new nodeSqlite.DatabaseSync(dbPath);
  }
}

function getLastInsertRowId(result: unknown): number {
  if (result && typeof result === "object" && "lastInsertRowid" in result) {
    const value = (result as { lastInsertRowid?: number | bigint }).lastInsertRowid;
    return Number(value ?? 0);
  }
  return 0;
}

function applyPragma(db: SqliteConnection, sql: string) {
  if (db.pragma) {
    db.pragma(sql);
    return;
  }
  db.exec(`PRAGMA ${sql}`);
}

function initializeWedgeSchema(db: SqliteConnection) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      name TEXT,
      call_sign TEXT,
      details TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      name TEXT,
      purpose TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS short_term_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      user_id TEXT,
      user_name TEXT,
      user_is_bot INTEGER NOT NULL DEFAULT 0,
      guild_id TEXT,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      reply_to_message_id TEXT,
      reply_to_user_id TEXT,
      attachments_json TEXT,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS core_memory (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nest_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      notes TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversation_state (
      channel_id TEXT PRIMARY KEY,
      thinking INTEGER NOT NULL DEFAULT 0,
      turn_count INTEGER NOT NULL DEFAULT 0,
      last_topic TEXT,
      last_user_id TEXT,
      last_message_at INTEGER,
      sleep_until INTEGER,
      offering_seen_at INTEGER,
      bored_until INTEGER
    );
    CREATE TABLE IF NOT EXISTS memory_batch_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ran_at INTEGER NOT NULL,
      status TEXT NOT NULL,
      log_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS cognition_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trigger_message_id TEXT,
      channel_id TEXT NOT NULL,
      user_id TEXT,
      started_at INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cognition_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      iteration INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      decision_json TEXT,
      action_json TEXT,
      result_json TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );
  `);
  addColumnIfMissing(db, "users", "guild_id", "TEXT");
  addColumnIfMissing(db, "users", "details", "TEXT");
  addColumnIfMissing(db, "channels", "purpose", "TEXT");
  addColumnIfMissing(db, "short_term_logs", "channel_name", "TEXT");
  addColumnIfMissing(db, "short_term_logs", "user_name", "TEXT");
  addColumnIfMissing(db, "short_term_logs", "user_is_bot", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "short_term_logs", "reply_to_message_id", "TEXT");
  addColumnIfMissing(db, "short_term_logs", "reply_to_user_id", "TEXT");
  addColumnIfMissing(db, "short_term_logs", "attachments_json", "TEXT");
  addColumnIfMissing(db, "conversation_state", "last_user_id", "TEXT");
  addColumnIfMissing(db, "conversation_state", "offering_seen_at", "INTEGER");
  addColumnIfMissing(db, "conversation_state", "bored_until", "INTEGER");
  addColumnIfMissing(db, "nest_items", "id", "INTEGER");
  addColumnIfMissing(db, "nest_items", "notes", "TEXT");
  addColumnIfMissing(db, "nest_items", "created_at", "INTEGER");
  addColumnIfMissing(db, "nest_items", "updated_at", "INTEGER");
}

function addColumnIfMissing(db: SqliteConnection, table: string, column: string, definition: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
