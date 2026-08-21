import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { cleanupAttachmentResources, createAttachmentRoot, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_COUNT, MAX_ATTACHMENT_TOTAL_BYTES, saveAttachmentResource } from "../attachments.js";
import { validateAgentId } from "../bots.js";
import type { AttachmentMetadata, AttachmentResource, AttachmentType, GroupMessage, HistoryChatType, HistoryQuery, IncomingDirectMessage, IncomingMention, QuoteMetadata } from "../types.js";

const VERSION = 1;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 1_000;
const MAX_RESOURCE_BYTES = 200 * 1024 * 1024;
const MAX_INDEX_BYTES = 32 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;

interface StoredResource {
  blob: string;
  type: AttachmentType;
  name?: string;
  size: number;
  contentType: string;
}

interface StoredMessage {
  msgId: string;
  chatType: HistoryChatType;
  chatId: string;
  senderId: string;
  senderName?: string;
  time: string;
  text: string;
  quote?: QuoteMetadata;
  attachments?: AttachmentMetadata[];
  resources?: StoredResource[];
}

interface HistoryIndex {
  version: 1;
  messages: StoredMessage[];
}

function validMessage(value: unknown): value is StoredMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<StoredMessage>;
  return typeof item.msgId === "string"
    && (item.chatType === "single" || item.chatType === "group")
    && typeof item.chatId === "string"
    && typeof item.senderId === "string"
    && typeof item.time === "string" && Number.isFinite(Date.parse(item.time))
    && typeof item.text === "string"
    && (item.resources === undefined || (Array.isArray(item.resources) && item.resources.every((resource) => HASH.test(resource.blob)
      && ["image", "file", "voice", "video"].includes(resource.type)
      && Number.isInteger(resource.size) && resource.size > 0 && resource.size <= MAX_ATTACHMENT_BYTES
      && typeof resource.contentType === "string")));
}

function prune(messages: StoredMessage[], now: number): StoredMessage[] {
  const recent = messages
    .filter((message) => Date.parse(message.time) >= now - RETENTION_MS)
    .sort((left, right) => Date.parse(left.time) - Date.parse(right.time))
    .slice(-MAX_MESSAGES);
  let resourceBytes = 0;
  for (let index = recent.length - 1; index >= 0; index -= 1) {
    const message = recent[index]!;
    const size = (message.resources ?? []).reduce((total, resource) => total + resource.size, 0);
    if (resourceBytes + size <= MAX_RESOURCE_BYTES) resourceBytes += size;
    else delete message.resources;
  }
  return recent;
}

export function defaultLocalHistoryRoot(agentId: string): string {
  return join(homedir(), ".threadferry", "history", validateAgentId(agentId));
}

export class LocalWecomHistory {
  private pending = Promise.resolve();

  constructor(private readonly root: string) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async secureDirectory(path: string): Promise<void> {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`ThreadFerry 历史目录无效: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(path, { recursive: true, mode: 0o700 });
    }
    await chmod(path, 0o700);
  }

  private async load(): Promise<HistoryIndex> {
    await this.secureDirectory(this.root);
    const path = join(this.root, "index.json");
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("ThreadFerry 历史索引无效");
      if (info.size > MAX_INDEX_BYTES) throw new Error("ThreadFerry 历史索引超过安全上限");
      const value = JSON.parse(await readFile(path, "utf8")) as Partial<HistoryIndex>;
      if (value.version !== VERSION || !Array.isArray(value.messages) || !value.messages.every(validMessage)) {
        throw new Error("ThreadFerry 历史索引结构无效");
      }
      await chmod(path, 0o600);
      return { version: VERSION, messages: value.messages };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: VERSION, messages: [] };
      throw error;
    }
  }

  private async save(index: HistoryIndex): Promise<void> {
    const content = `${JSON.stringify(index)}\n`;
    if (Buffer.byteLength(content) > MAX_INDEX_BYTES) throw new Error("ThreadFerry 历史索引超过安全上限");
    const path = join(this.root, "index.json");
    const temporary = join(this.root, `.index.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await rename(temporary, path);
      await chmod(path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async collectBlobs(index: HistoryIndex): Promise<void> {
    const directory = join(this.root, "blobs");
    await this.secureDirectory(directory);
    const used = new Set(index.messages.flatMap((message) => (message.resources ?? []).map((resource) => resource.blob)));
    for (const name of await readdir(directory)) if (HASH.test(name) && !used.has(name)) await rm(join(directory, name), { force: true });
  }

  async remember(chatType: HistoryChatType, chatId: string, message: IncomingDirectMessage | IncomingMention): Promise<void> {
    return this.exclusive(async () => {
      const index = await this.load();
      const blobs = join(this.root, "blobs");
      await this.secureDirectory(blobs);
      const resources: StoredResource[] = [];
      let totalBytes = 0;
      for (const resource of (message.resources ?? []).slice(0, MAX_ATTACHMENT_COUNT)) {
        const info = await lstat(resource.path);
        if (info.isSymbolicLink() || !info.isFile() || info.size <= 0 || info.size > MAX_ATTACHMENT_BYTES) {
          throw new Error("企业微信历史附件不是安全的普通文件");
        }
        const content = await readFile(resource.path);
        totalBytes += content.length;
        if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) throw new Error(`企业微信附件总量超过 ${MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024} MB 安全上限`);
        const blob = createHash("sha256").update(content).digest("hex");
        const path = join(blobs, blob);
        try {
          await writeFile(path, content, { flag: "wx", mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          const existing = await lstat(path);
          if (existing.isSymbolicLink() || !existing.isFile()) throw new Error("ThreadFerry 历史附件存储无效");
        }
        resources.push({
          blob,
          type: resource.type,
          ...(resource.name ? { name: basename(resource.name) } : {}),
          size: content.length,
          contentType: resource.contentType,
        });
      }
      const stored: StoredMessage = {
        msgId: message.msgId,
        chatType,
        chatId,
        senderId: message.senderId,
        ...(message.senderName ? { senderName: message.senderName } : {}),
        time: message.time.toISOString(),
        text: message.text,
        ...(message.quote ? { quote: structuredClone(message.quote) } : {}),
        ...(message.attachments?.length ? { attachments: structuredClone(message.attachments) } : {}),
        ...(resources.length ? { resources } : {}),
      };
      index.messages = prune([
        ...index.messages.filter((item) => !(item.msgId === message.msgId && item.chatType === chatType && item.chatId === chatId)),
        stored,
      ], Date.now());
      await this.save(index);
      await this.collectBlobs(index);
    });
  }

  async list(chatType: HistoryChatType, chatId: string, options: Omit<HistoryQuery, "chatType">): Promise<GroupMessage[]> {
    return this.exclusive(async () => {
      const index = await this.load();
      index.messages = prune(index.messages, Date.now());
      await this.save(index);
      await this.collectBlobs(index);
      const begin = options.endTime.getTime() - options.lookbackHours * 60 * 60 * 1000;
      const selected = index.messages
        .filter((message) => message.chatType === chatType && message.chatId === chatId
          && Date.parse(message.time) >= begin && Date.parse(message.time) <= options.endTime.getTime())
        .slice(-options.maxMessages);
      const loaded = new Map<StoredMessage, AttachmentResource[]>();
      if (options.includeResources) {
        const candidates = selected.flatMap((message) => (message.resources ?? []).map((resource) => ({ message, resource })));
        const references: typeof candidates = [];
        let totalBytes = 0;
        for (let index = candidates.length - 1; index >= 0 && references.length < MAX_ATTACHMENT_COUNT; index -= 1) {
          const reference = candidates[index]!;
          if (totalBytes + reference.resource.size > MAX_ATTACHMENT_TOTAL_BYTES) continue;
          references.push(reference);
          totalBytes += reference.resource.size;
        }
        references.reverse();
        if (references.length) {
          const root = await createAttachmentRoot();
          const created: AttachmentResource[] = [];
          try {
            for (const [index, { message, resource }] of references.entries()) {
              if (!HASH.test(resource.blob)) throw new Error("ThreadFerry 历史附件标识无效");
              const path = join(this.root, "blobs", resource.blob);
              const info = await lstat(path);
              if (info.isSymbolicLink() || !info.isFile() || info.size !== resource.size) throw new Error("ThreadFerry 历史附件损坏");
              const content = await readFile(path);
              if (createHash("sha256").update(content).digest("hex") !== resource.blob) throw new Error("ThreadFerry 历史附件校验失败");
              const item = await saveAttachmentResource(root, content, {
                type: resource.type, source: "history", name: resource.name, index: index + 1,
              });
              created.push(item);
              loaded.set(message, [...(loaded.get(message) ?? []), item]);
            }
          } catch (error) {
            await cleanupAttachmentResources(created.length ? created : [{ root }]);
            throw error;
          }
        }
      }
      return selected.map((message) => ({
        senderId: message.senderId,
        ...(message.senderName ? { senderName: message.senderName } : {}),
        time: new Date(message.time),
        text: message.text,
        ...(message.quote ? { quote: structuredClone(message.quote) } : {}),
        ...(message.attachments?.length
          ? { attachments: message.attachments.map((attachment) => ({ ...attachment, source: "history" as const })) }
          : {}),
        ...(loaded.get(message)?.length ? { resources: loaded.get(message) } : {}),
      }));
    });
  }
}
