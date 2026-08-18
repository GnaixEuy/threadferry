import { runCommand } from "../process.js";
import type { AttachmentMetadata, CommandRunner, GroupMessage, QuoteMetadata } from "../types.js";

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

function pageFrom(stdout: string): WecomPage {
  let result: unknown;
  try {
    result = JSON.parse(stdout.trim());
  } catch {
    throw new Error("wecom-cli 返回了无效 JSON");
  }
  if (!result || typeof result !== "object") throw new Error("wecom-cli 返回结构无效");
  const envelope = result as Record<string, unknown>;
  if (typeof envelope.errcode === "number" && envelope.errcode !== 0) {
    throw new Error(`wecom-cli chat.messages.list 失败（errcode ${envelope.errcode}）`);
  }
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

function standardize(message: WecomMessage): GroupMessage | undefined {
  if (!message.userid || !message.send_time) return undefined;
  const time = new Date(message.send_time.replace(" ", "T"));
  if (Number.isNaN(time.getTime())) return undefined;
  const attachments: AttachmentMetadata[] = [];
  let text = message.text?.content ?? "";
  if (message.msg_type === "mixed") {
    text = (message.mixed?.items ?? []).flatMap((item) => item.text?.content ?? []).join("\n");
    for (const item of message.mixed?.items ?? []) {
      if (item.msg_type === "image") attachments.push({ type: "image" });
    }
  } else if (message.msg_type === "image") {
    attachments.push({ type: "image" });
  } else if (message.msg_type === "file") {
    attachments.push({ type: "file", ...(message.file?.file_name ? { name: message.file.file_name } : {}) });
  } else if (message.msg_type === "voice") {
    attachments.push({ type: "voice" });
    text = message.voice?.content ?? text;
  } else if (message.msg_type === "video") {
    attachments.push({ type: "video" });
  }
  const quote = quoteFrom(message.quote);
  return {
    senderId: message.userid,
    ...(message.user_name ? { senderName: message.user_name } : {}),
    time,
    text,
    ...(quote ? { quote } : {}),
    ...(attachments.length ? { attachments } : {}),
  };
}

export async function fetchWecomHistory(
  groupId: string,
  options: { lookbackHours: number; maxMessages: number; endTime: Date },
  runner: CommandRunner = runCommand,
): Promise<GroupMessage[]> {
  const beginTime = new Date(options.endTime.getTime() - options.lookbackHours * 60 * 60 * 1000);
  const messages: WecomMessage[] = [];
  let cursor: string | undefined;
  do {
    const args = [
      "chat", "messages", "list",
      "--begin-time", cliTime(beginTime),
      "--chat-id", groupId,
      "--end-time", cliTime(options.endTime),
      ...(cursor ? ["--cursor", cursor] : []),
    ];
    const page = pageFrom((await runner("wecom-cli", args, { timeoutMs: 30_000 })).stdout);
    messages.push(...(page.messages ?? []));
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor && messages.length < options.maxMessages);

  return messages
    .flatMap((message) => standardize(message) ?? [])
    .sort((left, right) => left.time.getTime() - right.time.getTime())
    .slice(-options.maxMessages);
}
