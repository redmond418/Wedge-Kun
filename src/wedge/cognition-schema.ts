import { z } from "zod";

export const WedgeTriageSchema = z.enum(["ignore", "block", "bored", "continue"]);

export const WedgeOfferingSchema = z.object({
  present: z.boolean(),
  accepted: z.boolean(),
  name: z.string().nullable(),
  quantity: z.number().int().min(0).default(0),
  satisfaction: z.number().int().min(0).max(10),
  notes: z.string().nullable(),
});

export const WedgeActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("discord_send_message"),
    target_channel_id: z.string().min(1),
    reply_to_message_id: z.string().nullable().optional(),
    content: z.string().min(1),
  }),
  z.object({
    type: z.literal("discord_add_reaction"),
    target_channel_id: z.string().min(1),
    target_message_id: z.string().min(1),
    emoji: z.string().min(1),
  }),
  z.object({
    type: z.literal("nest_stash"),
    name: z.string().min(1),
    quantity: z.number().int().min(1).default(1),
    notes: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("nest_update"),
    item_id: z.number().int().positive().optional(),
    name: z.string().min(1).optional(),
    quantity_delta: z.number().int().default(0),
    notes: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("nest_look"),
  }),
  z.object({
    type: z.literal("update_user_profile"),
    user_id: z.string().min(1),
    call_sign: z.string().nullable().optional(),
    details: z.string().nullable().optional(),
  }),
  z.object({
    type: z.literal("fetch_user_recent_logs"),
    user_id: z.string().min(1),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  z.object({
    type: z.literal("fetch_user_avatar_context"),
    user_id: z.string().min(1),
  }),
  z.object({
    type: z.literal("write_core_memory"),
    body: z.string(),
  }),
  z.object({
    type: z.literal("none"),
    reason: z.string().optional(),
  }),
]);

export const WedgeDecisionSchema = z.object({
  thought_summary: z.string(),
  triage: WedgeTriageSchema,
  request_level: z.number().int().min(0).max(10),
  offering: WedgeOfferingSchema,
  actions: z.array(WedgeActionSchema).max(12),
  continue_loop: z.boolean(),
});

export type WedgeDecision = z.infer<typeof WedgeDecisionSchema>;
export type WedgeAction = z.infer<typeof WedgeActionSchema>;

export function wedgeDecisionJsonSchemaDescription(): string {
  return `{
  "thought_summary": "短い判断要約。raw hidden thinkingではなく、保存してよい要約だけを書く",
  "triage": "ignore | block | bored | continue",
  "request_level": 0-10,
  "offering": {
    "present": boolean,
    "accepted": boolean,
    "name": string | null,
    "quantity": integer,
    "satisfaction": 0-10,
    "notes": string | null
  },
  "actions": [
    {"type":"discord_send_message","target_channel_id":"...","reply_to_message_id":"... or null","content":"..."},
    {"type":"discord_add_reaction","target_channel_id":"...","target_message_id":"...","emoji":"..."},
    {"type":"nest_stash","name":"...","quantity":1,"notes":"..."},
    {"type":"nest_update","item_id":1,"quantity_delta":1,"notes":"..."},
    {"type":"nest_look"},
    {"type":"update_user_profile","user_id":"...","call_sign":"...","details":"..."},
    {"type":"fetch_user_recent_logs","user_id":"...","limit":10},
    {"type":"fetch_user_avatar_context","user_id":"..."},
    {"type":"write_core_memory","body":"..."},
    {"type":"none","reason":"..."}
  ],
  "continue_loop": boolean
}`;
}
