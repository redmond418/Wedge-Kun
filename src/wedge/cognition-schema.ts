import { z } from "zod";

export const WedgeTriageSchema = z.enum(["ignore", "block", "bored", "continue"]);

export const WedgeActorSchema = z.enum(["wedge", "user", "other", "unclear"]);

export const WedgeInterpretationSchema = z.object({
  user_intent: z.string(),
  referents: z.preprocess(
    (value) => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : value),
    z.array(z.string()).default([]),
  ),
  actor: WedgeActorSchema,
  confidence: z.number().min(0).max(1),
  ambiguity: z.string().nullable(),
});

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
    type: z.literal("nest_consume"),
    item_id: z.number().int().positive().optional(),
    name: z.string().min(1).optional(),
    quantity: z.number().int().min(1).default(1),
    reason: z.string().min(1),
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
  interpretation: WedgeInterpretationSchema,
  triage: WedgeTriageSchema,
  request_level: z.number().int().min(0).max(10),
  offering: WedgeOfferingSchema,
  actions: z.array(WedgeActionSchema).max(12),
  continue_loop: z.boolean(),
  internal_source: z.enum(["normal", "repair"]).optional(),
});

export type WedgeDecision = z.infer<typeof WedgeDecisionSchema>;
export type WedgeAction = z.infer<typeof WedgeActionSchema>;

export function wedgeDecisionOllamaFormatSchema(): object {
  return {
    type: "object",
    additionalProperties: false,
    required: ["thought_summary", "interpretation", "triage", "request_level", "offering", "actions", "continue_loop"],
    properties: {
      thought_summary: { type: "string" },
      interpretation: {
        type: "object",
        additionalProperties: false,
        required: ["user_intent", "referents", "actor", "confidence", "ambiguity"],
        properties: {
          user_intent: { type: "string" },
          referents: { type: "array", items: { type: "string" } },
          actor: { type: "string", enum: ["wedge", "user", "other", "unclear"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          ambiguity: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      triage: { type: "string", enum: ["ignore", "block", "bored", "continue"] },
      request_level: { type: "integer", minimum: 0, maximum: 10 },
      offering: {
        type: "object",
        additionalProperties: false,
        required: ["present", "accepted", "name", "quantity", "satisfaction", "notes"],
        properties: {
          present: { type: "boolean" },
          accepted: { type: "boolean" },
          name: { anyOf: [{ type: "string" }, { type: "null" }] },
          quantity: { type: "integer", minimum: 0 },
          satisfaction: { type: "integer", minimum: 0, maximum: 10 },
          notes: { anyOf: [{ type: "string" }, { type: "null" }] },
        },
      },
      actions: {
        type: "array",
        maxItems: 12,
        items: {
          oneOf: [
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target_channel_id", "content"],
              properties: {
                type: { const: "discord_send_message" },
                target_channel_id: { type: "string" },
                reply_to_message_id: { anyOf: [{ type: "string" }, { type: "null" }] },
                content: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "target_channel_id", "target_message_id", "emoji"],
              properties: {
                type: { const: "discord_add_reaction" },
                target_channel_id: { type: "string" },
                target_message_id: { type: "string" },
                emoji: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "name", "quantity"],
              properties: {
                type: { const: "nest_stash" },
                name: { type: "string" },
                quantity: { type: "integer", minimum: 1 },
                notes: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "quantity", "reason"],
              properties: {
                type: { const: "nest_consume" },
                item_id: { type: "integer", minimum: 1 },
                name: { type: "string" },
                quantity: { type: "integer", minimum: 1 },
                reason: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: {
                type: { const: "nest_update" },
                item_id: { type: "integer", minimum: 1 },
                name: { type: "string" },
                quantity_delta: { type: "integer" },
                notes: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
            },
            { type: "object", additionalProperties: false, required: ["type"], properties: { type: { const: "nest_look" } } },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "user_id"],
              properties: {
                type: { const: "update_user_profile" },
                user_id: { type: "string" },
                call_sign: { anyOf: [{ type: "string" }, { type: "null" }] },
                details: { anyOf: [{ type: "string" }, { type: "null" }] },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "user_id"],
              properties: {
                type: { const: "fetch_user_recent_logs" },
                user_id: { type: "string" },
                limit: { type: "integer", minimum: 1, maximum: 50 },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "user_id"],
              properties: {
                type: { const: "fetch_user_avatar_context" },
                user_id: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type", "body"],
              properties: {
                type: { const: "write_core_memory" },
                body: { type: "string" },
              },
            },
            {
              type: "object",
              additionalProperties: false,
              required: ["type"],
              properties: {
                type: { const: "none" },
                reason: { type: "string" },
              },
            },
          ],
        },
      },
      continue_loop: { type: "boolean" },
      internal_source: { type: "string", enum: ["normal", "repair"] },
    },
  };
}

export function wedgeDecisionJsonSchemaDescription(): string {
  return `{
  "thought_summary": "保存してよい1文の判断要約。hidden thinkingや手順列挙を書かない。",
  "interpretation": {
    "user_intent": "ユーザー発話の意図を短く書く",
    "referents": ["代名詞や省略語が指す候補"],
    "actor": "wedge | user | other | unclear",
    "confidence": 0.0-1.0,
    "ambiguity": "曖昧さがなければnull"
  },
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
    // nest_consume は item_id または name のどちらか一つを必ず指定する
    {"type":"nest_consume","item_id":1,"quantity":1,"reason":"..."},
    {"type":"nest_consume","name":"...","quantity":1,"reason":"..."},
    {"type":"nest_update","item_id":1,"quantity_delta":1,"notes":"..."},
    {"type":"nest_look"},
    {"type":"update_user_profile","user_id":"...","call_sign":"...","details":"..."},
    {"type":"fetch_user_recent_logs","user_id":"...","limit":10},
    {"type":"fetch_user_avatar_context","user_id":"..."},
    {"type":"write_core_memory","body":"..."},
    {"type":"none","reason":"..."}
  ],
  "continue_loop": boolean,
  "internal_source": "normal | repair (optional; internal use)"
}`;
}
