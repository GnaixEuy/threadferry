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
  /** 当初受理这条消息的 Agent。同群多机器人时，恢复必须回到同一台。 */
  agent?: string;
}

export interface PendingDelivery {
  id: string;
  groupId: string;
  content: string;
  /** 该由哪台机器人补发。缺省表示旧记录，由调用方按群里唯一的 Agent 兜底。 */
  agent?: string;
  /** 主动提醒或协作任务回执；普通会话回复不设，避免调度器并发抢发。 */
  proactive?: true;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  errorId?: string;
}

export interface ActivityRecord {
  id: string;
  agent: string;
  type: string;
  outcome: "success" | "failure" | "info";
  resource?: string;
  at: string;
}

export interface ReminderRecord {
  id: string;
  agent: string;
  chatId: string;
  chatType: "single" | "group";
  createdBy: string;
  instruction: string;
  nextRunAt: string;
  repeatMinutes?: number;
  status: "scheduled" | "running" | "completed" | "cancelled";
  runningAt?: string;
  failures: number;
  createdAt: string;
  updatedAt: string;
}

export interface WorkItemRecord {
  id: string;
  title: string;
  description: string;
  createdBy: string;
  createdAgent: string;
  assignedAgent: string;
  reviewerAgent?: string;
  sourceChatId: string;
  sourceChatType: "single" | "group";
  status: "queued" | "running" | "review" | "reviewing" | "completed" | "failed";
  result?: string;
  review?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StateSnapshot {
  turns: TurnRecord[];
  sessions: SessionRecord[];
  inbox: StoredMention[];
  outbox: PendingDelivery[];
  activities?: ActivityRecord[];
  reminders?: ReminderRecord[];
  workItems?: WorkItemRecord[];
}

interface StateDocument extends StateSnapshot {
  version: 4;
  activities: ActivityRecord[];
  reminders: ReminderRecord[];
  workItems: WorkItemRecord[];
}

const MAX_STATE_BYTES = 4 * 1024 * 1024;
const MAX_TURNS = 10_000;
const MAX_PENDING = 128;
const MAX_ACTIVITIES = 1_000;
const MAX_REMINDERS = 256;
const MAX_WORK_ITEMS = 64;
const MAX_MESSAGE_CHARS = 32_000;
const MAX_REPLY_BYTES = 12_000;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORK_STALE_MS = 60 * 60 * 1_000;
const DIGEST = /^[a-f0-9]{64}$/;
const SESSION_ID = /^[A-Za-z0-9_-]{1,160}$/;
const ERROR_ID = /^TF-[A-F0-9]{8}$/;
const ACTIVITY_ID = /^A-[A-F0-9]{12}$/;
const REMINDER_ID = /^R-[A-F0-9]{12}$/;
const WORK_ID = /^W-[A-F0-9]{12}$/;
const STATUSES = new Set<TurnStatus>(["queued", "running", "handled", "stale", "failed"]);
const PHASES = new Set<FailurePhase>(["ack", "history", "runtime", "freshness", "reply", "host"]);
const LEGACY_STATE_FIELDS = new Set(["version", "turns", "sessions", "inbox", "outbox"]);
const STATE_FIELDS = new Set([...LEGACY_STATE_FIELDS, "activities", "reminders", "workItems"]);
const TURN_FIELDS = new Set(["id", "group", "status", "receivedAt", "updatedAt", "errorId", "failurePhase"]);
const SESSION_FIELDS = new Set(["group", "workspace", "sessionId", "updatedAt"]);
// agent 是可选的：一个群可以同时挂多台机器人，重启后补发必须知道当初是哪一台，
// 否则会用另一台机器人的身份把回复发出去。旧状态文件没这个字段，按缺省处理。
const INBOX_FIELDS = new Set(["msgId", "groupId", "senderId", "senderName", "time", "text", "quote", "attachments", "mentioned", "agent"]);
const OUTBOX_FIELDS = new Set(["id", "groupId", "content", "attempts", "createdAt", "updatedAt", "errorId", "agent", "proactive"]);
const ACTIVITY_FIELDS = new Set(["id", "agent", "type", "outcome", "resource", "at"]);
const REMINDER_FIELDS = new Set(["id", "agent", "chatId", "chatType", "createdBy", "instruction", "nextRunAt", "repeatMinutes", "status", "runningAt", "failures", "createdAt", "updatedAt"]);
const WORK_FIELDS = new Set(["id", "title", "description", "createdBy", "createdAgent", "assignedAgent", "reviewerAgent", "sourceChatId", "sourceChatType", "status", "result", "review", "createdAt", "updatedAt"]);

function emptyState(): StateDocument {
  return { version: 4, turns: [], sessions: [], inbox: [], outbox: [], activities: [], reminders: [], workItems: [] };
}

function key(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// 群里同时 @ 两台机器人时，企业微信给每台各发一次回调，**msgId 是同一条消息的**。
// 所以 turn 和待发送记录的身份必须带上 Agent，否则第二台会被判成「已经处理过」而不回话，
// 待补发的回复也会互相覆盖。不带 Agent 时保持原样，兼容 0.16.0 写下的记录。
function turnId(msgId: string, agent?: string): string {
  return key(agent ? `${agent}\u0000${msgId}` : msgId);
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
    return Object.keys(attachment).every((field) => field === "type" || field === "name" || field === "source")
      && ["image", "file", "voice", "video"].includes(String(attachment.type))
      && (attachment.name === undefined || (typeof attachment.name === "string" && attachment.name.length <= 512))
      && (attachment.source === undefined || ["message", "quote", "history"].includes(String(attachment.source)));
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
    && (mention.agent === undefined || validString(mention.agent, 128))
    && (mention.attachments === undefined || validAttachments(mention.attachments));
}

function validActivity(value: unknown): value is ActivityRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((field) => ACTIVITY_FIELDS.has(field))
    && ACTIVITY_ID.test(String(item.id))
    && validString(item.agent, 128)
    && validString(item.type, 64)
    && ["success", "failure", "info"].includes(String(item.outcome))
    && (item.resource === undefined || validString(item.resource, 1_024))
    && validDate(item.at);
}

function validReminder(value: unknown): value is ReminderRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((field) => REMINDER_FIELDS.has(field))
    && REMINDER_ID.test(String(item.id))
    && validString(item.agent, 128)
    && validString(item.chatId, 512)
    && ["single", "group"].includes(String(item.chatType))
    && validString(item.createdBy, 512)
    && validString(item.instruction, 8_000)
    && validDate(item.nextRunAt)
    && (item.repeatMinutes === undefined || Number.isInteger(item.repeatMinutes) && Number(item.repeatMinutes) >= 1 && Number(item.repeatMinutes) <= 525_600)
    && ["scheduled", "running", "completed", "cancelled"].includes(String(item.status))
    && (item.runningAt === undefined || validDate(item.runningAt))
    && Number.isInteger(item.failures) && Number(item.failures) >= 0
    && validDate(item.createdAt) && validDate(item.updatedAt);
}

function validWorkItem(value: unknown): value is WorkItemRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).every((field) => WORK_FIELDS.has(field))
    && WORK_ID.test(String(item.id))
    && validString(item.title, 1_000)
    && typeof item.description === "string" && item.description.length <= 8_000
    && validString(item.createdBy, 512)
    && validString(item.createdAgent, 128)
    && validString(item.assignedAgent, 128)
    && (item.reviewerAgent === undefined || validString(item.reviewerAgent, 128))
    && validString(item.sourceChatId, 512)
    && ["single", "group"].includes(String(item.sourceChatType))
    && ["queued", "running", "review", "reviewing", "completed", "failed"].includes(String(item.status))
    && (item.result === undefined || typeof item.result === "string" && item.result.length <= 12_000)
    && (item.review === undefined || typeof item.review === "string" && item.review.length <= 12_000)
    && validDate(item.createdAt) && validDate(item.updatedAt);
}

function validateState(value: unknown): StateDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ThreadFerry 状态文件结构无效");
  const source = value as Record<string, unknown>;
  if (source.version === 3 && Object.keys(source).some((field) => !LEGACY_STATE_FIELDS.has(field))) {
    throw new Error("ThreadFerry 状态文件版本或结构无效");
  }
  const migrated = source.version === 3
    ? { ...source, version: 4, activities: [], reminders: [], workItems: [] }
    : source;
  const state = migrated as unknown as Partial<StateDocument>;
  if (Object.keys(migrated).some((field) => !STATE_FIELDS.has(field))
    || state.version !== 4 || !Array.isArray(state.turns) || !Array.isArray(state.sessions)
    || !Array.isArray(state.inbox) || !Array.isArray(state.outbox)
    || !Array.isArray(state.activities) || !Array.isArray(state.reminders) || !Array.isArray(state.workItems)) {
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
    || ((delivery as PendingDelivery).proactive !== undefined && (delivery as PendingDelivery).proactive !== true)
    || !validDate((delivery as PendingDelivery).createdAt) || !validDate((delivery as PendingDelivery).updatedAt)
    || ((delivery as PendingDelivery).errorId !== undefined && !ERROR_ID.test(String((delivery as PendingDelivery).errorId))))) {
    throw new Error("ThreadFerry 待发送回复记录无效");
  }
  if (state.activities.length > MAX_ACTIVITIES || state.activities.some((item) => !validActivity(item))) {
    throw new Error("ThreadFerry Activity 记录无效");
  }
  if (state.reminders.length > MAX_REMINDERS || state.reminders.some((item) => !validReminder(item))) {
    throw new Error("ThreadFerry 提醒记录无效");
  }
  if (state.workItems.length > MAX_WORK_ITEMS || state.workItems.some((item) => !validWorkItem(item))) {
    throw new Error("ThreadFerry 任务记录无效");
  }
  return state as StateDocument;
}

function storeMention(message: IncomingMention, agent?: string): StoredMention {
  const { resources: _resources, ...durable } = message;
  const stored: StoredMention = { ...durable, time: message.time.toISOString(), mentioned: true, ...(agent ? { agent } : {}) };
  if (!validMention(stored)) throw new Error("企业微信消息结构超过安全上限");
  return stored;
}

function restoreMention(message: StoredMention): IncomingMention {
  const { agent, ...rest } = structuredClone(message);
  return { ...rest, time: new Date(message.time) };
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

  async enqueue(message: IncomingMention, agent?: string): Promise<boolean> {
    return this.exclusive(async () => {
      const stored = storeMention(message, agent);
      await this.load();
      const id = turnId(message.msgId, agent);
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

  async claimCommand(msgId: string, scopeId: string, agent?: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!validString(msgId, 512) || !validString(scopeId, 512)) throw new Error("命令消息标识无效");
      await this.load();
      const id = turnId(msgId, agent);
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

  async markRunning(msgId: string, agent?: string): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      const turn = this.findTurn(msgId, agent);
      if (!turn) throw new Error("ThreadFerry 状态缺少当前消息");
      turn.status = "running";
      turn.updatedAt = new Date().toISOString();
      await this.save();
    });
  }

  async finish(
    msgId: string,
    status: "failed",
    failure: { errorId: string; phase: FailurePhase },
    agent?: string,
  ): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      const turn = this.findTurn(msgId, agent);
      if (!turn) throw new Error("ThreadFerry 状态缺少当前消息");
      turn.status = status;
      turn.updatedAt = new Date().toISOString();
      turn.errorId = failure.errorId;
      turn.failurePhase = failure.phase;
      this.dropInbox(msgId, agent);
      await this.save();
    });
  }

  // 0.16.0 写下的 turn 没有 Agent 维度，升级后仍要能收尾，所以找不到就退回不带 Agent 的旧身份。
  private findTurn(msgId: string, agent?: string): TurnRecord | undefined {
    const scoped = this.data.turns.find((turn) => turn.id === turnId(msgId, agent));
    if (scoped || !agent) return scoped;
    return this.data.turns.find((turn) => turn.id === key(msgId));
  }

  // 同一条 msgId 在收件箱里可能有多条（一台机器人一条），只清掉属于自己的那条。
  private dropInbox(msgId: string, agent?: string): void {
    this.data.inbox = this.data.inbox.filter((message) => message.msgId !== msgId
      ? true
      : !(message.agent === agent || message.agent === undefined || agent === undefined));
  }

  async finishWithDelivery(
    msgId: string,
    groupId: string,
    status: "handled" | "stale" | "failed",
    content: string,
    failure?: { errorId: string; phase: FailurePhase },
    agent?: string,
  ): Promise<string> {
    return this.exclusive(async () => {
      if (!validString(content, MAX_MESSAGE_CHARS) || Buffer.byteLength(content) > MAX_REPLY_BYTES) {
        throw new Error("回复超过安全上限");
      }
      await this.load();
      const turn = this.findTurn(msgId, agent);
      if (!turn || turn.group !== key(groupId)) throw new Error("ThreadFerry 状态缺少当前消息");
      // 待发送记录也按 Agent 分开：两台机器人对同一条消息各有一份回复，不能互相覆盖。
      const id = turn.id;
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
      this.dropInbox(msgId, agent);
      const delivery: PendingDelivery = { id, groupId, content, attempts: 0, createdAt: now, updatedAt: now, ...(agent ? { agent } : {}) };
      const current = this.data.outbox.find((item) => item.id === id);
      if (current) Object.assign(current, delivery);
      else this.data.outbox.push(delivery);
      await this.save();
      return id;
    });
  }

  async queueDelivery(identity: string, chatId: string, content: string, agent: string, active = true): Promise<string> {
    return this.exclusive(async () => {
      if (!validString(identity, 512) || !validString(chatId, 512) || !validString(agent, 128)
        || !validString(content, MAX_MESSAGE_CHARS) || Buffer.byteLength(content) > MAX_REPLY_BYTES) {
        throw new Error("主动通知参数无效或超过安全上限");
      }
      await this.load();
      const id = key(identity);
      if (this.data.outbox.some((delivery) => delivery.id === id)) return id;
      if (this.data.outbox.length >= MAX_PENDING) throw new Error("ThreadFerry 待发送队列已满");
      const now = new Date().toISOString();
      this.data.outbox.push({ id, groupId: chatId, content, agent, ...(active ? { proactive: true as const } : {}), attempts: 0, createdAt: now, updatedAt: now });
      await this.save();
      return id;
    });
  }

  async deliveryFailed(id: string, errorId: string, activate = false): Promise<void> {
    await this.exclusive(async () => {
      if (!DIGEST.test(id) || !ERROR_ID.test(errorId)) throw new Error("投递状态标识无效");
      await this.load();
      const delivery = this.data.outbox.find((item) => item.id === id);
      if (!delivery) return;
      delivery.attempts += 1;
      delivery.updatedAt = new Date().toISOString();
      delivery.errorId = errorId;
      if (activate) delivery.proactive = true;
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

  async recoverPending(): Promise<Array<{ message: IncomingMention; agent?: string }>> {
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
      return this.data.inbox.map((message) => ({
        message: restoreMention(message),
        ...(message.agent ? { agent: message.agent } : {}),
      }));
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

  async recordActivity(input: {
    agent: string;
    type: string;
    outcome: ActivityRecord["outcome"];
    resource?: string;
    at?: Date;
  }): Promise<ActivityRecord> {
    return this.exclusive(async () => {
      await this.load();
      const activity: ActivityRecord = {
        id: `A-${randomBytes(6).toString("hex").toUpperCase()}`,
        agent: input.agent,
        type: input.type,
        outcome: input.outcome,
        ...(input.resource ? { resource: input.resource } : {}),
        at: (input.at ?? new Date()).toISOString(),
      };
      if (!validActivity(activity)) throw new Error("Activity 参数无效");
      this.data.activities.push(activity);
      if (this.data.activities.length > MAX_ACTIVITIES) this.data.activities.splice(0, this.data.activities.length - MAX_ACTIVITIES);
      await this.save();
      return structuredClone(activity);
    });
  }

  async recentActivities(limit = 100, agent?: string): Promise<ActivityRecord[]> {
    return this.exclusive(async () => {
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("Activity 数量必须是 1～500");
      await this.load();
      return structuredClone(this.data.activities.filter((item) => !agent || item.agent === agent).slice(-limit).reverse());
    });
  }

  async createReminder(input: {
    agent: string;
    chatId: string;
    chatType: ReminderRecord["chatType"];
    createdBy: string;
    instruction: string;
    runAt: string;
    repeatMinutes?: number;
  }): Promise<ReminderRecord> {
    return this.exclusive(async () => {
      await this.load();
      while (this.data.reminders.length >= MAX_REMINDERS) {
        const removable = this.data.reminders.findIndex((item) => item.status === "completed" || item.status === "cancelled");
        if (removable === -1) throw new Error("提醒数量已达到上限");
        this.data.reminders.splice(removable, 1);
      }
      const now = new Date().toISOString();
      const reminder: ReminderRecord = {
        id: `R-${randomBytes(6).toString("hex").toUpperCase()}`,
        agent: input.agent,
        chatId: input.chatId,
        chatType: input.chatType,
        createdBy: input.createdBy,
        instruction: input.instruction,
        nextRunAt: input.runAt,
        ...(input.repeatMinutes ? { repeatMinutes: input.repeatMinutes } : {}),
        status: "scheduled",
        failures: 0,
        createdAt: now,
        updatedAt: now,
      };
      if (!validReminder(reminder)) throw new Error("提醒参数无效");
      this.data.reminders.push(reminder);
      await this.save();
      return structuredClone(reminder);
    });
  }

  async listReminders(agent?: string): Promise<ReminderRecord[]> {
    return this.exclusive(async () => {
      await this.load();
      return structuredClone(this.data.reminders.filter((item) => !agent || item.agent === agent));
    });
  }

  async updateReminder(id: string, patch: { instruction?: string; runAt?: string; repeatMinutes?: number | null }): Promise<ReminderRecord> {
    return this.exclusive(async () => {
      await this.load();
      const reminder = this.data.reminders.find((item) => item.id === id);
      if (!reminder || reminder.status === "completed" || reminder.status === "cancelled") throw new Error("提醒不存在或已经结束");
      if (patch.instruction !== undefined) reminder.instruction = patch.instruction;
      if (patch.runAt !== undefined) reminder.nextRunAt = patch.runAt;
      if (patch.repeatMinutes === null) delete reminder.repeatMinutes;
      else if (patch.repeatMinutes !== undefined) reminder.repeatMinutes = patch.repeatMinutes;
      reminder.status = "scheduled";
      delete reminder.runningAt;
      reminder.updatedAt = new Date().toISOString();
      if (!validReminder(reminder)) throw new Error("提醒参数无效");
      await this.save();
      return structuredClone(reminder);
    });
  }

  async cancelReminder(id: string): Promise<boolean> {
    return this.exclusive(async () => {
      await this.load();
      const reminder = this.data.reminders.find((item) => item.id === id);
      if (!reminder || reminder.status === "completed" || reminder.status === "cancelled") return false;
      reminder.status = "cancelled";
      delete reminder.runningAt;
      reminder.updatedAt = new Date().toISOString();
      await this.save();
      return true;
    });
  }

  async claimDueReminders(now = new Date()): Promise<ReminderRecord[]> {
    return this.exclusive(async () => {
      await this.load();
      const nowMs = now.getTime();
      const staleBefore = nowMs - 5 * 60_000;
      const claimed = this.data.reminders.filter((item) =>
        item.status === "scheduled" && Date.parse(item.nextRunAt) <= nowMs
        || item.status === "running" && item.runningAt !== undefined && Date.parse(item.runningAt) <= staleBefore);
      for (const reminder of claimed) {
        reminder.status = "running";
        reminder.runningAt = now.toISOString();
        reminder.updatedAt = now.toISOString();
      }
      if (claimed.length) await this.save();
      return structuredClone(claimed);
    });
  }

  async finishReminder(id: string, success: boolean, now = new Date()): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      const reminder = this.data.reminders.find((item) => item.id === id);
      if (!reminder || reminder.status !== "running") return;
      delete reminder.runningAt;
      reminder.updatedAt = now.toISOString();
      if (success) {
        reminder.failures = 0;
        if (reminder.repeatMinutes) {
          reminder.status = "scheduled";
          reminder.nextRunAt = new Date(now.getTime() + reminder.repeatMinutes * 60_000).toISOString();
        } else {
          reminder.status = "completed";
        }
      } else {
        reminder.failures += 1;
        reminder.status = "scheduled";
        const retryMinutes = Math.min(5 * 2 ** (reminder.failures - 1), 60);
        reminder.nextRunAt = new Date(now.getTime() + retryMinutes * 60_000).toISOString();
      }
      await this.save();
    });
  }

  async createWorkItem(input: {
    title: string;
    description: string;
    createdBy: string;
    createdAgent: string;
    assignedAgent: string;
    reviewerAgent?: string;
    sourceChatId: string;
    sourceChatType: WorkItemRecord["sourceChatType"];
  }): Promise<WorkItemRecord> {
    return this.exclusive(async () => {
      await this.load();
      while (this.data.workItems.length >= MAX_WORK_ITEMS) {
        const removable = this.data.workItems.findIndex((item) => item.status === "completed" || item.status === "failed");
        if (removable === -1) throw new Error("协作任务数量已达到上限");
        this.data.workItems.splice(removable, 1);
      }
      const now = new Date().toISOString();
      const work: WorkItemRecord = {
        id: `W-${randomBytes(6).toString("hex").toUpperCase()}`,
        ...input,
        status: "queued",
        createdAt: now,
        updatedAt: now,
      };
      if (!validWorkItem(work)) throw new Error("协作任务参数无效");
      this.data.workItems.push(work);
      await this.save();
      return structuredClone(work);
    });
  }

  async listWorkItems(agent?: string): Promise<WorkItemRecord[]> {
    return this.exclusive(async () => {
      await this.load();
      return structuredClone(this.data.workItems.filter((item) => !agent
        || item.createdAgent === agent || item.assignedAgent === agent || item.reviewerAgent === agent));
    });
  }

  async getWorkItem(id: string): Promise<WorkItemRecord | undefined> {
    return this.exclusive(async () => {
      await this.load();
      const item = this.data.workItems.find((candidate) => candidate.id === id);
      return item ? structuredClone(item) : undefined;
    });
  }

  async handoffWorkItem(id: string, assignedAgent: string): Promise<WorkItemRecord> {
    return this.exclusive(async () => {
      await this.load();
      const item = this.data.workItems.find((candidate) => candidate.id === id);
      if (!item || ["completed", "failed"].includes(item.status)) throw new Error("协作任务不存在或已经结束");
      item.assignedAgent = assignedAgent;
      item.status = "queued";
      delete item.result;
      delete item.review;
      item.updatedAt = new Date().toISOString();
      if (!validWorkItem(item)) throw new Error("协作任务参数无效");
      await this.save();
      return structuredClone(item);
    });
  }

  async claimWorkItems(agent: string, now = new Date()): Promise<WorkItemRecord[]> {
    return this.exclusive(async () => {
      await this.load();
      // ponytail: 一小时租约避免崩溃后永久卡住；需要超长任务时再补心跳续租。
      const staleBefore = now.getTime() - WORK_STALE_MS;
      const claimed = this.data.workItems.filter((item) =>
        (item.status === "queued" || item.status === "running" && Date.parse(item.updatedAt) <= staleBefore) && item.assignedAgent === agent
        || (item.status === "review" || item.status === "reviewing" && Date.parse(item.updatedAt) <= staleBefore) && item.reviewerAgent === agent);
      const claimedAt = now.toISOString();
      for (const item of claimed) {
        item.status = item.status === "review" || item.status === "reviewing" ? "reviewing" : "running";
        item.updatedAt = claimedAt;
      }
      if (claimed.length) await this.save();
      return structuredClone(claimed);
    });
  }

  async completeWorkItem(id: string, output: string): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      const item = this.data.workItems.find((candidate) => candidate.id === id);
      if (!item || !["running", "reviewing"].includes(item.status)) throw new Error("协作任务没有处于执行状态");
      if (output.length > 12_000) throw new Error("协作任务输出超过安全上限");
      if (item.status === "reviewing") {
        item.review = output;
        item.status = "completed";
      } else {
        item.result = output;
        item.status = item.reviewerAgent ? "review" : "completed";
      }
      item.updatedAt = new Date().toISOString();
      await this.save();
    });
  }

  async releaseWorkItem(id: string): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      const item = this.data.workItems.find((candidate) => candidate.id === id);
      if (!item || !["running", "reviewing"].includes(item.status)) return;
      item.status = item.status === "reviewing" ? "review" : "queued";
      item.updatedAt = new Date().toISOString();
      await this.save();
    });
  }

  async failWorkItem(id: string, output: string): Promise<void> {
    await this.exclusive(async () => {
      await this.load();
      const item = this.data.workItems.find((candidate) => candidate.id === id);
      if (!item) return;
      item.result = output.slice(0, 12_000);
      item.status = "failed";
      item.updatedAt = new Date().toISOString();
      await this.save();
    });
  }

  async snapshot(): Promise<StateSnapshot> {
    return this.exclusive(async () => {
      await this.load();
      return structuredClone({
        turns: this.data.turns,
        sessions: this.data.sessions,
        inbox: this.data.inbox,
        outbox: this.data.outbox,
        activities: this.data.activities,
        reminders: this.data.reminders,
        workItems: this.data.workItems,
      });
    });
  }
}
