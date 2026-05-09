import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { getWedgeDatabasePath } from "./config.js";

const require = createRequire(import.meta.url);
let reportedSqliteFallback = false;

type SqliteParams = Record<string, unknown> | unknown[];
type SqliteStatement = {
  run(...params: [SqliteParams] | unknown[]): unknown;
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
  isBot: z.boolean().optional(),
  guildId: z.string().optional(),
});

const LogInputSchema = z.object({
  messageId: z.string().min(1),
  channelId: z.string().min(1),
  userId: z.string().optional(),
  guildId: z.string().optional(),
  content: z.string(),
  kind: z.enum(["message", "action", "interrupt", "admin"]),
  metadataJson: z.string().optional(),
});

const NestItemSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  quantity: z.number().int().optional(),
});

export type WedgeLogInput = z.infer<typeof LogInputSchema>;
export type WedgeShortTermLog = {
  id: number;
  messageId: string;
  channelId: string;
  userId: string | null;
  guildId: string | null;
  kind: WedgeLogInput["kind"];
  content: string;
  metadataJson: string | null;
  createdAt: number;
  userName: string | null;
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

export type WedgeDatabase = {
  path: string;
  close: () => void;
  upsertUser(input: z.infer<typeof DiscordEntitySchema>): void;
  upsertChannel(input: z.infer<typeof DiscordEntitySchema>): void;
  insertLog(input: WedgeLogInput): void;
  listRecentLogs(channelId: string, limit?: number): WedgeShortTermLog[];
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
  listRegistry(limit?: number): Array<{
    id: string;
    name: string | null;
    callSign: string | null;
    isBot: 0 | 1;
  }>;
  listNestItems(): Array<{ name: string; description: string | null; quantity: number }>;
  upsertNestItem(input: z.infer<typeof NestItemSchema>): void;
  runMemoryBatch(now?: number): { logCount: number };
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
        `INSERT INTO users (id, name, call_sign, is_bot, updated_at)
         VALUES (@id, @name, @callSign, @isBot, unixepoch())
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           call_sign = COALESCE(excluded.call_sign, users.call_sign),
           is_bot = excluded.is_bot,
           updated_at = unixepoch()`,
      ).run({
        id: value.id,
        name: value.name ?? null,
        callSign: value.callSign ?? (value.isBot ? value.name ?? "Bot" : "ニンゲン"),
        isBot: value.isBot ? 1 : 0,
      });
    },
    upsertChannel(input: z.infer<typeof DiscordEntitySchema>) {
      const value = DiscordEntitySchema.parse(input);
      db.prepare(
        `INSERT INTO channels (id, guild_id, name, updated_at)
         VALUES (@id, @guildId, @name, unixepoch())
         ON CONFLICT(id) DO UPDATE SET
           guild_id = excluded.guild_id,
           name = excluded.name,
           updated_at = unixepoch()`,
      ).run({ id: value.id, guildId: value.guildId ?? null, name: value.name ?? null });
    },
    insertLog(input: WedgeLogInput) {
      const value = LogInputSchema.parse(input);
      db.prepare(
        `INSERT INTO short_term_logs
          (message_id, channel_id, user_id, guild_id, kind, content, metadata_json, created_at)
         VALUES
          (@messageId, @channelId, @userId, @guildId, @kind, @content, @metadataJson, unixepoch())`,
      ).run({
        messageId: value.messageId,
        channelId: value.channelId,
        userId: value.userId ?? null,
        guildId: value.guildId ?? null,
        kind: value.kind,
        content: value.content,
        metadataJson: value.metadataJson ?? null,
      });
    },
    listRecentLogs(channelId: string, limit = 20) {
      return db
        .prepare(
          `SELECT l.id,
                  l.message_id AS messageId,
                  l.channel_id AS channelId,
                  l.user_id AS userId,
                  l.guild_id AS guildId,
                  l.kind,
                  l.content,
                  l.metadata_json AS metadataJson,
                  l.created_at AS createdAt,
                  u.name AS userName,
                  u.call_sign AS callSign
           FROM short_term_logs l
           LEFT JOIN users u ON u.id = l.user_id
           WHERE l.channel_id = ?
           ORDER BY l.created_at DESC, l.id DESC
           LIMIT ?`,
        )
        .all(channelId, limit)
        .reverse() as WedgeShortTermLog[];
    },
    appendInterrupt(channelId: string, content: string) {
      db.prepare(
        `INSERT INTO short_term_logs
          (message_id, channel_id, kind, content, created_at)
         VALUES
          (@messageId, @channelId, 'interrupt', @content, unixepoch())`,
      ).run({ messageId: `interrupt-${Date.now()}`, channelId, content });
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
          `SELECT id, name, call_sign AS callSign, is_bot AS isBot
           FROM users ORDER BY updated_at DESC LIMIT ?`,
        )
        .all(limit) as Array<{ id: string; name: string | null; callSign: string | null; isBot: 0 | 1 }>;
    },
    listNestItems() {
      return db
        .prepare("SELECT name, description, quantity FROM nest_items ORDER BY name")
        .all() as Array<{ name: string; description: string | null; quantity: number }>;
    },
    upsertNestItem(input: z.infer<typeof NestItemSchema>) {
      const value = NestItemSchema.parse(input);
      db.prepare(
        `INSERT INTO nest_items (name, description, quantity, updated_at)
         VALUES (@name, @description, @quantity, unixepoch())
         ON CONFLICT(name) DO UPDATE SET
           description = COALESCE(excluded.description, nest_items.description),
           quantity = nest_items.quantity + excluded.quantity,
           updated_at = unixepoch()`,
      ).run({
        name: value.name,
        description: value.description ?? null,
        quantity: value.quantity ?? 1,
      });
    },
    runMemoryBatch(now = Math.floor(Date.now() / 1000)) {
      const logs = db
        .prepare(
          `SELECT content FROM short_term_logs
           WHERE kind IN ('message', 'action', 'interrupt')
           ORDER BY created_at ASC LIMIT 200`,
        )
        .all() as Array<{ content: string }>;
      const previous = this.getCoreMemoryText();
      const summary = logs.map((row) => row.content).join("\n").slice(-8000);
      const next = [previous, summary ? `\n[Daily consolidation]\n${summary}` : ""]
        .join("")
        .trim();
      db.exec("BEGIN IMMEDIATE");
      try {
        this.setCoreMemoryText(next);
        db.prepare(
          "INSERT INTO memory_batch_runs (ran_at, status, log_count) VALUES (?, 'ok', ?)",
        ).run(now, logs.length);
        db.prepare("DELETE FROM short_term_logs WHERE kind IN ('message', 'action', 'interrupt')").run();
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      return { logCount: logs.length };
    },
  };
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
      name TEXT,
      call_sign TEXT,
      is_bot INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      guild_id TEXT,
      name TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS short_term_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      user_id TEXT,
      guild_id TEXT,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS core_memory (
      id TEXT PRIMARY KEY,
      body TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS nest_items (
      name TEXT PRIMARY KEY,
      description TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
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
  `);
  addColumnIfMissing(db, "conversation_state", "last_user_id", "TEXT");
  addColumnIfMissing(db, "conversation_state", "offering_seen_at", "INTEGER");
  addColumnIfMissing(db, "conversation_state", "bored_until", "INTEGER");
}

function addColumnIfMissing(db: SqliteConnection, table: string, column: string, definition: string) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
