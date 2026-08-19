import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { AttachmentMetadata, IncomingMention, QuoteMetadata } from "./types.js";

export type TurnStatus = "queued" | "running" | "handled" | "stale" | "failed";
export type FailurePhase = "ack" | "history" | "runtime" | "freshness" | "reply" | "host";

export interface TurnRecord {
  id: string;
  group: string;
  status: TurnStatus;
  receivedAt: string;
  updatedAt: string;
  errorId?: string;
  failurePhase?: FailurePhase;
}

interface SessionRecord {
  group: string;
  workspace: string;
  sessionId: string;
  updatedAt: string;
}

interface StoredMention {
  msgId: string;
  groupId: string;
  senderId: string;
  senderName?: string;
  time: string;
  text: string;
  quote?: QuoteMetadata;
  attachments?: AttachmentMetadata[];
  mentioned: true;
}

export interface PendingDelivery {
  id: string;
  groupId: string;
  content: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  errorId?: string;
}

export interface StateSnapshot {
  turns: TurnRecord[];
  sessions: SessionRecord[];
  inbox: StoredMention[];
  outbox: PendingDelivery[];
}

interface StateDocument extends StateSnapshot {
  version: 3;
}

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_TURNS = 10_000;
const MAX_PENDING = 128;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_REPLY_BYTES = 12_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DIGEST = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ERROR_ID = /^TF-[A-F0-9]{8}$/;
const STATUSES = new Set<TurnStatus>(["queued", "running", "handled", "stale", "failed"]);
const PHASES = new Set<FailurePhase>(["ack", "history", "runtime", "freshness", "reply", "host"]);
const STATE_FIELDS = new Set(["version", "turns", "sessions", "inbox", "outbox"]);
const TURN_FIELDS = new Set(["id", "group", "status", "receivedAt", "updatedAt", "errorId", "failurePhase"]);
const SESSION_FIELDS = new Set(["group", "workspace", "sessionId", "updatedAt"]);
const INBOX_FIELDS = new Set(["msgId", "groupId", "senderId", "senderName", "time", "text", "quote", "attachments", "mentioned"]);
const OUTBOX_FIELDS = new Set(["id", "groupId", "content", "attempts", "createdAt", "updatedAt", "errorId"]);

function emptyState(): StateDocument {
  return { version: 3, turns: [], sessions: [], inbox: [], outbox: [] };
}

function key(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function validString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validQuote(value: unknown): value is QuoteMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const quote = value as Record<string, unknown>;
  return Object.keys(quote).every((field) => field === "type" || field === "text")
    && validString(quote.type, 64)
    && (quote.text === undefined || (typeof quote.text === "string" && quote.text.length <= MAX_MESSAGE_CHARS));
}

function validAttachments(value: unknown): value is AttachmentMetadata[] {
  return Array.isArray(value) && value.length <= 32 && value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const attachment = item as Record<string, unknown>;
    return Object.keys(attachment).every((field) => field === "type" || field === "name")
      && ["image", "file", "voice", "video"].includes(String(attachment.type))
      && (attachment.name === undefined || (typeof attachment.name === "string" && attachment.name.length <= 512));
  });
}

function validMention(value: unknown): value is StoredMention {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const mention = value as Record<string, unknown>;
  return Object.keys(mention).every((field) => INBOX_FIELDS.has(field))
    && validString(mention.msgId, 512)
    && validString(mention.groupId, 512)
    && validString(mention.senderId, 512)
    && (mention.senderName === undefined || (typeof mention.senderName === "string" && mention.senderName.length <= 512))
    && validDate(mention.time)
    && typeof mention.text === "string" && mention.text.length <= MAX_MESSAGE_CHARS
    && mention.mentioned === true
    && (mention.quote === undefined || validQuote(mention.quote))
    && (mention.attachments === undefined || validAttachments(mention.attachments));
}

function validateState(value: unknown): StateDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ThreadFerry 状态文件结构无效");
  const state = value as Partial<StateDocument>;
  if (Object.keys(value).some((field) => !STATE_FIELDS.has(field))
    || state.version !== 3 || !Array.isArray(state.turns) || !Array.isArray(state.sessions)
    || !Array.isArray(state.inbox) || !Array.isArray(state.outbox)) {
    throw new Error("ThreadFerry 状态文件版本或结构无效");
  }
  if (state.turns.length > MAX_TURNS || state.turns.some((turn) => !turn || typeof turn !== "object" || Array.isArray(turn)
    || Object.keys(turn).some((field) => !TURN_FIELDS.has(field))
    || !DIGEST.test(String((turn as TurnRecord).id)) || !DIGEST.test(String((turn as TurnRecord).group))
    || !STATUSES.has((turn as TurnRecord).status) || !validDate((turn as TurnRecord).receivedAt)
    || !validDate((turn as TurnRecord).updatedAt)
    || ((turn as TurnRecord).errorId !== undefined && !ERROR_ID.test(String((turn as TurnRecord).errorId)))
    || ((turn as TurnRecord).failurePhase !== undefined && !PHASES.has((turn as TurnRecord).failurePhase!)))) {
    throw new Error("ThreadFerry 执行状态记录无效");
  }
  if (state.sessions.some((session) => !session || typeof session !== "object" || Array.isArray(session)
    || Object.keys(session).some((field) => !SESSION_FIELDS.has(field))
    || !DIGEST.test(String((session as SessionRecord).group)) || !DIGEST.test(String((session as SessionRecord).workspace))
    || !SESSION_ID.test(String((session as SessionRecord).sessionId))
    || !validDate((session as SessionRecord).updatedAt))) {
    throw new Error("ThreadFerry Session 状态记录无效");
  }
  if (state.inbox.length > MAX_PENDING || state.inbox.some((message) => !validMention(message))) {
    throw new Error("ThreadFerry 待处理消息记录无效");
  }
  if (state.outbox.length > MAX_PENDING || state.outbox.some((delivery) => !delivery || typeof delivery !== "object" || Array.isArray(delivery)
    || Object.keys(delivery).some((field) => !OUTBOX_FIELDS.has(field))
    || !DIGEST.test(String((delivery as PendingDelivery).id))
    || !validString((delivery as PendingDelivery).groupId, 512)
    || !validString((delivery as PendingDelivery).content, MAX_MESSAGE_CHARS)
    || Buffer.byteLength((delivery as PendingDelivery).content) > MAX_REPLY_BYTES
    || !Number.isInteger((delivery as PendingDelivery).attempts) || (delivery as PendingDelivery).attempts < 0
    || !validDate((delivery as PendingDelivery).createdAt) || !validDate((delivery as PendingDelivery).updatedAt)
    || ((delivery as PendingDelivery).errorId !== undefined && !ERROR_ID.test(String((delivery as PendingDelivery).errorId))))) {
    throw new Error("ThreadFerry 待发送回复记录无效");
  }
  return state as StateDocument;
}

function storeMention(message: IncomingMention): StoredMention {
  const stored: StoredMention = { ...message, time: message.time.toISOString(), mentioned: true };
  if (!validMention(stored)) throw new Error("企业微信消息结构超过安全上限");
  return stored;
}

function restoreMention(message: StoredMention): IncomingMention {
  return { ...structuredClone(message), time: new Date(message.time) };
}

// Session 的第二维身份。两个机器人可能同在一个群，只按 groupId 定位会互相清掉对方的
// Session，所以重置必须带上这个作用域。app.ts 与重置路径共用这一处构造，避免漂移。
export function sessionScope(agentId: string, agent: { runtime: string; workspace: string }): string {
  return `${agentId}\0${agent.runtime}\0${agent.workspace}`;
}

export function defaultStatePath(): string {
  return join(homedir(), ".threadferry", "state-v3.json");
}

export function defaultLockPath(): string {
  return join(homedir(), ".threadferry", "host.lock");
}

export function newErrorId(): string {
  return `TF-${randomBytes(4).toString("hex").toUpperCase()}`;
}

export async function acquireHostLock(path = defaultLockPath()): Promise<{ release: () => Promise<void> }> {
  const directory = dirname(path);
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("ThreadFerry 状态目录不能是符号链接");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const token = randomBytes(16).toString("hex");
  const content = `${JSON.stringify({ pid: process.pid, token, startedAt: new Date().toISOString() })}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
      return {
        release: async () => {
          try {
            if ((await lstat(path)).isSymbolicLink()) return;
            const current = JSON.parse(await readFile(path, "utf8")) as { token?: unknown };
            if (current.token === token) await rm(path);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let pid: number;
      try {
        if ((await lstat(path)).isSymbolicLink()) throw new Error("锁文件不能是符号链接");
        const current = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
        if (!Number.isInteger(current.pid) || Number(current.pid) <= 0) throw new Error("PID 无效");
        pid = Number(current.pid);
      } catch {
        throw new Error(`ThreadFerry 锁文件无效；确认没有 ThreadFerry 进程后删除 ${path}`);
      }
      try {
        process.kill(pid, 0);
        throw new Error(`ThreadFerry 已在运行（PID ${pid}）`);
      } catch (probe) {
        if ((probe as NodeJS.ErrnoException).code !== "ESRCH") throw probe;
      }
      await rm(path);
    }
  }
  throw new Error("无法获取 ThreadFerry 单实例锁");
}

export class ThreadFerryState {
  private data = emptyState();
  private loaded = false;
  private pending = Promise.resolve();

  constructor(private readonly path?: string) {}

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation, operation);
    this.pending = result.then(() => undefined, () => undefined);
    return result;
  }

  private async load(): Promise<void> {
    if (this.loaded && !this.path) return;
    if (!this.path) {
      this.loaded = true;
      return;
    }
    try {
      const info = await lstat(this.path);
      if (info.isSymbolicLink()) throw new Error("ThreadFerry 状态文件不能是符号链接");
      if (info.size > MAX_STATE_BYTES) throw new Error("ThreadFerry 状态文件超过安全上限");
      this.data = validateState(JSON.parse(await readFile(this.path, "utf8")));
      await chmod(this.path, 0o600);
      this.loaded = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.loaded = true;
    }
  }

  private async save(): Promise<void> {
    if (!this.path) return;
    const directory = dirname(this.path);
    try {
      if ((await lstat(directory)).isSymbolicLink()) throw new Error("ThreadFerry 状态目录不能是符号链接");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const content = `${JSON.stringify(this.data)}\n`;
    if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error("ThreadFerry 状态文件超过安全上限");
    const temporary = join(directory, `.${basename(this.path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async enqueue(message: IncomingMention): Promise<boolean> {
    return this.exclusive(async () => {
      const stored = storeMention(message);
      await this.load();
      const id = key(message.msgId);
      if (this.data.turns.some((turn) => turn.id === id)) return false;
      if (this.data.inbox.length >= MAX_PENDING) throw new Error("ThreadFerry 待处理队列已满");
      if (this.data.outbox.length >= MAX_PENDING) throw new Error("ThreadFerry 待发送队列已满，请先恢复消息投递");
      while (this.data.turns.length >= MAX_TURNS) {
        const removable = this.data.turns.findIndex((turn) => turn.status !== "queued" && turn.status !== "running");
        if (removable === -1) throw new Error("ThreadFerry 执行队列已满");
        this.data.turns.splice(removable, 1);
      }
      const now = new Date().toISOString();
      this.data.turns.push({ id, group: key(message.groupId), status: "queued", receivedAt: now, updatedAt: now });
      this.data.inbox.push(stored);
      await this.save();
      return true;
    });
  }

  async claimCommand(msgId: string, scopeId: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!validString(msgId, 512) || !validString(scopeId, 512)) throw new Error("命令消息标识无效");
      await this.load();
      const id = key(msgId);
      if (this.data.turns.some((turn) => turn.id === id)) return false;
      while (this.data.turns.length >= MAX_TURNS) {
        const removable = this.data.turns.findIndex((turn) => turn.status !== "queued" && turn.status !== "running");
        if (removable === -1) throw new Error("ThreadFerry 执行队列已满");
        this.data.turns.splice(removable, 1);
      }
      const now = new Date().toISOString();
      this.data.turns.push({ id, group: key(scopeId), status: "handled", receivedAt: now, updatedAt: now });
      await this.save();
      return true;
    });
  }

  async markRunning(msgId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      const turn = this.data.turns.find((candidate) => candidate.id === key(msgId));
      if (!turn) throw new Error("ThreadFerry 状态缺少当前消息");
      turn.status = "running";
      turn.updatedAt = new Date().toISOString();
      await this.save();
    });
  }

  async finish(msgId: string, status: "failed", failure: { errorId: string; phase: FailurePhase }): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      const id = key(msgId);
      const turn = this.data.turns.find((candidate) => candidate.id === id);
      if (!turn) throw new Error("ThreadFerry 状态缺少当前消息");
      turn.status = status;
      turn.updatedAt = new Date().toISOString();
      turn.errorId = failure.errorId;
      turn.failurePhase = failure.phase;
      this.data.inbox = this.data.inbox.filter((message) => key(message.msgId) !== id);
      await this.save();
    });
  }

  async finishWithDelivery(
    msgId: string,
    groupId: string,
    status: "handled" | "stale" | "failed",
    content: string,
    failure?: { errorId: string; phase: FailurePhase },
  ): Promise<string> {
    return this.exclusive(async () => {
      if (!validString(content, MAX_MESSAGE_CHARS) || Buffer.byteLength(content) > MAX_REPLY_BYTES) {
        throw new Error("回复超过安全上限");
      }
      await this.load();
      const id = key(msgId);
      const turn = this.data.turns.find((candidate) => candidate.id === id);
      if (!turn || turn.group !== key(groupId)) throw new Error("ThreadFerry 状态缺少当前消息");
      if (!this.data.outbox.some((delivery) => delivery.id === id) && this.data.outbox.length >= MAX_PENDING) {
        throw new Error("ThreadFerry 待发送队列已满");
      }
      const now = new Date().toISOString();
      turn.status = status;
      turn.updatedAt = now;
      if (failure) {
        turn.errorId = failure.errorId;
        turn.failurePhase = failure.phase;
      }
      this.data.inbox = this.data.inbox.filter((message) => key(message.msgId) !== id);
      const delivery: PendingDelivery = { id, groupId, content, attempts: 0, createdAt: now, updatedAt: now };
      const current = this.data.outbox.find((item) => item.id === id);
      if (current) Object.assign(current, delivery);
      else this.data.outbox.push(delivery);
      await this.save();
      return id;
    });
  }

  async deliveryFailed(id: string, errorId: string): Promise<void> {
    await this.exclusive(async () => {
      if (!DIGEST.test(id) || !ERROR_ID.test(errorId)) throw new Error("投递状态标识无效");
      await this.load();
      const delivery = this.data.outbox.find((item) => item.id === id);
      if (!delivery) return;
      delivery.attempts += 1;
      delivery.updatedAt = new Date().toISOString();
      delivery.errorId = errorId;
      await this.save();
    });
  }

  async completeDelivery(id: string): Promise<void> {
    await this.exclusive(async () => {
      if (!DIGEST.test(id)) throw new Error("投递状态标识无效");
      await this.load();
      const before = this.data.outbox.length;
      this.data.outbox = this.data.outbox.filter((item) => item.id !== id);
      if (this.data.outbox.length !== before) await this.save();
    });
  }

  async recoverPending(): Promise<IncomingMention[]> {
    return this.exclusive(async () => {
      await this.load();
      let changed = false;
      for (const message of this.data.inbox) {
        const turn = this.data.turns.find((candidate) => candidate.id === key(message.msgId));
        if (turn && turn.status !== "queued") {
          turn.status = "queued";
          turn.updatedAt = new Date().toISOString();
          changed = true;
        }
      }
      if (changed) await this.save();
      return this.data.inbox.map(restoreMention);
    });
  }

  async pendingDeliveries(): Promise<PendingDelivery[]> {
    return this.exclusive(async () => {
      await this.load();
      return structuredClone(this.data.outbox);
    });
  }

  async session(groupId: string, scope: string): Promise<string | undefined> {
    return this.exclusive(async () => {
      await this.load();
      const current = this.data.sessions.find((item) => item.group === key(groupId) && item.workspace === key(scope));
      if (!current) return undefined;
      if (Date.now() - Date.parse(current.updatedAt) <= SESSION_TTL_MS) return current.sessionId;
      this.data.sessions = this.data.sessions.filter((item) => item !== current);
      await this.save();
      return undefined;
    });
  }

  async setSession(groupId: string, scope: string, sessionId: string): Promise<void> {
    await this.exclusive(async () => {
      if (!SESSION_ID.test(sessionId)) throw new Error("Runtime Session ID 无效");
      await this.load();
      const group = key(groupId);
      const workspaceKey = key(scope);
      const current = this.data.sessions.find((item) => item.group === group && item.workspace === workspaceKey);
      const next = { group, workspace: workspaceKey, sessionId, updatedAt: new Date().toISOString() };
      if (current) Object.assign(current, next);
      else this.data.sessions.push(next);
      await this.save();
    });
  }

  // scope 省略时清掉该群所有 Agent 的 Session；传入时只清该 Agent 的。
  async clearSession(groupId: string, scope?: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.load();
      const group = key(groupId);
      const workspace = scope === undefined ? undefined : key(scope);
      if (this.data.turns.some((turn) => turn.group === group && (turn.status === "queued" || turn.status === "running"))) {
        throw new Error("该群仍有任务运行或排队，不能重置 Session");
      }
      const before = this.data.sessions.length;
      this.data.sessions = this.data.sessions.filter((item) => {
        return !(item.group === group && (workspace === undefined || item.workspace === workspace));
      });
      if (this.data.sessions.length !== before) await this.save();
      return this.data.sessions.length !== before;
    });
  }

  async snapshot(): Promise<StateSnapshot> {
    return this.exclusive(async () => {
      await this.load();
      return structuredClone({ turns: this.data.turns, sessions: this.data.sessions, inbox: this.data.inbox, outbox: this.data.outbox });
    });
  }
}
