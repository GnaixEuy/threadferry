import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { WSClient, generateReqId, type BaseMessage, type QuoteContent, type WsFrame } from "@wecom/aibot-node-sdk";
import {
  cleanupAttachmentResources,
  createAttachmentRoot,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  saveAttachmentResource,
} from "../attachments.js";
import { CommandExecutionError, runCommand } from "../process.js";
import type { AttachmentResource, AttachmentSource, AttachmentType, CommandRunner, DirectoryUser, IncomingDirectMessage, IncomingMention, IncomingWecomEvent, QuoteMetadata, Reply } from "../types.js";

function quoteMetadata(quote: QuoteContent | undefined): QuoteMetadata | undefined {
  if (!quote) return undefined;
  const mixed = quote.mixed?.msg_item.flatMap((item) => item.text?.content ?? []).join("\n");
  const text = quote.text?.content ?? quote.voice?.content ?? mixed;
  return { type: quote.msgtype, ...(text ? { text } : {}) };
}

interface RemoteAttachment {
  type: AttachmentType;
  source: AttachmentSource;
  url: string;
  aesKey?: string;
}

type AttachmentDownloader = (url: string, aesKey?: string) => Promise<{ buffer: Buffer; filename?: string }>;

function remoteAttachment(value: unknown, type: AttachmentType, source: AttachmentSource): RemoteAttachment[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const item = value as { url?: unknown; aeskey?: unknown };
  if (typeof item.url !== "string" || !item.url) return [];
  return [{ type, source, url: item.url, ...(typeof item.aeskey === "string" && item.aeskey ? { aesKey: item.aeskey } : {}) }];
}

function messageAttachments(body: BaseMessage): RemoteAttachment[] {
  if (body.msgtype === "image") return remoteAttachment(body.image, "image", "message");
  if (body.msgtype === "file") return remoteAttachment(body.file, "file", "message");
  if (body.msgtype === "video") return remoteAttachment(body.video, "video", "message");
  if (body.msgtype !== "mixed") return [];
  return (body.mixed?.msg_item ?? []).flatMap((item: { msgtype?: string; image?: unknown }) =>
    item.msgtype === "image" ? remoteAttachment(item.image, "image", "message") : []);
}

function quotedAttachments(quote: QuoteContent | undefined): RemoteAttachment[] {
  if (!quote) return [];
  if (quote.msgtype === "image") return remoteAttachment(quote.image, "image", "quote");
  if (quote.msgtype === "file") return remoteAttachment(quote.file, "file", "quote");
  if (quote.msgtype !== "mixed") return [];
  return (quote.mixed?.msg_item ?? []).flatMap((item) =>
    item.msgtype === "image" ? remoteAttachment(item.image, "image", "quote") : []);
}

function messageText(body: BaseMessage): string {
  if (body.msgtype === "text") return body.text?.content ?? "";
  if (body.msgtype === "voice") return body.voice?.content || "[用户发送了一段语音]";
  if (body.msgtype === "mixed") {
    const text = (body.mixed?.msg_item ?? []).flatMap((item: { text?: { content?: string } }) => item.text?.content ?? []).join("\n");
    return text || "[用户发送了图文消息]";
  }
  if (body.msgtype === "image") return "[用户发送了一张图片]";
  if (body.msgtype === "file") return "[用户发送了一个文件]";
  if (body.msgtype === "video") return "[用户发送了一段视频]";
  return "";
}

function carriesAttachment(body: BaseMessage): boolean {
  return body.msgtype === "image" || body.msgtype === "file" || body.msgtype === "video"
    || (body.msgtype === "mixed" && (body.mixed?.msg_item ?? []).some((item: { msgtype?: string }) => item.msgtype === "image"));
}

export async function standardizeMessage(frame: WsFrame<BaseMessage>, download: AttachmentDownloader): Promise<IncomingWecomEvent | undefined> {
  const body = frame.body;
  if (!body || !["text", "image", "mixed", "voice", "file", "video"].includes(String(body.msgtype))) return undefined;
  if (body.chattype !== "single" && (body.chattype !== "group" || !body.chatid)) return undefined;
  const pending = [...messageAttachments(body), ...quotedAttachments(body.quote)].slice(0, MAX_ATTACHMENT_COUNT);
  const resources: AttachmentResource[] = [];
  let root: string | undefined;
  let totalBytes = 0;
  try {
    for (const [index, item] of pending.entries()) {
      const downloaded = await download(item.url, item.aesKey);
      totalBytes += downloaded.buffer.length;
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error(`企业微信附件总量超过 ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB 安全上限`);
      root ??= await createAttachmentRoot();
      resources.push(await saveAttachmentResource(root, downloaded.buffer, {
        type: item.type,
        source: item.source,
        ...(downloaded.filename ? { name: downloaded.filename } : {}),
        index: index + 1,
      }));
    }
  } catch (error) {
    await cleanupAttachmentResources(resources.length ? resources : root ? [{ root }] : []);
    throw error;
  }
  const text = messageText(body);
  const quote = quoteMetadata(body.quote);
  const attachments = resources.map(({ type, name, source }) => ({ type, ...(name ? { name } : {}), source }));
  if (body.msgtype === "voice") attachments.unshift({ type: "voice", source: "message" });
  if (body.quote?.msgtype === "voice") attachments.push({ type: "voice", source: "quote" });
  if (body.chattype === "single") {
    return {
      chatType: "single",
      message: {
        msgId: body.msgid,
        senderId: body.from.userid,
        time: new Date((body.create_time ?? Math.floor(Date.now() / 1000)) * 1000),
        text,
        ...(quote ? { quote } : {}),
        ...(attachments.length ? { attachments } : {}),
        ...(resources.length ? { resources } : {}),
      },
    };
  }
  const message: IncomingMention = {
    msgId: body.msgid,
    groupId: body.chatid!,
    senderId: body.from.userid,
    time: new Date((body.create_time ?? Math.floor(Date.now() / 1000)) * 1000),
    text,
    ...(quote ? { quote } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(resources.length ? { resources } : {}),
    // 企业微信群文本回调只在 @机器人时产生；普通群消息不进入该 SDK 回调。
    mentioned: true,
  };
  return { chatType: "group", message };
}

export function standardizeAuthChange(frame: WsFrame<unknown>): IncomingWecomEvent | undefined {
  if (!frame.body || typeof frame.body !== "object" || Array.isArray(frame.body)) return undefined;
  const body = frame.body as Record<string, unknown>;
  const from = body.from;
  const event = body.event;
  if (!from || typeof from !== "object" || Array.isArray(from)
    || !event || typeof event !== "object" || Array.isArray(event)
    || (event as Record<string, unknown>).eventtype !== "auth_change_event") return undefined;
  const senderId = (from as Record<string, unknown>).userid;
  const msgId = body.msgid;
  const authChange = (event as Record<string, unknown>).auth_change_event;
  const authList = authChange && typeof authChange === "object" && !Array.isArray(authChange)
    ? (authChange as Record<string, unknown>).auth_list
    : undefined;
  if (typeof senderId !== "string" || !senderId || senderId.length > 512
    || typeof msgId !== "string" || !msgId || msgId.length > 512
    || !Array.isArray(authList) || !authList.every((item) => Number.isInteger(item))) return undefined;
  const permissions = authList.map((item) => item === 1 ? "新建和编辑文档" : item === 2 ? "获取成员文档内容" : `未知权限 ${item}`).join("、") || "无文档权限";
  return {
    chatType: "single",
    message: {
      msgId,
      senderId,
      time: new Date((typeof body.create_time === "number" ? body.create_time : Math.floor(Date.now() / 1_000)) * 1_000),
      text: `企业微信文档权限已更新：${permissions}。请根据当前权限继续刚才未完成的文档操作；不要扩大原请求范围。`,
    },
  };
}

// ponytail: 750 ms quiet window identifies one WeCom send burst; use a platform correlation id if the SDK exposes one later.
const DIRECT_MESSAGE_BUNDLE_MS = 750;
const RESOURCE_FAILURE_REPLY = "ThreadFerry 已收到消息，但资源下载、解密或分析失败。请在运行 ThreadFerry 的机器上执行 `threadferry doctor` 检查依赖和授权。";

type BufferedWecomMessage = {
  key?: string;
  hasAttachment: boolean;
  event: Promise<IncomingWecomEvent | undefined>;
  reply: Reply;
};

function mergeDirectEvents(events: IncomingWecomEvent[]): IncomingWecomEvent {
  if (!events.every((event) => event.chatType === "single")) throw new Error("只能合并同一私聊的消息");
  const messages = events.map((event) => event.message as IncomingDirectMessage);
  const last = messages.at(-1)!;
  if (!messages.every((message) => message.senderId === last.senderId)) throw new Error("不能合并不同用户的消息");
  const resources = messages.flatMap((message) => message.resources ?? []);
  if (resources.length > MAX_ATTACHMENT_COUNT
    || resources.reduce((total, resource) => total + resource.size, 0) > MAX_ATTACHMENT_TOTAL_BYTES) {
    throw new Error("企业微信附件超过单轮安全上限");
  }
  const message: IncomingDirectMessage = {
    ...last,
    text: messages.map(({ text }) => text).filter(Boolean).join("\n"),
    attachments: messages.flatMap((item) => item.attachments ?? []),
    resources,
  };
  if (!message.attachments?.length) delete message.attachments;
  if (!message.resources?.length) delete message.resources;
  return { chatType: "single", message };
}

export function createWecomMessageDispatcher(
  handle: (event: IncomingWecomEvent, reply: Reply) => Promise<void>,
  bundleMs = DIRECT_MESSAGE_BUNDLE_MS,
): (message: BufferedWecomMessage) => Promise<void> {
  const pending = new Map<string, {
    messages: BufferedWecomMessage[];
    waiters: Array<() => void>;
    timer: ReturnType<typeof setTimeout>;
  }>();

  async function fail(reply: Reply): Promise<void> {
    await reply(RESOURCE_FAILURE_REPLY).catch(() => undefined);
  }

  async function deliver(messages: BufferedWecomMessage[]): Promise<void> {
    const settled = await Promise.allSettled(messages.map(({ event }) => event));
    const events = settled.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : []);
    if (messages.length > 1 && messages.some(({ hasAttachment }) => hasAttachment)) {
      try {
        const rejected = settled.find((result) => result.status === "rejected");
        if (rejected) throw rejected.reason;
        if (events.length) await handle(mergeDirectEvents(events), messages.at(-1)!.reply);
      } catch {
        await fail(messages.at(-1)!.reply);
      } finally {
        await cleanupAttachmentResources(events.flatMap((event) => event.message.resources ?? []));
      }
      return;
    }
    for (const [index, result] of settled.entries()) {
      const message = messages[index]!;
      if (result.status === "rejected") {
        await fail(message.reply);
        continue;
      }
      if (!result.value) continue;
      try {
        await handle(result.value, message.reply);
      } catch {
        await fail(message.reply);
      } finally {
        await cleanupAttachmentResources(result.value.message.resources ?? []);
      }
    }
  }

  return (message) => {
    if (!message.key) return deliver([message]);
    const key = message.key;
    return new Promise<void>((resolve) => {
      const current = pending.get(key);
      if (current) clearTimeout(current.timer);
      const messages = [...(current?.messages ?? []), message];
      const waiters = [...(current?.waiters ?? []), resolve];
      const timer = setTimeout(() => {
        pending.delete(key);
        void deliver(messages).finally(() => waiters.forEach((waiter) => waiter()));
      }, bundleMs);
      pending.set(key, { messages, waiters, timer });
    });
  };
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
const MAX_ACTION_FILE_BYTES = 1024 * 1024;
const FILE_OUTPUT_ACTIONS = new Set([
  "disk.files.download",
  "doc.contents.get",
  "mail.get",
  "media.download",
  "sheet.ranges.get",
  "smartpage.pages.get",
  "meeting.original.get",
  "message.files.get",
]);

function cliTime(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function cliEnvelope(stdout: string, label: string): Record<string, unknown> {
  let response: unknown;
  try {
    response = JSON.parse(stdout.trim());
  } catch {
    throw new Error(`wecom-cli ${label} 返回了无效 JSON`);
  }
  if (!response || typeof response !== "object") throw new Error(`wecom-cli ${label} 返回结构无效`);
  const envelope = response as Record<string, unknown>;
  const nested = envelope.error && typeof envelope.error === "object" && !Array.isArray(envelope.error)
    ? envelope.error as Record<string, unknown>
    : undefined;
  const rawCode = envelope.errcode ?? nested?.code;
  const code = rawCode === undefined ? undefined : Number(rawCode);
  const rawMessage = envelope.errmsg ?? nested?.message;
  const message = typeof rawMessage === "string" ? rawMessage.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  if ((nested && rawCode === undefined) || (rawCode !== undefined && (!Number.isFinite(code) || code !== 0))) {
    if (code === 853006) {
      throw new Error(`企业未授权机器人访问会话数据（errcode 853006）；请让企业管理员批准机器人数据访问权限`);
    }
    throw new Error(`wecom-cli ${label} 失败${code === undefined || !Number.isFinite(code) ? "" : `（errcode ${code}）`}${message ? `：${message}` : ""}`);
  }
  return envelope;
}

function envelopeData(stdout: string, label: string): Record<string, unknown> {
  const envelope = cliEnvelope(stdout, label);
  const data = envelope.data ?? envelope.result ?? envelope;
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

/** 执行 Broker 已校验的命令；不经过 shell，并始终使用所属 Agent 的独立 runner。 */
export async function runWecomAction(
  command: string[],
  runner: CommandRunner = runCommand,
  write = true,
): Promise<Record<string, unknown>> {
  const inspection = ["--doc", "--help", "--schema"].includes(command.at(-1) ?? "")
    && command.length >= 2
    && command.slice(0, -1).every((part) => /^[a-z][a-z0-9-]*$/.test(part));
  if (inspection) {
    const { stdout } = await runner("wecom-cli", command, { timeoutMs: 30_000 });
    return { documentation: stdout };
  }
  const jsonIndex = command.indexOf("--json");
  if (command.length === 0 || command.some((part) => typeof part !== "string")
    || jsonIndex !== command.length - 2 || command.includes("--dry-run")
    || command.slice(0, jsonIndex).some((part) => !/^[a-z][a-z0-9-]*$/.test(part))) {
    throw new Error("动作命令无效");
  }
  try {
    const request = JSON.parse(command.at(-1)!);
    if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error();
  } catch {
    throw new Error("动作命令无效");
  }
  if (write) {
    const dryRun = [...command];
    dryRun.splice(jsonIndex, 0, "--dry-run");
    const { stdout } = await runner("wecom-cli", dryRun, { timeoutMs: 30_000 });
    cliEnvelope(stdout, `${command.slice(0, jsonIndex).join(".")} dry-run`);
  }
  const action = command.slice(0, jsonIndex).join(".");
  const outputDirectory = !write && FILE_OUTPUT_ACTIONS.has(action)
    ? await mkdtemp(join(tmpdir(), "threadferry-action-"))
    : undefined;
  try {
    const actual = [...command];
    if (outputDirectory) actual.splice(jsonIndex, 0, "--output-dir", outputDirectory);
    const { stdout } = await runner("wecom-cli", actual, { timeoutMs: 30_000 });
    const data = envelopeData(stdout, command.slice(0, jsonIndex).join("."));
    return outputDirectory ? await hydrateActionFiles(data, outputDirectory) as Record<string, unknown> : data;
  } finally {
    if (outputDirectory) await rm(outputDirectory, { recursive: true, force: true });
  }
}

async function hydrateActionFiles(value: unknown, outputDirectory: string): Promise<unknown> {
  if (Array.isArray(value)) return Promise.all(value.map((item) => hydrateActionFiles(item, outputDirectory)));
  if (!value || typeof value !== "object") return value;
  const item = value as Record<string, unknown>;
  const hydrated: Record<string, unknown> = {};
  for (const [name, nested] of Object.entries(item)) {
    if (name !== "file_path") hydrated[name] = await hydrateActionFiles(nested, outputDirectory);
  }
  if (typeof item.file_path !== "string") return hydrated;

  const [root, file] = await Promise.all([realpath(outputDirectory), realpath(item.file_path)]);
  const path = relative(root, file);
  if (!path || path.startsWith("..") || isAbsolute(path)) throw new Error("wecom-cli 返回了临时目录之外的文件路径");
  const info = await stat(file);
  if (!info.isFile() || info.size > MAX_ACTION_FILE_BYTES) throw new Error("企业内容文件无效或超过 1 MB 安全上限");
  const buffer = await readFile(file);
  const content = buffer.toString("utf8");
  hydrated.content = content.includes("\u0000") ? "[二进制内容未注入 Runtime]" : content;
  return hydrated;
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
  const envelope = cliEnvelope(stdout, "message.aibot.send");
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
  const dispatch = createWecomMessageDispatcher(handle);
  client.on("message", (frame) => {
    const streamId = generateReqId("threadferry");
    const reply: Reply = (content, finish = true) => client.replyStream(frame, streamId, content, finish).then(() => undefined);
    const body = frame.body;
    void dispatch({
      key: body?.chattype === "single" ? body.from.userid : undefined,
      hasAttachment: Boolean(body && carriesAttachment(body)),
      event: standardizeMessage(frame, (url, aesKey) => client.downloadFile(url, aesKey)),
      reply,
    });
  });
  client.on("event", (frame) => {
    const event = standardizeAuthChange(frame);
    if (!event) return;
    const reply: Reply = (content) => pushWecomMessage(client, event.message.senderId, content);
    void handle(event, reply).catch(async () => {
      await reply("文档权限已更新，但 ThreadFerry 暂时无法继续之前的请求。请直接重发原请求。")
        .catch(() => undefined);
    });
  });
  client.connect();
  return client;
}
