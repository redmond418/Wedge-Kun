import { z } from "zod";
import type { WedgeDatabase } from "./storage.js";

const SleepCommandSchema = z.object({
  minutes: z.number().int().min(1).max(1440),
  channelId: z.string().min(1),
});

export function parseWedgeAdminCommand(text: string):
  | { kind: "sleep"; minutes: number }
  | { kind: "reset" }
  | undefined {
  const trimmed = text.trim();
  const sleep = /^!wedge_sleep\s+(\d+)$/i.exec(trimmed);
  if (sleep) {
    return { kind: "sleep", minutes: Number(sleep[1]) };
  }
  if (/^!wedge_reset$/i.test(trimmed)) {
    return { kind: "reset" };
  }
  return undefined;
}

export function executeWedgeAdminCommand(params: {
  db: WedgeDatabase;
  command: ReturnType<typeof parseWedgeAdminCommand>;
  channelId: string;
}) {
  if (!params.command) {
    return undefined;
  }
  if (params.command.kind === "reset") {
    params.db.resetConversation(params.channelId);
    return "ワシ、頭、戻した";
  }
  const value = SleepCommandSchema.parse({
    minutes: params.command.minutes,
    channelId: params.channelId,
  });
  params.db.setConversationState(value.channelId, {
    sleepUntil: Math.floor(Date.now() / 1000) + value.minutes * 60,
    thinking: false,
  });
  return `ワシ、${value.minutes}分、寝る`;
}
