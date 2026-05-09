import { z } from "zod";
import type { WedgeDatabase } from "./storage.js";

const NestInteractionSchema = z.object({
  target_channel_id: z.string().min(1),
  action: z.enum(["add", "remove", "list", "narrate"]),
  item: z.string().optional(),
  description: z.string().optional(),
  narration: z.string().optional(),
});

export type WedgeNestSend = (targetChannelId: string, text: string) => Promise<void>;

export async function interactWithNest(params: {
  db: WedgeDatabase;
  input: unknown;
  send: WedgeNestSend;
}) {
  const input = NestInteractionSchema.parse(params.input);
  if (input.action === "add" && input.item) {
    params.db.upsertNestItem({ name: input.item, description: input.description, quantity: 1 });
  }
  const text =
    input.narration ??
    (input.action === "list"
      ? `*(ウェッジくんは巣の中身を数える: ${params.db
          .listNestItems()
          .map((item) => `${item.name} x${item.quantity}`)
          .join(", ") || "空"}.)*`
      : `*(ウェッジくんは${input.item ?? "巣"}をいじった.)*`);
  await params.send(input.target_channel_id, text);
  params.db.insertLog({
    messageId: `nest-${Date.now()}`,
    channelId: input.target_channel_id,
    kind: "action",
    content: text,
  });
  return { ok: true, narration: text };
}
