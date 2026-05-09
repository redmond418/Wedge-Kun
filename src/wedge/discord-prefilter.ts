import { executeWedgeAdminCommand, parseWedgeAdminCommand } from "./admin.js";
import { type WedgeActionRuntime } from "./actions.js";
import { readAdminUserIds, readIgnoredChannelIds } from "./config.js";
import { runWedgeCognitionLoop } from "./cognition.js";
import { openWedgeDatabase } from "./storage.js";

type WedgeDiscordMessage = {
  id?: string;
  content?: string;
  channel_id?: string;
  guild_id?: string;
  author?: { id?: string; username?: string; global_name?: string | null; bot?: boolean } | null;
  attachments?: Array<unknown>;
  referenced_message?: {
    id?: string;
    author?: { id?: string } | null;
  } | null;
  message_reference?: {
    message_id?: string;
  } | null;
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
  runtime?: WedgeActionRuntime;
  repoRoot?: string;
}): Promise<WedgeDiscordPrefilterResult> {
  const message = params.data.message;
  const channelId = message?.channel_id ?? params.data.channel_id;
  const author = message?.author ?? params.data.author;
  const text = message?.content ?? "";
  if (!message?.id || !channelId) {
    return { action: "continue" };
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
    return { action: "continue" };
  }

  try {
    const guildId = message.guild_id ?? params.data.guild_id;
    if (author?.id) {
      db.upsertUser({
        id: author.id,
        name: author.global_name ?? author.username,
        isBot: author.bot,
        guildId,
        callSign: author.bot ? author.username : "ニンゲン",
      });
    }
    db.upsertChannel({ id: channelId, guildId });

    db.insertLog({
      messageId: message.id,
      channelId,
      userId: author?.id,
      userName: author?.global_name ?? author?.username ?? undefined,
      userIsBot: author?.bot ?? false,
      guildId,
      replyToMessageId: message.referenced_message?.id ?? message.message_reference?.message_id,
      replyToUserId: message.referenced_message?.author?.id ?? undefined,
      attachmentsJson: JSON.stringify(message.attachments ?? []),
      content: text,
      kind: "message",
      metadataJson: JSON.stringify({ source: "discord" }),
    });

    if (author?.bot) {
      return { action: "drop", reason: "wedge_bot_message_recorded" };
    }

    const adminCommand = parseWedgeAdminCommand(text);
    if (adminCommand) {
      const admins = readAdminUserIds(params.repoRoot);
      if (!author?.id || !admins.has(author.id)) {
        return { action: "drop", reason: "wedge_admin_denied" };
      }
      const reply = executeWedgeAdminCommand({ db, command: adminCommand, channelId });
      if (reply && params.runtime?.sendDiscordMessage) {
        await params.runtime.sendDiscordMessage({ channelId, content: reply, replyToMessageId: message.id });
      }
      return { action: "handled", reason: "wedge_admin" };
    }

    const now = Math.floor(Date.now() / 1000);
    const state = db.getConversationState(channelId);
    if (state.sleepUntil && state.sleepUntil > now) {
      return { action: "drop", reason: "wedge_sleeping_recorded" };
    }
    if (state.thinking) {
      db.appendInterrupt(
        channelId,
        `[割り込み情報: ${author?.username ?? author?.id ?? "unknown"}: ${text}]`,
      );
      return { action: "drop", reason: "wedge_interrupt_appended" };
    }

    db.setConversationState(channelId, { thinking: true });
    try {
      await runWedgeCognitionLoop({
        db,
        trigger: {
          kind: "discord_message",
          messageId: message.id,
          channelId,
          guildId: guildId ?? null,
          userId: author?.id,
          userName: author?.global_name ?? author?.username ?? null,
          userIsBot: author?.bot ?? false,
          text,
          replyToMessageId: message.referenced_message?.id ?? message.message_reference?.message_id ?? null,
          replyToUserId: message.referenced_message?.author?.id ?? null,
          attachments: message.attachments ?? [],
        },
        runtime: params.runtime,
      });
    } catch (err) {
      console.warn("[wedge] cognition loop failed:", err);
      await params.runtime?.sendDiscordMessage?.({
        channelId,
        replyToMessageId: message.id,
        content: "ワシ、今、頭つまった",
      });
    } finally {
      db.setConversationState(channelId, { thinking: false });
    }
    return { action: "handled", reason: "wedge_cognition" };
  } finally {
    db.close();
  }
}
