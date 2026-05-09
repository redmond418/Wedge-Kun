import { executeWedgeAdminCommand, parseWedgeAdminCommand } from "./admin.js";
import { readAdminUserIds, readIgnoredChannelIds } from "./config.js";
import { generateWedgeOllamaReply } from "./ollama.js";
import { buildWedgeSystemPrompt } from "./prompt.js";
import { openWedgeDatabase } from "./storage.js";
import { triageWedgeMessage } from "./triage.js";

type WedgeDiscordMessage = {
  id?: string;
  content?: string;
  channel_id?: string;
  guild_id?: string;
  author?: { id?: string; username?: string; global_name?: string | null; bot?: boolean } | null;
  attachments?: Array<unknown>;
};

type WedgeDiscordEvent = {
  message?: WedgeDiscordMessage;
  author?: WedgeDiscordMessage["author"];
  channel_id?: string;
  guild_id?: string;
};

export type WedgeDiscordPrefilterResult =
  | { action: "continue" }
  | { action: "drop"; reason: string }
  | { action: "handled"; reason: string };

export async function runWedgeDiscordPrefilter(params: {
  data: WedgeDiscordEvent;
  sendReply?: (channelId: string, text: string) => Promise<void>;
  repoRoot?: string;
}): Promise<WedgeDiscordPrefilterResult> {
  const message = params.data.message;
  const channelId = message?.channel_id ?? params.data.channel_id;
  const author = message?.author ?? params.data.author;
  const text = message?.content ?? "";
  if (!message?.id || !channelId) {
    return { action: "continue" };
  }
  if (author?.bot) {
    return { action: "drop", reason: "wedge_bot_message" };
  }

  const ignored = readIgnoredChannelIds(params.repoRoot);
  if (text.startsWith(":") || text.startsWith("：") || ignored.has(channelId)) {
    return { action: "drop", reason: "wedge_ignored" };
  }

  console.log(
    `[wedge] inbound message id=${message.id} channel=${channelId} contentLength=${text.length}`,
  );

  let db: ReturnType<typeof openWedgeDatabase>;
  try {
    db = openWedgeDatabase();
  } catch (err) {
    console.warn("[wedge] sqlite unavailable in discord prefilter:", err);
    const adminCommand = parseWedgeAdminCommand(text);
    if (adminCommand && params.sendReply) {
      await params.sendReply(channelId, "ワシ、記憶DB、開けない");
      return { action: "handled", reason: "wedge_admin_db_unavailable" };
    }
    return { action: "continue" };
  }

  try {
    if (author?.id) {
      db.upsertUser({
        id: author.id,
        name: author.global_name ?? author.username,
        isBot: author.bot,
        callSign: author.bot ? author.username : "ニンゲン",
      });
    }
    db.upsertChannel({ id: channelId, guildId: message.guild_id ?? params.data.guild_id });

    const adminCommand = parseWedgeAdminCommand(text);
    if (adminCommand) {
      const admins = readAdminUserIds(params.repoRoot);
      if (!author?.id || !admins.has(author.id)) {
        return { action: "drop", reason: "wedge_admin_denied" };
      }
      const reply = executeWedgeAdminCommand({ db, command: adminCommand, channelId });
      if (reply && params.sendReply) {
        await params.sendReply(channelId, reply);
      }
      db.insertLog({
        messageId: message.id,
        channelId,
        userId: author?.id,
        guildId: message.guild_id ?? params.data.guild_id,
        content: text,
        kind: "admin",
      });
      return { action: "handled", reason: "wedge_admin" };
    }

    const now = Math.floor(Date.now() / 1000);
    const state = db.getConversationState(channelId);
    if (state.sleepUntil && state.sleepUntil > now) {
      return { action: "drop", reason: "wedge_sleeping" };
    }

    db.insertLog({
      messageId: message.id,
      channelId,
      userId: author?.id,
      guildId: message.guild_id ?? params.data.guild_id,
      content: text,
      kind: "message",
      metadataJson: JSON.stringify({ attachmentCount: message.attachments?.length ?? 0 }),
    });

    const recentLogs = db.listRecentLogs(channelId, 24);
    const triage = triageWedgeMessage({
      text,
      authorId: author?.id,
      state,
      recentLogs,
      now,
    });
    if (triage.action === "block") {
      if (params.sendReply) {
        await params.sendReply(channelId, triage.reply);
      }
      db.insertLog({
        messageId: `wedge-reply-${message.id}`,
        channelId,
        userId: undefined,
        guildId: message.guild_id ?? params.data.guild_id,
        content: triage.reply,
        kind: "action",
        metadataJson: JSON.stringify({ triage: triage.reason }),
      });
      return { action: "handled", reason: `wedge_${triage.reason}` };
    }
    if (triage.action === "bored") {
      db.setConversationState(channelId, { boredUntil: triage.statePatch.boredUntil, thinking: false });
      if (params.sendReply) {
        await params.sendReply(channelId, triage.reply);
      }
      db.insertLog({
        messageId: `wedge-reply-${message.id}`,
        channelId,
        userId: undefined,
        guildId: message.guild_id ?? params.data.guild_id,
        content: triage.reply,
        kind: "action",
        metadataJson: JSON.stringify({ triage: triage.reason }),
      });
      return { action: "handled", reason: `wedge_${triage.reason}` };
    }

    if (triage.flags.offeringSeen) {
      db.upsertNestItem({
        name: `供物:${message.id}`,
        description: text.slice(0, 500),
        quantity: 1,
      });
    }

    if (state.thinking) {
      db.appendInterrupt(
        channelId,
        `[割り込み情報: ${author?.username ?? author?.id ?? "unknown"}: ${text}]`,
      );
      return { action: "drop", reason: "wedge_interrupt_appended" };
    }

    if (!params.sendReply) {
      return { action: "continue" };
    }

    db.setConversationState(channelId, { ...triage.statePatch, thinking: true });
    try {
      console.log(
        `[wedge] ollama direct start message=${message.id} requestLike=${triage.flags.requestLike} offeringSeen=${triage.flags.offeringSeen} sameTopic=${triage.flags.sameTopic}`,
      );
      const promptLogs = db.listRecentLogs(channelId, 24);
      const reply = await generateWedgeOllamaReply({
        systemPrompt: buildWedgeSystemPrompt({
          db,
          channelId,
          imageCount: message.attachments?.length ?? 0,
          recentLogs: promptLogs,
          conversationControl: triage.flags,
        }),
        userText: text,
      });
      console.log(`[wedge] ollama direct done message=${message.id} replyLength=${reply.length}`);
      await params.sendReply(channelId, reply);
      db.insertLog({
        messageId: `wedge-reply-${message.id}`,
        channelId,
        userId: undefined,
        guildId: message.guild_id ?? params.data.guild_id,
        content: reply,
        kind: "action",
        metadataJson: JSON.stringify({ source: "ollama_direct" }),
      });
    } catch (err) {
      console.warn("[wedge] ollama direct failed:", err);
      const fallback = "ワシ、今、頭つまった";
      await params.sendReply(channelId, fallback);
      db.insertLog({
        messageId: `wedge-error-${message.id}`,
        channelId,
        userId: undefined,
        guildId: message.guild_id ?? params.data.guild_id,
        content: fallback,
        kind: "action",
        metadataJson: JSON.stringify({ source: "ollama_error" }),
      });
    } finally {
      db.setConversationState(channelId, { thinking: false });
    }
    return { action: "handled", reason: "wedge_ollama_direct" };
  } finally {
    db.close();
  }
}
