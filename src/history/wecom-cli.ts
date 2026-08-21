import {
  cleanupAttachmentResources,
  createAttachmentRoot,
  importAttachmentResource,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_TOTAL_BYTES,
  saveAttachmentResource,
} from "../attachments.js";
import { defaultLocalHistoryRoot, LocalWecomHistory } from "./local.js";
import { CommandExecutionError, runCommand } from "../process.js";
import type { AttachmentMetadata, AttachmentResource, AttachmentType, CommandRunner, GroupMessage, HistoryChatType, HistoryQuery, IncomingDirectMessage, IncomingMention, QuoteMetadata } from "../types.js";

interface WecomMessage {
  msg_type?: string;
  send_time?: string;
  userid?: string;
  user_name?: string;
  text?: { content?: string };
  image?: { media_id?: string };
  file?: { file_name?: string; media_id?: string };
  voice?: { media_id?: string; content?: string };
  video?: { media_id?: string };
  mixed?: { items?: Array<{ msg_type?: string; text?: { content?: string }; image?: { media_id?: string } }> };
  quote?: Record<string, unknown>;
}

interface WecomPage {
  messages?: WecomMessage[];
  has_more?: boolean;
  next_cursor?: string;
}

function cliTime(date: Date): string {
  const part = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${part(date.getMonth() + 1)}-${part(date.getDate())} ${part(date.getHours())}:${part(date.getMinutes())}:${part(date.getSeconds())}`;
}

function assertCliSuccess(envelope: Record<string, unknown>, operation: string): void {
  const nested = envelope.error && typeof envelope.error === "object" && !Array.isArray(envelope.error)
    ? envelope.error as Record<string, unknown>
    : undefined;
  const rawCode = envelope.errcode ?? nested?.code;
  const code = typeof rawCode === "number" ? rawCode : Number(rawCode);
  if (!Number.isFinite(code) || code === 0) return;
  if (code === 853006) {
    throw new Error("企业未授权群消息历史能力（errcode 853006）；请让企业管理员批准机器人数据访问权限");
  }
  const rawMessage = envelope.errmsg ?? nested?.message;
  const message = typeof rawMessage === "string" ? rawMessage.replace(/\s+/g, " ").trim().slice(0, 300) : "";
  throw new Error(`${operation} 失败（errcode ${code}）${message ? `：${message}` : ""}`);
}

function pageFrom(stdout: string): WecomPage {
  let result: unknown;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new Error("wecom-cli 返回了无效 JSON");
  }
  if (!result || typeof result !== "object") throw new Error("wecom-cli 返回结构无效");
  const envelope = result as Record<string, unknown>;
  assertCliSuccess(envelope, "wecom-cli chat.messages.list");
  const data = envelope.data ?? envelope.result ?? result;
  if (!data || typeof data !== "object") throw new Error("wecom-cli 返回缺少消息数据");
  return data as WecomPage;
}

function quoteFrom(value: Record<string, unknown> | undefined): QuoteMetadata | undefined {
  if (!value) return undefined;
  const text = value.text && typeof value.text === "object" && "content" in value.text
    ? String((value.text as { content?: unknown }).content ?? "")
    : undefined;
  return { type: String(value.msg_type ?? value.msgtype ?? "unknown"), ...(text ? { text } : {}) };
}

interface MediaReference {
  type: AttachmentType;
  mediaId: string;
  name?: string;
}

function attachmentData(message: WecomMessage): { attachments: AttachmentMetadata[]; media: MediaReference[]; text: string } {
  const attachments: AttachmentMetadata[] = [];
  const media: MediaReference[] = [];
  let text = message.text?.content ?? "";
  const add = (type: AttachmentType, mediaId: string | undefined, name?: string) => {
    attachments.push({ type, ...(name ? { name } : {}), source: "history" });
    if (mediaId) media.push({ type, mediaId, ...(name ? { name } : {}) });
  };
  if (message.msg_type === "mixed") {
    text = (message.mixed?.items ?? []).flatMap((item) => item.text?.content ?? []).join("\n");
    for (const item of message.mixed?.items ?? []) if (item.msg_type === "image") add("image", item.image?.media_id);
  } else if (message.msg_type === "image") {
    add("image", message.image?.media_id);
  } else if (message.msg_type === "file") {
    add("file", message.file?.media_id, message.file?.file_name);
  } else if (message.msg_type === "voice") {
    add("voice", message.voice?.media_id);
    text = message.voice?.content ?? text;
  } else if (message.msg_type === "video") {
    add("video", message.video?.media_id);
  }
  return { attachments, media, text };
}

function standardize(message: WecomMessage, resources: AttachmentResource[] = []): GroupMessage | undefined {
  if (!message.userid || !message.send_time) return undefined;
  const time = new Date(message.send_time.replace(" ", "T"));
  if (Number.isNaN(time.getTime())) return undefined;
  const { attachments, text } = attachmentData(message);
  const quote = quoteFrom(message.quote);
  return {
    senderId: message.userid,
    ...(message.user_name ? { senderName: message.user_name } : {}),
    time,
    text,
    ...(quote ? { quote } : {}),
    ...(attachments.length ? { attachments } : {}),
    ...(resources.length ? { resources } : {}),
  };
}

function mediaContent(stdout: string): { path?: string; content?: string; name?: string; type?: AttachmentType } {
  let result: unknown;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new Error("wecom-cli message.files.get 返回了无效 JSON");
  }
  if (!result || typeof result !== "object") throw new Error("wecom-cli message.files.get 返回结构无效");
  const envelope = result as Record<string, unknown>;
  assertCliSuccess(envelope, "wecom-cli message.files.get");
  const data = envelope.data ?? envelope.result ?? result;
  const container = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
  const item = container?.media_item ?? container;
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("wecom-cli message.files.get 返回缺少附件数据");
  const media = item as { file_path?: unknown; content?: unknown; file_name?: unknown; media_type?: unknown };
  if ((typeof media.file_path !== "string" || !media.file_path) && typeof media.content !== "string") {
    throw new Error("wecom-cli message.files.get 未返回附件内容");
  }
  return {
    ...(typeof media.file_path === "string" && media.file_path ? { path: media.file_path } : {}),
    ...(typeof media.content === "string" ? { content: media.content } : {}),
    ...(typeof media.file_name === "string" && media.file_name ? { name: media.file_name } : {}),
    ...(["image", "file", "voice", "video"].includes(String(media.media_type)) ? { type: media.media_type as AttachmentType } : {}),
  };
}

async function downloadHistoryResources(
  messages: WecomMessage[],
  runner: CommandRunner,
): Promise<Map<WecomMessage, AttachmentResource[]>> {
  const result = new Map<WecomMessage, AttachmentResource[]>();
  const references = messages.flatMap((message) => attachmentData(message).media.map((media) => ({ message, media })))
    .slice(-MAX_ATTACHMENT_COUNT);
  if (!references.length) return result;
  const root = await createAttachmentRoot();
  const resources: AttachmentResource[] = [];
  let totalBytes = 0;
  try {
    for (const [index, { message, media }] of references.entries()) {
      const args = ["message", "files", "get", "--output-dir", root, "--media-id", media.mediaId];
      let stdout: string;
      try {
        stdout = (await runner("wecom-cli", args, { timeoutMs: 30_000 })).stdout;
      } catch (error) {
        if (error instanceof CommandExecutionError && error.stdout.trim()) mediaContent(error.stdout);
        throw error;
      }
      const downloaded = mediaContent(stdout);
      const input = {
        type: downloaded.type ?? media.type,
        source: "history" as const,
        name: downloaded.name ?? media.name,
        index: index + 1,
      };
      const resource = downloaded.path
        ? await importAttachmentResource(root, downloaded.path, input)
        : await saveAttachmentResource(root, Buffer.from(downloaded.content!, "utf8"), input);
      totalBytes += resource.size;
      if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error(`企业微信附件总量超过 ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB 安全上限`);
      resources.push(resource);
      result.set(message, [...(result.get(message) ?? []), resource]);
    }
    return result;
  } catch (error) {
    await cleanupAttachmentResources(resources.length ? resources : [{ root }]);
    throw error;
  }
}

export async function fetchWecomHistory(
  chatId: string,
  options: { lookbackHours: number; maxMessages: number; endTime: Date; includeResources?: boolean },
  runner: CommandRunner = runCommand,
): Promise<GroupMessage[]> {
  const beginTime = new Date(options.endTime.getTime() - options.lookbackHours * 60 * 60 * 1000);
  const messages: WecomMessage[] = [];
  let cursor: string | undefined;
  do {
    const args = [
      "chat", "messages", "list",
      "--begin-time", cliTime(beginTime),
      "--chat-id", chatId,
      "--end-time", cliTime(options.endTime),
      ...(cursor ? ["--cursor", cursor] : []),
    ];
    let stdout: string;
    try {
      stdout = (await runner("wecom-cli", args, { timeoutMs: 30_000 })).stdout;
    } catch (error) {
      if (error instanceof CommandExecutionError && error.stdout.trim()) pageFrom(error.stdout);
      throw error;
    }
    const page = pageFrom(stdout);
    messages.push(...(page.messages ?? []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor && messages.length < options.maxMessages);

  const selected = messages
    .filter((message) => message.userid && message.send_time && Number.isFinite(Date.parse(message.send_time.replace(" ", "T"))))
    .sort((left, right) => Date.parse(left.send_time!.replace(" ", "T")) - Date.parse(right.send_time!.replace(" ", "T")))
    .slice(-options.maxMessages);
  const resources = options.includeResources ? await downloadHistoryResources(selected, runner) : new Map<WecomMessage, AttachmentResource[]>();
  return selected.flatMap((message) => standardize(message, resources.get(message)) ?? []);
}

function messageKey(message: GroupMessage): string {
  return JSON.stringify([
    Math.floor(message.time.getTime() / 1_000),
    message.senderId,
    message.text,
    (message.attachments ?? []).map((attachment) => [attachment.type, attachment.name ?? ""]),
  ]);
}

function mergeHistory(remote: GroupMessage[], local: GroupMessage[], maxMessages: number): GroupMessage[] {
  const merged = new Map<string, GroupMessage>();
  for (const message of [...remote, ...local]) {
    const key = messageKey(message);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, message);
      continue;
    }
    merged.set(key, {
      ...existing,
      ...(message.senderName ? { senderName: message.senderName } : {}),
      attachments: [...(existing.attachments ?? []), ...(message.attachments ?? [])]
        .filter((attachment, index, all) => all.findIndex((item) => item.type === attachment.type && item.name === attachment.name) === index),
      resources: [...(existing.resources ?? []), ...(message.resources ?? [])],
    });
  }
  return [...merged.values()].sort((left, right) => left.time.getTime() - right.time.getTime()).slice(-maxMessages);
}

/** 企业微信远端历史 + 本机收到过的 Agent 隔离历史。远端私聊为空时，本机历史仍可跨重启回读。 */
export class WecomHistory {
  private readonly local: LocalWecomHistory;

  constructor(agentId: string, private readonly runner: CommandRunner = runCommand, localRoot = defaultLocalHistoryRoot(agentId)) {
    this.local = new LocalWecomHistory(localRoot);
  }

  remember(chatType: HistoryChatType, chatId: string, message: IncomingDirectMessage | IncomingMention): Promise<void> {
    return this.local.remember(chatType, chatId, message);
  }

  async list(chatId: string, options: HistoryQuery): Promise<GroupMessage[]> {
    let remote: GroupMessage[] = [];
    try {
      remote = await fetchWecomHistory(chatId, options, this.runner);
    } catch (error) {
      if (options.chatType === "group") throw error;
    }
    const local = await this.local.list(options.chatType, chatId, options);
    return mergeHistory(remote, local, options.maxMessages);
  }
}
