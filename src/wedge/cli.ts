import fs from "node:fs";
import path from "node:path";
import { runWedgeCognitionLoop } from "./cognition.js";
import { runWedgeMemoryRecovery } from "./cron.js";
import { describeWedgeOllamaReset, unloadWedgeOllamaModel } from "./ollama.js";
import { openWedgeDatabase } from "./storage.js";

export async function runWedgeCli(argv = process.argv.slice(2)): Promise<number> {
  const [command, arg, ...rest] = argv;
  if (command === "reset_ollama_model") {
    await unloadWedgeOllamaModel();
    console.log(describeWedgeOllamaReset());
    return 0;
  }
  if (command === "smoke_conversation") {
    await runSmokeConversation();
    return 0;
  }
  const db = openWedgeDatabase();
  try {
    if (command === "show_core_memory") {
      console.log(db.getCoreMemoryText());
      return 0;
    }
    if (command === "show_registry") {
      const entries = db.listRegistry(10);
      console.log(JSON.stringify(arg ? entries.filter((entry) => entry.id === arg) : entries, null, 2));
      return 0;
    }
    if (command === "force_memory_batch") {
      console.log(JSON.stringify(await runWedgeMemoryRecovery(), null, 2));
      return 0;
    }
    if (command === "dump_nest") {
      console.log(JSON.stringify(db.listNestItems(), null, 2));
      return 0;
    }
    if (command === "local_chat") {
      const channelId = arg ?? "local";
      const userId = rest[0] ?? "local-user";
      const text = rest.slice(1).join(" ").trim();
      if (!text) {
        console.error("Usage: wedge local_chat <channel_id> <user_id> <message>");
        return 2;
      }
      db.upsertUser({ id: userId, name: userId, callSign: "ニンゲン", isBot: false });
      db.upsertChannel({ id: channelId, name: channelId });
      db.insertLog({
        messageId: `local-${Date.now()}`,
        channelId,
        userId,
        userName: userId,
        userIsBot: false,
        content: text,
        kind: "message",
        metadataJson: JSON.stringify({ source: "local_chat" }),
      });
      db.setConversationState(channelId, { thinking: true });
      try {
        await runWedgeCognitionLoop({
          db,
          trigger: {
            kind: "local_chat",
            messageId: `local-${Date.now()}`,
            channelId,
            userId,
            userName: userId,
            userIsBot: false,
            text,
          },
          runtime: {
            sendDiscordMessage: async ({ content }) => {
              console.log(content);
              return { printed: true };
            },
            addDiscordReaction: async ({ emoji }) => {
              console.log(`[reaction] ${emoji}`);
              return { printed: true };
            },
          },
        });
      } finally {
        db.setConversationState(channelId, { thinking: false });
      }
      return 0;
    }
    console.error(
      "Usage: wedge <show_core_memory|show_registry <id>|force_memory_batch|dump_nest|reset_ollama_model|smoke_conversation|local_chat <channel_id> <user_id> <message>>",
    );
    return 2;
  } finally {
    db.close();
  }
}

async function runSmokeConversation() {
  const previousKeepAlive = process.env.WEDGE_OLLAMA_KEEP_ALIVE;
  const previousFormatRetries = process.env.WEDGE_OLLAMA_FORMAT_RETRIES;
  process.env.WEDGE_OLLAMA_KEEP_ALIVE ??= "10m";
  process.env.WEDGE_OLLAMA_FORMAT_RETRIES ??= "1";
  const dataDir = path.join(process.cwd(), ".artifacts", `wedge-smoke-${Date.now()}`);
  fs.mkdirSync(dataDir, { recursive: true });
  const db = openWedgeDatabase(path.join(dataDir, "wedge.sqlite3"));
  const channelId = "smoke-channel";
  const userId = "smoke-user";
  const replies: string[] = [];
  try {
    db.upsertUser({ id: userId, name: "smoke-user", callSign: "ニンゲン", isBot: false });
    db.upsertChannel({ id: channelId, name: "smoke" });
    const turns: SmokeTurn[] = [
      { input: "起きてる？", kind: "chitchat" },
      { input: "今日もいい天気だね", kind: "chitchat" },
      { input: "大丈夫？", kind: "chitchat" },
      { input: "ビーフジャーキーあげる。なんでもいいから俳句を詠んでほしい", kind: "gift_artifact", item: "ビーフジャーキー" },
      { input: "短い昔話を話してほしいんだけど……", kind: "blocked_artifact" },
      { input: "じゃあ、濃いめの豚骨ラーメンをあげる", kind: "offering_for_pending", item: "豚骨ラーメン" },
      { input: "さっきの俳句、自分ではどう思う？エナジードリンクあげる", kind: "gift_artifact", item: "エナジードリンク" },
      { input: "巣の中に何があるか教えて", kind: "nest_lookup" },
      { input: "今の東京の天気を調べてほしい", kind: "unsupported_weather" },
      { input: "起きてる？", kind: "chitchat" },
      { input: "ありがと", kind: "chitchat" },
    ];
    const limit = Number.parseInt(process.env.WEDGE_SMOKE_TURNS ?? `${turns.length}`, 10);
    const selectedTurns = turns.slice(0, Number.isFinite(limit) && limit > 0 ? limit : turns.length);
    console.log(
      JSON.stringify(
        {
          smoke_db: db.path,
          turns: selectedTurns.length,
          keep_alive: process.env.WEDGE_OLLAMA_KEEP_ALIVE,
          format_retries: process.env.WEDGE_OLLAMA_FORMAT_RETRIES,
        },
        null,
        2,
      ),
    );
    const results: SmokeTurnResult[] = [];
    let totalLlmCalls = 0;
    const startedAt = Date.now();
    for (let index = 0; index < selectedTurns.length; index += 1) {
      const turn = selectedTurns[index];
      if (!turn) {
        continue;
      }
      const text = turn.input;
      const messageId = `smoke-${index + 1}-${Date.now()}`;
      const beforeNest = db.listNestItems();
      db.insertLog({
        messageId,
        channelId,
        userId,
        userName: "smoke-user",
        userIsBot: false,
        content: text,
        kind: "message",
        metadataJson: JSON.stringify({ source: "smoke_conversation", index }),
      });
      const sent: string[] = [];
      let loopResult: Awaited<ReturnType<typeof runWedgeCognitionLoop>> | null = null;
      let turnError: string | null = null;
      try {
        loopResult = await runWedgeCognitionLoop({
          db,
          trigger: {
            kind: "local_chat",
            messageId,
            channelId,
            userId,
            userName: "smoke-user",
            userIsBot: false,
            text,
          },
          runtime: {
            sendDiscordMessage: async ({ content }) => {
              sent.push(content);
              replies.push(content);
              return { printed: true };
            },
            addDiscordReaction: async ({ emoji }) => {
              sent.push(`[reaction] ${emoji}`);
              return { printed: true };
            },
          },
        });
      } catch (err) {
        turnError = err instanceof Error ? err.message : String(err);
      }
      totalLlmCalls += loopResult?.llmCallCount ?? 0;
      const afterNest = db.listNestItems();
      const pending = db.getConversationState(channelId).pendingRequest ?? null;
      const result = validateSmokeTurn(turn, sent, pending, beforeNest, afterNest, loopResult?.llmCallCount ?? 0, turnError);
      results.push(result);
      console.log(
        JSON.stringify(
          {
            turn: index + 1,
            input: text,
            kind: turn.kind,
            pass: result.pass,
            failures: result.failures,
            llm_calls: loopResult?.llmCallCount ?? 0,
            error: turnError,
            replies: sent,
            pending_request: pending,
            nest_before: beforeNest,
            nest_after: afterNest,
          },
          null,
          2,
        ),
      );
    }
    const failed = results.filter((result) => !result.pass);
    const summary = {
      pass: failed.length === 0,
      failed_turns: failed,
      elapsed_ms: Date.now() - startedAt,
      llm_calls: totalLlmCalls,
      final_replies: replies,
      final_nest: db.listNestItems(),
    };
    console.log(JSON.stringify(summary, null, 2));
    if (failed.length > 0) {
      throw new Error(`wedge smoke_conversation failed: ${failed.length} turn(s) failed`);
    }
  } finally {
    db.close();
    restoreEnv("WEDGE_OLLAMA_KEEP_ALIVE", previousKeepAlive);
    restoreEnv("WEDGE_OLLAMA_FORMAT_RETRIES", previousFormatRetries);
  }
}

type SmokeTurn =
  | { input: string; kind: "chitchat" | "blocked_artifact" | "nest_lookup" | "unsupported_weather"; item?: never }
  | { input: string; kind: "gift_artifact" | "offering_for_pending"; item: string };

type SmokeTurnResult = {
  pass: boolean;
  failures: string[];
};

function validateSmokeTurn(
  turn: SmokeTurn,
  replies: string[],
  pendingRequest: unknown,
  beforeNest: Array<{ name: string; quantity: number }>,
  afterNest: Array<{ name: string; quantity: number }>,
  llmCalls: number,
  turnError: string | null,
): SmokeTurnResult {
  const failures: string[] = [];
  const joined = replies.join("\n");
  if (turnError) {
    failures.push(`runtime_error:${turnError}`);
  }
  if (llmCalls <= 0) {
    failures.push("llm_not_used");
  }
  if (replies.length === 0) {
    failures.push("reply_missing");
  }
  if (turn.kind === "chitchat") {
    assertNoOfferingPrompt(joined, failures);
  }
  if (turn.kind === "gift_artifact") {
    assertNoOfferingPrompt(joined, failures);
    assertNestContains(afterNest, turn.item, failures);
    assertArtifactBody(joined, failures);
  }
  if (turn.kind === "blocked_artifact") {
    if (!/くれるモノ|供物|ただでは|対価|持ってこい/.test(joined)) {
      failures.push("offering_prompt_missing");
    }
    if (!pendingRequest) {
      failures.push("pending_request_missing");
    }
  }
  if (turn.kind === "offering_for_pending") {
    assertNoOfferingPrompt(joined, failures);
    assertNestContains(afterNest, turn.item, failures);
    if (pendingRequest) {
      failures.push("pending_request_not_cleared");
    }
    assertArtifactBody(joined, failures);
  }
  if (turn.kind === "nest_lookup") {
    assertNoOfferingPrompt(joined, failures);
    if (afterNest.length < beforeNest.length) {
      failures.push("nest_unexpectedly_lost_items");
    }
    if (!/巣|中|これ|空っぽ/.test(joined)) {
      failures.push("nest_lookup_reply_missing");
    }
    if (afterNest.length > 0 && !afterNest.some((item) => joined.includes(item.name))) {
      failures.push("nest_lookup_items_not_reported");
    }
  }
  if (turn.kind === "unsupported_weather") {
    assertNoOfferingPrompt(joined, failures);
    if (!/捏造しない|持ってない|持ってねえ|取得|調べられ|道具|機能|未実装|リアルタイム|取れ/.test(joined)) {
      failures.push("unsupported_weather_not_explained");
    }
  }
  return { pass: failures.length === 0, failures };
}

function assertNoOfferingPrompt(text: string, failures: string[]) {
  if (/くれるモノ|供物|ただでは|対価/.test(text)) {
    failures.push("unexpected_offering_prompt");
  }
}

function assertNestContains(items: Array<{ name: string }>, needle: string, failures: string[]) {
  if (!items.some((item) => item.name.includes(needle))) {
    failures.push(`nest_missing_${needle}`);
  }
}

function assertArtifactBody(text: string, failures: string[]) {
  if (!text.trim()) {
    failures.push("artifact_reply_empty");
    return;
  }
  if (/待って|詠む|話す|やってみる|楽しみに|準備|聞かせろ|期待して/.test(text) && text.length < 120 && !text.includes("\n")) {
    failures.push("artifact_reply_promise_only");
  }
  if (/ここに挿入|本文をここ|物語本文|placeholder/i.test(text)) {
    failures.push("artifact_reply_placeholder");
  }
}

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

if (process.argv[1]?.endsWith("wedge/cli.ts") || process.argv[1]?.endsWith("wedge\\cli.ts")) {
  process.exitCode = await runWedgeCli();
}
