import { z } from "zod";
import type { WedgeDatabase } from "./storage.js";

const NestInteractionSchema = z.object({
  target_channel_id: z.string().min(1),
  action: z.enum(["stash", "update", "look", "narrate"]),
  item_id: z.number().int().positive().optional(),
  name: z.string().optional(),
  quantity: z.number().int().optional(),
  notes: z.string().optional(),
  narration: z.string().optional(),
});

export type WedgeNestSend = (targetChannelId: string, text: string) => Promise<void>;

export async function interactWithNest(params: {
  db: WedgeDatabase;
  input: unknown;
  send: WedgeNestSend;
}) {
  const input = NestInteractionSchema.parse(params.input);
  if (input.action === "stash" && input.name) {
    params.db.upsertNestItem({
      name: input.name,
      notes: input.notes ?? null,
      quantity: input.quantity ?? 1,
    });
  }
  if (input.action === "update" && (input.item_id || input.name)) {
    params.db.upsertNestItem({
      id: input.item_id,
      name: input.name ?? `item:${input.item_id}`,
      notes: input.notes ?? null,
      quantity: input.quantity ?? 0,
    });
  }
  const text =
    input.narration ??
    (input.action === "look"
      ? `*(ウェッジくんは巣の中身を数える: ${params.db
          .listNestItems()
          .map((item) => `${item.name} x${item.quantity}`)
          .join(", ") || "空"}.)*`
      : `*(ウェッジくんは${input.name ?? "巣"}をいじった.)*`);
  await params.send(input.target_channel_id, text);
  params.db.insertLog({
    messageId: `nest-${Date.now()}`,
    channelId: input.target_channel_id,
    kind: "action",
    content: text,
  });
  return { ok: true, narration: text };
}
