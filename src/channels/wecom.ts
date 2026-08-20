import { WSClient, generateReqId, type QuoteContent, type TextMessage, type WsFrame } from "@wecom/aibot-node-sdk";
import { CommandExecutionError, runCommand } from "../process.js";
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

/** 一条「加密 userid → 姓名」的映射。通讯录不支持按 userid 反查，只能从别处顺手收集。 */
export interface WecomPerson {
  id: string;
  name: string;
}

export interface WecomGroupSession {
  id: string;
  name?: string;
  /**
   * 机器人自己有会话记录，说明它确实在这个群里、并且已经被用过。
   * 缺失只代表「未确认」，不代表机器人不在群——刚拉进群、还没人 @ 过它的群拿不到这个信号。
   */
  hasBotSession?: boolean;
}

// 群发现只支持最近 7 天（企业微信侧限制），留一分钟余量避免踩边界被判为越界。
const GROUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000 - 60_000;
// `chat groups list` 按时间切片翻页，同一个群会在多页里重复出现；给个页数上限兜底，别把启动卡住。
const MAX_GROUP_PAGES = 10;

function cliTime(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function envelopeData(stdout: string, label: string): Record<string, unknown> {
  let response: unknown;
  try {
    response = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`wecom-cli ${label} 返回了无效 JSON`);
  }
  if (!response || typeof response !== "object") throw new Error(`wecom-cli ${label} 返回结构无效`);
  const envelope = response as Record<string, unknown>;
  if (typeof envelope.errcode === "number" && envelope.errcode !== 0) {
    if (envelope.errcode === 853006) {
      throw new Error(`企业未授权机器人访问会话数据（errcode 853006）；请让企业管理员批准机器人数据访问权限`);
    }
    throw new Error(`wecom-cli ${label} 失败（errcode ${envelope.errcode}）`);
  }
  const data = envelope.data ?? envelope.result ?? response;
  if (!data || typeof data !== "object") throw new Error(`wecom-cli ${label} 返回缺少数据`);
  return data as Record<string, unknown>;
}

function groupFrom(value: unknown): WecomGroupSession[] {
  if (!value || typeof value !== "object") return [];
  const item = value as { chat_id?: unknown; chat_name?: unknown; chat_type?: unknown };
  if (typeof item.chat_id !== "string" || !item.chat_id) return [];
  // 私聊会话绝不能混进「待绑定群」——私聊是 Owner 配对的，不走群绑定。
  // `chat groups list` 目前只返回群、不带 chat_type，所以缺字段时放行，带了就必须是 group。
  if (item.chat_type !== undefined && item.chat_type !== "group") return [];
  return [{ id: item.chat_id, ...(typeof item.chat_name === "string" && item.chat_name ? { name: item.chat_name } : {}) }];
}

// 「机器人最近的会话」：官方定义是按最后一条消息时间倒序、最多 20 个，只有和机器人互动过的会话才在里面。
// 所以它只能用来**确认**机器人在某个群，绝不能用来判断它不在——刚拉进群的群在这里永远查不到。
async function listBotSessions(runner: CommandRunner): Promise<{ groups: WecomGroupSession[]; people: WecomPerson[] }> {
  const { stdout } = await runner("wecom-cli", ["message", "aibot", "sessions", "list", "--json", "{}"], { timeoutMs: 30_000 });
  const sessions = envelopeData(stdout, "message.aibot.sessions.list").sessions;
  if (!Array.isArray(sessions)) return { groups: [], people: [] };
  const groups: WecomGroupSession[] = [];
  const people: WecomPerson[] = [];
  for (const session of sessions) {
    if (!session || typeof session !== "object") continue;
    const item = session as { chat_id?: unknown; chat_name?: unknown; chat_type?: unknown };
    if (item.chat_type === "group") {
      groups.push(...groupFrom(session).map((group) => ({ ...group, hasBotSession: true })));
      continue;
    }
    // 单聊的 chat_id 就是对方的 userid，chat_name 就是姓名——通讯录不支持按 userid 反查，
    // 这是免费拿到映射的少数途径之一。
    if (item.chat_type === "single" && typeof item.chat_id === "string" && item.chat_id
      && typeof item.chat_name === "string" && item.chat_name) {
      people.push({ id: item.chat_id, name: item.chat_name });
    }
  }
  return { groups, people };
}

// 「有消息的群会话」：这才是能发现新拉进去的群的接口。按时间范围翻页，只覆盖最近 7 天，
// 并且**不要求先和机器人互动**——群里有人说过话就能被发现。
async function listMessagedGroups(runner: CommandRunner, now: Date): Promise<WecomGroupSession[]> {
  const begin = cliTime(new Date(now.getTime() - GROUP_WINDOW_MS));
  const end = cliTime(now);
  const found = new Map<string, WecomGroupSession>();
  let cursor = "";
  for (let page = 0; page < MAX_GROUP_PAGES; page += 1) {
    const request = JSON.stringify({ begin_time: begin, end_time: end, ...(cursor ? { cursor } : {}) });
    const { stdout } = await runner("wecom-cli", ["chat", "groups", "list", "--json", request], { timeoutMs: 30_000 });
    const data = envelopeData(stdout, "chat.groups.list");
    const chats = data.chats;
    if (!Array.isArray(chats)) break;
    for (const chat of chats) {
      for (const group of groupFrom(chat)) if (!found.has(group.id)) found.set(group.id, group);
    }
    const next = typeof data.next_cursor === "string" ? data.next_cursor : "";
    if (data.has_more !== true || !next) break;
    cursor = next;
  }
  return [...found.values()];
}

function cliErrorMessage(output: string): string | undefined {
  const text = output.trim();
  if (!text) return undefined;
  if (text.startsWith("{")) {
    try {
      const message = (JSON.parse(text) as { error?: { message?: unknown } }).error?.message;
      return typeof message === "string" && message.trim() ? message.trim().replace(/\s+/g, " ") : undefined;
    } catch {
      return undefined; // 半截 JSON 就别硬凑，交给下一个来源
    }
  }
  return text.split("\n").map((line) => line.trim()).find(Boolean);
}

// wecom-cli 失败时 Error.message 只剩「执行失败（退出码 1）」，能照着做的原因（例如「该请求需要授权」）
// 在**退出码非 0 时的 stdout** 里，个别情况才落到 stderr。管理台要显示的是后者，这里就把它抠出来。
export function wecomFailureReason(error: unknown): string {
  if (error instanceof CommandExecutionError) {
    const detail = cliErrorMessage(error.stdout) ?? cliErrorMessage(error.stderr);
    if (detail) return detail;
  }
  return error instanceof Error && error.message ? error.message : "企业微信查询失败";
}

// 两个来源合并：`chat groups list` 负责发现，`aibot sessions list` 负责给「机器人确实在群」盖章。
// 任何一个可用就出结果——企业没开会话数据权限时只剩机器人会话，机器人还没被 @ 过时只剩有消息的群。
export async function listWecomSessions(
  runner: CommandRunner = runCommand,
  now: Date = new Date(),
): Promise<{ groups: WecomGroupSession[]; people: WecomPerson[] }> {
  const [messaged, botSessions] = await Promise.allSettled([
    listMessagedGroups(runner, now),
    listBotSessions(runner),
  ]);
  if (messaged.status === "rejected" && botSessions.status === "rejected") throw messaged.reason;
  const merged = new Map<string, WecomGroupSession>();
  if (messaged.status === "fulfilled") for (const group of messaged.value) merged.set(group.id, group);
  if (botSessions.status === "fulfilled") {
    for (const group of botSessions.value.groups) merged.set(group.id, { ...merged.get(group.id), ...group });
  }
  return {
    groups: [...merged.values()],
    people: botSessions.status === "fulfilled" ? botSessions.value.people : [],
  };
}

export async function listWecomGroups(
  runner: CommandRunner = runCommand,
  now: Date = new Date(),
): Promise<WecomGroupSession[]> {
  return (await listWecomSessions(runner, now)).groups;
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

/**
 * 用某个 Agent **自己的 WS 连接**主动发一条消息。
 *
 * 这条路径和 `sendWecomReply`（走 wecom-cli）是同一种能力，区别只是不用为每条回复多起一个
 * 子进程、也不依赖 wecom-cli 在 PATH 上。身份同样是这台机器人自己——连接是用它的 botId/secret
 * 建的。
 *
 * 注意：主动发送**没有「引用」**。群里那种引用气泡来自 `replyStream`，SDK 按收到回调时的
 * `headers.req_id` 在那条连接上关联，只有真正收到这次回调的机器人才有这个 req_id。
 */
export async function pushWecomMessage(client: WSClient, chatId: string, content: string): Promise<void> {
  if (!chatId || chatId.length > 512 || !content || Buffer.byteLength(content) > 12_000) {
    throw new Error("企业微信主动发送参数无效");
  }
  await client.sendMessage(chatId, { msgtype: "markdown", markdown: { content } });
}

/**
 * 执行一个白名单动作（见 src/actions.ts）。命令参数由 ThreadFerry 组装并逐项校验过，
 * Runtime 的沙箱不参与——它只负责提议，执行始终在这里，用该 Agent 自己的凭据。
 */
export async function runWecomAction(command: string[], runner: CommandRunner = runCommand): Promise<void> {
  if (command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new Error("动作命令无效");
  }
  const { stdout } = await runner("wecom-cli", command, { timeoutMs: 30_000 });
  envelopeData(stdout, command.slice(0, 3).join("."));
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
    const streamId = generateReqId("threadferry");
    const reply: Reply = (content, finish = true) => client.replyStream(frame, streamId, content, finish).then(() => undefined);
    void handle(event, reply).catch(async () => {
      try {
        await reply("ThreadFerry 处理失败。请在运行 ThreadFerry 的机器上执行 `threadferry doctor` 检查依赖和授权。");
      } catch {
        // SDK 会负责连接错误与重连；不把凭据或原始帧写入日志。
      }
    });
  });
  client.connect();
  return client;
}
