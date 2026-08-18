import { WSClient, generateReqId, type QuoteContent, type TextMessage, type WsFrame } from "@wecom/aibot-node-sdk";
import { runCommand } from "../process.js";
import type { CommandRunner, DirectoryUser, IncomingMention, IncomingWecomEvent, QuoteMetadata, Reply } from "../types.js";

function quoteMetadata(quote: QuoteContent | undefined): QuoteMetadata | undefined {
  if (!quote) return undefined;
  return { type: quote.msgtype, ...(quote.text?.content ? { text: quote.text.content } : {}) };
}

function standardize(frame: WsFrame<TextMessage>): IncomingWecomEvent | undefined {
  const body = frame.body;
  if (!body) return undefined;
  if (body.chattype === "single") {
    return {
      chatType: "single",
      message: {
        msgId: body.msgid,
        senderId: body.from.userid,
        time: new Date((body.create_time ?? Math.floor(Date.now() / 1000)) * 1000),
        text: body.text.content,
      },
    };
  }
  if (!body.chatid) return undefined;
  const quote = quoteMetadata(body.quote);
  const message: IncomingMention = {
    msgId: body.msgid,
    groupId: body.chatid,
    senderId: body.from.userid,
    time: new Date((body.create_time ?? Math.floor(Date.now() / 1000)) * 1000),
    text: body.text.content,
    ...(quote ? { quote } : {}),
    // 企业微信群文本回调只在 @机器人时产生；普通群消息不进入该 SDK 回调。
    mentioned: true,
  };
  return { chatType: "group", message };
}

export interface WecomGroupSession {
  id: string;
  name?: string;
}

export async function listWecomGroups(runner: CommandRunner = runCommand): Promise<WecomGroupSession[]> {
  const { stdout } = await runner("wecom-cli", ["message", "aibot", "sessions", "list", "--json", "{}"], { timeoutMs: 30_000 });
  let response: unknown;
  try {
    response = JSON.parse(stdout.trim());
  } catch {
    throw new Error("wecom-cli message.aibot.sessions.list 返回了无效 JSON");
  }
  if (!response || typeof response !== "object") throw new Error("wecom-cli message.aibot.sessions.list 返回结构无效");
  const envelope = response as Record<string, unknown>;
  if (typeof envelope.errcode === "number" && envelope.errcode !== 0) {
    throw new Error(`wecom-cli message.aibot.sessions.list 失败（errcode ${envelope.errcode}）`);
  }
  const data = envelope.data ?? envelope.result ?? response;
  if (!data || typeof data !== "object") throw new Error("wecom-cli 缺少机器人会话数据");
  const sessions = (data as { sessions?: unknown }).sessions;
  if (!Array.isArray(sessions)) return [];
  return sessions.flatMap((session) => {
    if (!session || typeof session !== "object") return [];
    const item = session as { chat_id?: unknown; chat_name?: unknown; chat_type?: unknown };
    if (item.chat_type !== "group" || typeof item.chat_id !== "string" || !item.chat_id) return [];
    return [{ id: item.chat_id, ...(typeof item.chat_name === "string" && item.chat_name ? { name: item.chat_name } : {}) }];
  });
}

export async function searchWecomUsers(keywords: string[], runner: CommandRunner = runCommand): Promise<DirectoryUser[]> {
  if (keywords.length === 0 || keywords.length > 10 || keywords.some((keyword) => !keyword.trim())) {
    throw new Error("企业微信通讯录搜索关键词必须为 1～10 个非空字符串");
  }
  const request = JSON.stringify({ keywords, search_mode: "list" });
  const { stdout } = await runner("wecom-cli", ["contact", "users", "search", "--json", request], { timeoutMs: 30_000 });
  let response: unknown;
  try {
    response = JSON.parse(stdout.trim());
  } catch {
    throw new Error("wecom-cli contact.users.search 返回了无效 JSON");
  }
  if (!response || typeof response !== "object") throw new Error("wecom-cli contact.users.search 返回结构无效");
  const envelope = response as Record<string, unknown>;
  if (typeof envelope.errcode === "number" && envelope.errcode !== 0) {
    throw new Error(`wecom-cli contact.users.search 失败（errcode ${envelope.errcode}）`);
  }
  const data = envelope.data ?? envelope.result ?? response;
  if (!data || typeof data !== "object") throw new Error("wecom-cli 缺少通讯录搜索数据");
  const users = (data as { users?: unknown }).users;
  if (!Array.isArray(users)) return [];
  return users.flatMap((user) => {
    if (!user || typeof user !== "object") return [];
    const item = user as { userid?: unknown; name?: unknown; alias?: unknown; departments?: unknown; matched_keywords?: unknown };
    if (typeof item.userid !== "string" || !item.userid || typeof item.name !== "string" || !item.name) return [];
    return [{
      id: item.userid,
      name: item.name,
      ...(typeof item.alias === "string" && item.alias ? { alias: item.alias } : {}),
      ...(Array.isArray(item.departments) && item.departments.every((department) => typeof department === "string")
        ? { departments: item.departments as string[] }
        : {}),
      ...(Array.isArray(item.matched_keywords) && item.matched_keywords.every((keyword) => typeof keyword === "string")
        ? { matchedKeywords: item.matched_keywords as string[] }
        : {}),
    }];
  });
}

export async function sendWecomReply(groupId: string, content: string, runner: CommandRunner = runCommand): Promise<void> {
  if (!groupId || groupId.length > 512 || !content || Buffer.byteLength(content) > 12_000) {
    throw new Error("企业微信主动回复参数无效");
  }
  const request = JSON.stringify({
    chat_id: groupId,
    msg_type: "markdown",
    markdown: { content },
  });
  const { stdout } = await runner("wecom-cli", ["message", "aibot", "send", "--json", request], { timeoutMs: 30_000 });
  let response: unknown;
  try {
    response = JSON.parse(stdout.trim());
  } catch {
    throw new Error("wecom-cli message.aibot.send 返回了无效 JSON");
  }
  if (!response || typeof response !== "object") throw new Error("wecom-cli message.aibot.send 返回结构无效");
  const envelope = response as Record<string, unknown>;
  if (typeof envelope.errcode === "number" && envelope.errcode !== 0) {
    throw new Error(`wecom-cli message.aibot.send 失败（errcode ${envelope.errcode}）`);
  }
  const data = envelope.data ?? envelope.result;
  if (data && typeof data === "object" && (data as { success?: unknown }).success === false) {
    throw new Error("wecom-cli message.aibot.send 未成功投递");
  }
}

export function startWecomChannel(
  credentials: { botId: string; secret: string },
  handle: (event: IncomingWecomEvent, reply: Reply) => Promise<void>,
): WSClient {
  const client = new WSClient({
    botId: credentials.botId,
    secret: credentials.secret,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  client.on("message.text", (frame) => {
    const event = standardize(frame);
    if (!event) return;
    const streamId = generateReqId("warden");
    const reply: Reply = (content, finish = true) => client.replyStream(frame, streamId, content, finish).then(() => undefined);
    void handle(event, reply).catch(async () => {
      try {
        await reply("Warden 处理失败。请在运行 Warden 的机器上执行 `warden doctor` 检查依赖和授权。");
      } catch {
        // SDK 会负责连接错误与重连；不把凭据或原始帧写入日志。
      }
    });
  });
  client.connect();
  return client;
}
