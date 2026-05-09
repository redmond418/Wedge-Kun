import { describe, expect, it } from "vitest";
import { triageWedgeMessage } from "./triage.js";
import type { WedgeConversationState, WedgeShortTermLog } from "./storage.js";

const emptyState: WedgeConversationState = { thinking: false, turnCount: 0 };

function log(content: string, createdAt = 100, userId = "u1"): WedgeShortTermLog {
  return {
    id: 1,
    messageId: "m1",
    channelId: "c1",
    userId,
    guildId: null,
    kind: "message",
    content,
    metadataJson: null,
    createdAt,
    userName: "User",
    callSign: "ニンゲン",
  };
}

describe("triageWedgeMessage", () => {
  it("blocks requests without offerings", () => {
    expect(triageWedgeMessage({ text: "これを直して", state: emptyState }).action).toBe("block");
  });

  it("allows requests with offerings in the current message", () => {
    expect(
      triageWedgeMessage({ text: "お礼を渡すから直して", state: emptyState, now: 100 }),
    ).toMatchObject({
      action: "continue",
      flags: { offeringSeen: true },
    });
  });

  it("allows requests when an offering exists in recent short-term logs", () => {
    expect(
      triageWedgeMessage({
        text: "それでお願い",
        authorId: "u1",
        state: { thinking: false, turnCount: 1, lastMessageAt: 100, lastUserId: "u1" },
        recentLogs: [log("お礼を渡す", 110)],
        now: 120,
      }),
    ).toMatchObject({
      action: "continue",
      flags: { offeringSeen: true },
    });
  });

  it("does not get bored across a different topic", () => {
    expect(
      triageWedgeMessage({
        text: "最近の技術ニュースを教えて",
        authorId: "u1",
        state: {
          thinking: false,
          turnCount: 5,
          lastTopic: "古い物語について",
          lastUserId: "u1",
          lastMessageAt: 100,
        },
        now: 120,
      }).action,
    ).toBe("block");
  });

  it("gets bored only after the same user and same topic keep going", () => {
    expect(
      triageWedgeMessage({
        text: "物語の続きをお願い",
        authorId: "u1",
        state: {
          thinking: false,
          turnCount: 5,
          lastTopic: "物語の続きをお願い",
          lastUserId: "u1",
          lastMessageAt: 100,
        },
        now: 120,
      }),
    ).toMatchObject({
      action: "bored",
      reply: "ワシ、この話、飽きた",
      reason: "same_topic_three_rounds",
    });
  });

  it("resets boredom after five minutes", () => {
    expect(
      triageWedgeMessage({
        text: "物語の続きをお願い",
        authorId: "u1",
        state: {
          thinking: false,
          turnCount: 5,
          lastTopic: "物語の続きをお願い",
          lastUserId: "u1",
          lastMessageAt: 100,
        },
        now: 401,
      }).action,
    ).toBe("block");
  });
});
