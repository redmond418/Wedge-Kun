import type { WedgeAction } from "./cognition-schema.js";
import type { WedgeDatabase } from "./storage.js";

export type WedgeActionRuntime = {
  sendDiscordMessage?: (params: {
    channelId: string;
    content: string;
    replyToMessageId?: string | null;
  }) => Promise<unknown>;
  addDiscordReaction?: (params: {
    channelId: string;
    messageId: string;
    emoji: string;
  }) => Promise<unknown>;
  fetchUserAvatarContext?: (userId: string) => Promise<unknown>;
};

export async function executeWedgeAction(params: {
  db: WedgeDatabase;
  action: WedgeAction;
  runtime?: WedgeActionRuntime;
  defaultChannelId: string;
}): Promise<{ ok: boolean; result: unknown }> {
  const { db, action, runtime } = params;
  switch (action.type) {
    case "discord_send_message": {
      const sent = await runtime?.sendDiscordMessage?.({
        channelId: action.target_channel_id,
        content: action.content,
        replyToMessageId: action.reply_to_message_id ?? null,
      });
      db.insertLog({
        messageId: `wedge-action-${Date.now()}`,
        channelId: action.target_channel_id,
        content: action.content,
        kind: "action",
        metadataJson: JSON.stringify({ action: action.type, sent }),
      });
      return { ok: true, result: sent ?? { skipped: "send runtime unavailable" } };
    }
    case "discord_add_reaction": {
      const reacted = await runtime?.addDiscordReaction?.({
        channelId: action.target_channel_id,
        messageId: action.target_message_id,
        emoji: action.emoji,
      });
      return { ok: true, result: reacted ?? { skipped: "reaction runtime unavailable" } };
    }
    case "nest_stash": {
      const item = db.upsertNestItem({
        name: action.name,
        quantity: action.quantity,
        notes: action.notes ?? null,
      });
      return { ok: true, result: item };
    }
    case "nest_consume": {
      if (!action.item_id && !action.name) {
        return { ok: false, result: { error: "nest_consume requires item_id or name" } };
      }
      const item = db.consumeNestItem({
        id: action.item_id,
        name: action.name,
        quantity: action.quantity,
        reason: action.reason,
      });
      db.insertLog({
        messageId: `wedge-nest-consume-${Date.now()}`,
        channelId: params.defaultChannelId,
        content: `${item.name} x${action.quantity} consumed: ${action.reason}`,
        kind: "action",
        metadataJson: JSON.stringify({ action: action.type, item }),
      });
      return { ok: true, result: item };
    }
    case "nest_update": {
      if (!action.item_id && !action.name) {
        return { ok: false, result: { error: "nest_update requires item_id or name" } };
      }
      const item = db.upsertNestItem({
        id: action.item_id,
        name: action.name,
        quantity: action.quantity_delta,
        notes: action.notes ?? null,
      });
      return { ok: true, result: item };
    }
    case "nest_look":
      return { ok: true, result: db.listNestItems() };
    case "update_user_profile": {
      db.updateUserProfile({
        id: action.user_id,
        callSign: action.call_sign ?? null,
        details: action.details ?? null,
      });
      return { ok: true, result: { user_id: action.user_id, updated: true } };
    }
    case "fetch_user_recent_logs":
      return { ok: true, result: db.listUserRecentLogs(action.user_id, action.limit) };
    case "fetch_user_avatar_context": {
      const result = await runtime?.fetchUserAvatarContext?.(action.user_id);
      return { ok: true, result: result ?? { unavailable: true, user_id: action.user_id } };
    }
    case "write_core_memory":
      db.setCoreMemoryText(action.body);
      return { ok: true, result: { written: true } };
    case "none":
      return { ok: true, result: { reason: action.reason ?? "none" } };
  }
}
