import type { WedgeConversationState, WedgeShortTermLog } from "./storage.js";

const REQUEST_RE =
  /(して|やって|作って|直して|調べて|見て|実行|保存|消して|送って|お願い|頼む|話して|教えて|please|fix|run|write|create|delete|send)/i;
const OFFER_RE = /(あげる|やる|渡す|差し出す|捧げる|供物|報酬|お礼|ごほうび|くれる|受け取って|持ってきた)/i;
const SHORT_CONTEXT_REPLY_RE = /^(うん|はい|そう|それ|お願い|続けて|いいよ|頼む|ok|yes)$/i;

export type WedgeTriageResult =
  | {
      action: "continue";
      statePatch: {
        turnCount: number;
        lastTopic: string | null;
        lastUserId: string | null;
        offeringSeenAt: number | null;
        boredUntil: null;
      };
      flags: { requestLike: boolean; offeringSeen: boolean; sameTopic: boolean };
    }
  | { action: "block"; reply: string; reason: string }
  | { action: "bored"; reply: string; reason: string; statePatch: { boredUntil: number } };

export function triageWedgeMessage(params: {
  text: string;
  authorId?: string;
  state: WedgeConversationState;
  recentLogs?: WedgeShortTermLog[];
  now?: number;
}): WedgeTriageResult {
  const now = params.now ?? Math.floor(Date.now() / 1000);
  const text = params.text.trim();
  const stale = params.state.lastMessageAt === undefined || now - params.state.lastMessageAt >= 5 * 60;
  const currentOffers = hasOffering(text);
  const recentOffers = hasRecentOffering(params.recentLogs ?? [], params.authorId, now);
  const offeringSeen = currentOffers || (!stale && (recentOffers || Boolean(params.state.offeringSeenAt)));
  const sameUser = Boolean(params.authorId && params.state.lastUserId === params.authorId);
  const sameTopic = !stale && sameUser && isSameTopic(text, params.state.lastTopic);
  const nextTurnCount = sameTopic && !currentOffers ? params.state.turnCount + 1 : 1;
  const topic = summarizeTopic(text);

  if (currentOffers) {
    return {
      action: "continue",
      statePatch: {
        turnCount: 1,
        lastTopic: topic,
        lastUserId: params.authorId ?? null,
        offeringSeenAt: now,
        boredUntil: null,
      },
      flags: { requestLike: isRequestLike(text), offeringSeen: true, sameTopic: false },
    };
  }

  if (sameTopic && nextTurnCount >= 6 && !offeringSeen) {
    return {
      action: "bored",
      reply: "ワシ、この話、飽きた",
      reason: "same_topic_three_rounds",
      statePatch: { boredUntil: now + 5 * 60 },
    };
  }

  if (isRequestLike(text) && !offeringSeen) {
    return { action: "block", reply: "くれるモノ、何", reason: "missing_offering" };
  }

  return {
    action: "continue",
    statePatch: {
      turnCount: nextTurnCount,
      lastTopic: topic,
      lastUserId: params.authorId ?? null,
      offeringSeenAt: offeringSeen ? (params.state.offeringSeenAt ?? now) : null,
      boredUntil: null,
    },
    flags: { requestLike: isRequestLike(text), offeringSeen, sameTopic },
  };
}

export function isRequestLike(text: string): boolean {
  return REQUEST_RE.test(text);
}

export function hasOffering(text: string): boolean {
  return OFFER_RE.test(text);
}

function hasRecentOffering(logs: WedgeShortTermLog[], authorId: string | undefined, now: number): boolean {
  return logs.some((log) => {
    if (log.kind !== "message") {
      return false;
    }
    if (authorId && log.userId && log.userId !== authorId) {
      return false;
    }
    if (now - log.createdAt > 5 * 60) {
      return false;
    }
    return hasOffering(log.content);
  });
}

function isSameTopic(text: string, previousTopic: string | undefined): boolean {
  if (!previousTopic) {
    return false;
  }
  if (SHORT_CONTEXT_REPLY_RE.test(text.trim())) {
    return true;
  }
  const currentTokens = topicTokens(text);
  const previousTokens = topicTokens(previousTopic);
  if (currentTokens.length === 0 || previousTokens.length === 0) {
    return false;
  }
  const previousSet = new Set(previousTokens);
  const overlap = currentTokens.filter((token) => previousSet.has(token)).length;
  return overlap >= Math.min(2, currentTokens.length, previousTokens.length);
}

function summarizeTopic(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 160);
}

function topicTokens(text: string): string[] {
  const normalized = text
    .toLowerCase()
    .replace(/[、。！？!?.,()[\]{}「」『』"'`]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) {
    return [];
  }
  const latin = normalized.match(/[a-z0-9_]{3,}/g) ?? [];
  const japanese = normalized
    .split(/\s+/)
    .flatMap((part) => {
      if (/^[a-z0-9_]+$/.test(part)) {
        return [];
      }
      if (part.length <= 4) {
        return [part];
      }
      const tokens: string[] = [];
      for (let index = 0; index <= part.length - 3; index += 1) {
        tokens.push(part.slice(index, index + 3));
      }
      return tokens;
    })
    .filter((token) => token.length >= 2);
  return [...latin, ...japanese].filter((token) => !REQUEST_RE.test(token) && !OFFER_RE.test(token));
}
