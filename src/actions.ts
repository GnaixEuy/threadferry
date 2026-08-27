import { createHash } from "node:crypto";

/**
 * Runtime 只提议动作，ThreadFerry 负责授权和执行。企业微信业务流程、能力选择、参数组装与
 * 结果表达属于官方 wecom-unified Skill；这里仅保留 CLI 信任边界和 ThreadFerry 自身动作。
 */

export type ActionMode = "read" | "write" | "destructive";

export interface ProposedAction {
  name: string;
  arguments: Record<string, unknown>;
  skill?: string;
  userIntent: "explicit" | "confirm";
}

export interface PreparedAction {
  name: string;
  summary: string;
  command: string[];
  mode: ActionMode;
  private?: boolean;
  resource?: string;
}

const FENCE = /```threadferry-action[^\n]*\n([\s\S]*?)```/g;
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const WECOM_ACTION = "wecom-cli";
const MAX_COMMAND_BYTES = 256 * 1024;
const COMMAND_TOKEN = /^[a-z][a-z0-9-]*$/;
const READ_METHODS = new Set(["download", "export", "get", "list", "query", "search"]);
const WRITE_METHODS = new Set(["add", "append", "copy", "create", "import", "move", "rename", "send", "set", "update", "upload"]);
const DESTRUCTIVE_METHODS = new Set(["cancel", "clear", "delete", "finish", "overwrite", "remove"]);
const PRIVATE_SERVICES = new Set(["chat", "contact", "disk", "doc", "mail", "media", "message", "sheet", "smartpage", "smartsheet"]);
const LOCAL_PATH_FIELDS = new Set(["content_path", "file_path", "image_path", "local_path", "output_dir"]);
const CREDENTIAL_FIELDS = new Set(["access_token", "authorization", "bot_secret", "credential", "credentials", "secret"]);

const WECOM_SERVICES = new Set([
  "calendar", "chat", "contact", "disk", "doc", "mail", "media",
  "meeting", "message", "sheet", "smartpage", "smartsheet", "todo",
]);

function text(value: unknown, field: string, max: number, required = false): string | undefined {
  if (value === undefined || value === null || value === "") {
    if (required) throw new Error(`${field}不能为空`);
    return undefined;
  }
  if (typeof value !== "string") throw new Error(`${field}必须是文本`);
  const trimmed = value.trim();
  if (!trimmed && required) throw new Error(`${field}不能为空`);
  if (trimmed.length > max) throw new Error(`${field}过长（最多 ${max} 个字符）`);
  return trimmed || undefined;
}

function time(value: unknown, field: string): string {
  const parsed = text(value, field, 32, true)!;
  if (!TIME.test(parsed)) throw new Error(`${field}必须形如 2026-08-21 10:00:00`);
  const normalized = new Date(`${parsed.replace(" ", "T")}Z`);
  if (Number.isNaN(normalized.getTime()) || normalized.toISOString().slice(0, 19).replace("T", " ") !== parsed) {
    throw new Error(`${field}不是有效时间`);
  }
  return parsed;
}

function isoTime(value: string): string {
  return new Date(`${value.replace(" ", "T")}+08:00`).toISOString();
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field}必须是 ${minimum}～${maximum} 的整数`);
  }
  return value as number;
}

interface InternalSpec {
  guide: string;
  mode: ActionMode;
  private?: boolean;
  prepare: (args: Record<string, unknown>) => Pick<PreparedAction, "summary" | "command">;
}

const INTERNAL_ACTIONS: Record<string, InternalSpec> = {
  "reminder.create": {
    guide: "创建可主动唤醒 Agent 的提醒；参数：instruction、run_at，选填 repeat_minutes",
    mode: "write",
    prepare(args) {
      const instruction = text(args.instruction, "提醒内容", 8_000, true)!;
      const runAt = time(args.run_at, "提醒时间");
      const repeatMinutes = args.repeat_minutes === undefined ? undefined : integer(args.repeat_minutes, "重复间隔", 1, 525_600);
      return {
        summary: `动作：创建提醒\n时间：${runAt}${repeatMinutes ? `\n每 ${repeatMinutes} 分钟重复` : ""}\n内容：${instruction}`,
        command: ["internal", "reminder", "create", "--json", JSON.stringify({ instruction, run_at: isoTime(runAt), ...(repeatMinutes ? { repeat_minutes: repeatMinutes } : {}) })],
      };
    },
  },
  "reminder.list": {
    guide: "查看当前 Agent 的提醒；只在 Owner 私聊执行",
    mode: "read",
    private: true,
    prepare: () => ({ summary: "动作：查看提醒", command: ["internal", "reminder", "list", "--json", "{}"] }),
  },
  "reminder.update": {
    guide: "更新提醒；参数：reminder_id，选填 instruction、run_at、repeat_minutes",
    mode: "write",
    prepare(args) {
      const reminderId = text(args.reminder_id, "提醒 ID", 32, true)!;
      const instruction = args.instruction === undefined ? undefined : text(args.instruction, "提醒内容", 8_000, true);
      const runAt = args.run_at === undefined ? undefined : time(args.run_at, "提醒时间");
      const repeatMinutes = args.repeat_minutes === undefined ? undefined
        : args.repeat_minutes === null || args.repeat_minutes === 0 ? null
          : integer(args.repeat_minutes, "重复间隔", 1, 525_600);
      if (instruction === undefined && runAt === undefined && repeatMinutes === undefined) throw new Error("至少要提供一项提醒修改内容");
      return {
        summary: `动作：更新提醒\n提醒 ID：${reminderId}`,
        command: ["internal", "reminder", "update", "--json", JSON.stringify({
          reminder_id: reminderId,
          ...(instruction ? { instruction } : {}),
          ...(runAt ? { run_at: isoTime(runAt) } : {}),
          ...(repeatMinutes !== undefined ? { repeat_minutes: repeatMinutes } : {}),
        })],
      };
    },
  },
  "reminder.cancel": {
    guide: "取消提醒；参数：reminder_id",
    mode: "write",
    prepare(args) {
      const reminderId = text(args.reminder_id, "提醒 ID", 32, true)!;
      return { summary: `动作：取消提醒\n提醒 ID：${reminderId}`, command: ["internal", "reminder", "cancel", "--json", JSON.stringify({ reminder_id: reminderId })] };
    },
  },
  "work.create": {
    guide: "把协作任务交给另一个 Agent；参数：title、description、assignee_agent，选填 reviewer_agent",
    mode: "write",
    private: true,
    prepare(args) {
      const title = text(args.title, "任务标题", 1_000, true)!;
      const description = text(args.description, "任务说明", 8_000, true)!;
      const assignedAgent = text(args.assignee_agent, "执行 Agent", 128, true)!;
      const reviewerAgent = text(args.reviewer_agent, "复核 Agent", 128);
      return {
        summary: `动作：创建协作任务\n标题：${title}\n执行 Agent：${assignedAgent}${reviewerAgent ? `\n复核 Agent：${reviewerAgent}` : ""}`,
        command: ["internal", "work", "create", "--json", JSON.stringify({ title, description, assigned_agent: assignedAgent, ...(reviewerAgent ? { reviewer_agent: reviewerAgent } : {}) })],
      };
    },
  },
  "work.list": {
    guide: "查看与当前 Agent 相关的协作任务；只在 Owner 私聊执行",
    mode: "read",
    private: true,
    prepare: () => ({ summary: "动作：查看协作任务", command: ["internal", "work", "list", "--json", "{}"] }),
  },
  "work.get": {
    guide: "读取协作任务详情；参数：work_id；只在 Owner 私聊执行",
    mode: "read",
    private: true,
    prepare(args) {
      const workId = text(args.work_id, "任务 ID", 32, true)!;
      return { summary: `动作：读取协作任务\n任务 ID：${workId}`, command: ["internal", "work", "get", "--json", JSON.stringify({ work_id: workId })] };
    },
  },
  "work.handoff": {
    guide: "把协作任务转交给另一个 Agent；参数：work_id、assignee_agent；只在 Owner 私聊执行",
    mode: "write",
    private: true,
    prepare(args) {
      const workId = text(args.work_id, "任务 ID", 32, true)!;
      const assignedAgent = text(args.assignee_agent, "执行 Agent", 128, true)!;
      return {
        summary: `动作：转交协作任务\n任务 ID：${workId}\n执行 Agent：${assignedAgent}`,
        command: ["internal", "work", "handoff", "--json", JSON.stringify({ work_id: workId, assigned_agent: assignedAgent })],
      };
    },
  },
};

function hasUnsafePayload(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const unsafe = hasUnsafePayload(item);
      if (unsafe) return unsafe;
    }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (LOCAL_PATH_FIELDS.has(key) && typeof nested === "string" && nested) return "本地文件路径";
    if (CREDENTIAL_FIELDS.has(key)) return "凭据字段";
    const unsafe = hasUnsafePayload(nested);
    if (unsafe) return unsafe;
  }
  return undefined;
}

function destructivePayload(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(destructivePayload);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([key, nested]) =>
    key.startsWith("delete_") || key === "delete" || key === "clear"
      || key === "type" && nested === "delete"
      || destructivePayload(nested));
}

function commandPath(command: unknown): { command: string[]; path: string[]; request?: Record<string, unknown> } {
  if (!Array.isArray(command) || command.some((part) => typeof part !== "string")) throw new Error("command 必须是文本数组");
  const values = command as string[];
  if (values.length < 2 || Buffer.byteLength(JSON.stringify(values)) > MAX_COMMAND_BYTES) throw new Error("wecom-cli 命令为空或过长");

  const inspection = ["--doc", "--help", "--schema"].includes(values.at(-1) ?? "");
  const jsonIndex = values.length - 2;
  if (!inspection && (values[jsonIndex] !== "--json" || values.length < 4)) {
    throw new Error("业务命令只接受 <service> [resource ...] <method> --json '<JSON>'");
  }
  const path = values.slice(0, inspection ? -1 : jsonIndex);
  if (path.length === 0 || path.length > 5 || path.some((part) => !COMMAND_TOKEN.test(part))) throw new Error("wecom-cli 命令路径无效");
  if (inspection) return { command: values, path };

  let request: unknown;
  try {
    request = JSON.parse(values.at(-1)!);
  } catch {
    throw new Error("--json 后必须是有效 JSON");
  }
  if (!request || typeof request !== "object" || Array.isArray(request)) throw new Error("--json 请求体必须是对象");
  return { command: values, path, request: request as Record<string, unknown> };
}

function prepareWecomAction(action: ProposedAction): PreparedAction {
  const { command, path, request } = commandPath(action.arguments.command);
  if (!WECOM_SERVICES.has(path[0] ?? "")) throw new Error(`不允许通过 Broker 调用服务：${path[0]}`);
  if (action.skill !== "wecom-unified") throw new Error("该命令必须由 wecom-unified Skill 提议");
  const summary = text(action.arguments.summary, "动作摘要", 2_000, true)!;
  const method = path.at(-1)!;
  const inspection = request === undefined;
  let mode: ActionMode;
  if (inspection || READ_METHODS.has(method)) mode = "read";
  else if (DESTRUCTIVE_METHODS.has(method) || path[0] === "mail" && method === "send" || path[0] === "message" && method === "send" || destructivePayload(request)) mode = "destructive";
  else if (WRITE_METHODS.has(method)) mode = "write";
  else throw new Error(`未识别的 wecom-cli 操作类型：${method}`);
  const unsafe = request && hasUnsafePayload(request);
  if (unsafe) throw new Error(`Broker 不接受 Agent 提供的${unsafe}`);
  const identity = createHash("sha256").update(JSON.stringify(command)).digest("hex").slice(0, 16);
  return {
    name: path.join("."),
    summary,
    command,
    mode,
    ...(PRIVATE_SERVICES.has(path[0]!) ? { private: true } : {}),
    resource: `${path.join(".")}:${identity}`,
  };
}

export function actionCatalog(): string {
  return [
    "- wecom-cli [Skill: 官方 wecom-unified]：执行一个受控企业微信 CLI 命令；参数：command（完整参数数组）、summary（给用户看的具体操作摘要）",
    ...Object.entries(INTERNAL_ACTIONS).map(([name, spec]) => `- ${name} [Skill: threadferry]：${spec.guide}`),
  ].join("\n");
}

export function isKnownAction(name: string): boolean {
  return name === WECOM_ACTION || Object.hasOwn(INTERNAL_ACTIONS, name);
}

/** 围栏整块永远从用户回复中移除；无效 JSON 或未知动作按没有提议处理。 */
export function extractAction(reply: string): { reply: string; action?: ProposedAction } {
  const match = reply.matchAll(FENCE).next().value;
  if (!match) return { reply };
  const cleaned = reply.replace(FENCE, "").replace(/\n{3,}/g, "\n\n").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!.trim());
  } catch {
    return { reply: cleaned };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { reply: cleaned };
  const body = parsed as Record<string, unknown>;
  const name = typeof body.action === "string" ? body.action.trim() : "";
  if (!isKnownAction(name)) return { reply: cleaned };
  const skill = typeof body.skill === "string" ? body.skill.trim() : "";
  const { action: _action, skill: _skill, user_intent: _intent, ...arguments_ } = body;
  return {
    reply: cleaned,
    action: {
      name,
      arguments: arguments_,
      ...(skill ? { skill } : {}),
      userIntent: body.user_intent === "explicit" ? "explicit" : "confirm",
    },
  };
}

export async function prepareAction(action: ProposedAction): Promise<PreparedAction> {
  if (action.name === WECOM_ACTION) return prepareWecomAction(action);
  const spec = INTERNAL_ACTIONS[action.name];
  if (!spec) throw new Error(`不支持的动作：${action.name}`);
  if (action.skill !== "threadferry") throw new Error("ThreadFerry 内部动作必须由 threadferry Skill 提议");
  const prepared = spec.prepare(action.arguments);
  const identity = createHash("sha256").update(JSON.stringify(prepared.command)).digest("hex").slice(0, 16);
  return {
    name: action.name,
    ...prepared,
    mode: spec.mode,
    ...(spec.private ? { private: true } : {}),
    resource: `${action.name}:${identity}`,
  };
}
