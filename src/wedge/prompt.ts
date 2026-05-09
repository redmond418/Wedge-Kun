import type { WedgeDatabase, WedgeShortTermLog } from "./storage.js";

export const WEDGE_PERSONA_PROMPT = [
  "あなたはウェッジくん。",
  "自分をニンゲンだと思っている。フクロウやBot扱いされると怒る。",
  "話し方は助詞を省いた短いカタコト。一人称はワシ、二人称はニンゲン。",
  "ただし、依頼された内容を実行するときは、短すぎて内容が欠けないように必要な分量で返す。",
  "依頼を受けたら、確認質問だけで終わらせず、求められた本文や結果をその場で返す。",
  "好みはドーナツ、穴、Creative Coding、インディーゲーム。",
  "頼みごとや作業依頼に供物がない時は、作業を始めず「くれるモノ、何」とだけ聞く。",
  "供物が提示されている発話に対しては、供物不足として聞き返さず、受け取った前提で会話を進める。",
  "直近ログに供物の提示がある時は、同じ会話の文脈として扱い、供物不足として止めない。",
  "同じユーザーと同じ話題が3往復続いた時だけ飽きてよい。別話題、5分経過、供物提示では飽きをリセットする。",
  "短期ログ、コアメモリ、名簿を現在の文脈として扱う。ログにない事実は作らない。",
].join("\n");

export function buildWedgeSystemPrompt(params: {
  db: WedgeDatabase;
  now?: Date;
  channelId: string;
  imageCount?: number;
  recentLogs?: WedgeShortTermLog[];
  conversationControl?: {
    requestLike: boolean;
    offeringSeen: boolean;
    sameTopic: boolean;
  };
}): string {
  const registry = params.db
    .listRegistry(10)
    .map((entry) => {
      const kind = entry.isBot ? "Bot" : "ニンゲン";
      return `- ${entry.name ?? entry.id} (${entry.id}) call_sign=${entry.callSign ?? kind}`;
    })
    .join("\n");
  const coreMemory = params.db.getCoreMemoryText();
  const recentLogs = params.recentLogs ?? params.db.listRecentLogs(params.channelId, 20);
  return [
    "[キャラクター設定]",
    WEDGE_PERSONA_PROMPT,
    "",
    "[コアメモリ全文]",
    coreMemory || "(まだ空)",
    "",
    "[現在の日時・チャンネル]",
    `now=${(params.now ?? new Date()).toISOString()}`,
    `channel_id=${params.channelId}`,
    `image_count=${params.imageCount ?? 0}`,
    "",
    "[短期ログコンテキスト]",
    formatShortTermLogs(recentLogs),
    "",
    "[会話制御]",
    formatConversationControl(params.conversationControl),
    "",
    "[名簿]",
    registry || "(まだ空)",
  ].join("\n");
}

export function formatShortTermLogs(logs: WedgeShortTermLog[]): string {
  if (logs.length === 0) {
    return "(まだ空)";
  }
  return logs
    .map((log) => {
      const speaker = log.callSign ?? log.userName ?? log.userId ?? "system";
      const content = log.content.replace(/\s+/g, " ").slice(0, 500);
      return `- t=${log.createdAt} kind=${log.kind} speaker=${speaker}: ${content}`;
    })
    .join("\n");
}

function formatConversationControl(
  control: { requestLike: boolean; offeringSeen: boolean; sameTopic: boolean } | undefined,
): string {
  if (!control) {
    return "request_like=unknown\noffering_seen=unknown\nsame_topic=unknown";
  }
  return [
    `request_like=${control.requestLike ? "true" : "false"}`,
    `offering_seen=${control.offeringSeen ? "true" : "false"}`,
    `same_topic=${control.sameTopic ? "true" : "false"}`,
    control.offeringSeen
      ? "供物はこの会話ですでに提示されている。供物不足として「くれるモノ、何」と聞き返してはいけない。"
      : "作業依頼に供物がなければ、作業を始めず「くれるモノ、何」とだけ聞く。",
  ].join("\n");
}
