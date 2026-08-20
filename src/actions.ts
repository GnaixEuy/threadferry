import type { DirectoryUser } from "./types.js";

/**
 * 白名单动作。
 *
 * ThreadFerry 的 Runtime 是**只读**的：沙箱不给网络、不给 shell、不继承环境变量，提示词也明确
 * 禁止写操作。要让「@机器人 帮我建个日程」能真的落地，走的不是"给 Runtime 开权限"，而是：
 *
 *   Runtime 只**提议**一个结构化动作 → ThreadFerry 校验它在白名单里 → Owner 确认 → ThreadFerry
 *   自己调 wecom-cli 执行。
 *
 * 这样群历史仍然是不可信输入（提示词注入最多让它提议一个动作，而动作必须在白名单里、参数必须
 * 过校验、还要 Owner 亲自确认），Runtime 的沙箱一点不用松。
 */

export interface ProposedAction {
  name: string;
  arguments: Record<string, unknown>;
}

export interface PreparedAction {
  /** 给人看的确认摘要。 */
  summary: string;
  /** 真正要执行的 wecom-cli 参数。 */
  command: string[];
}

export type UserResolver = (reference: string) => Promise<DirectoryUser>;

// Runtime 用这个围栏提议动作；ThreadFerry 会把整块从回复里摘掉，群里不会看到原始 JSON。
const FENCE = /```threadferry-action[^\n]*\n([\s\S]*?)```/;
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const MAX_ATTENDEES = 50;

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
  if (Number.isNaN(new Date(parsed.replace(" ", "T")).getTime())) throw new Error(`${field}不是有效时间`);
  return parsed;
}

async function attendeeIds(value: unknown, resolve: UserResolver | undefined): Promise<Array<{ userid: string }>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("参与人必须是列表");
  if (value.length > MAX_ATTENDEES) throw new Error(`参与人最多 ${MAX_ATTENDEES} 人`);
  if (!resolve) throw new Error("当前启动方式不支持解析参与人");
  const ids: Array<{ userid: string }> = [];
  for (const entry of value) {
    const reference = text(entry, "参与人", 512, true)!;
    const user = await resolve(reference);
    if (!ids.some((known) => known.userid === user.id)) ids.push({ userid: user.id });
  }
  return ids;
}

interface ActionSpec {
  label: string;
  prepare: (args: Record<string, unknown>, resolve?: UserResolver) => Promise<PreparedAction>;
}

const ACTIONS: Record<string, ActionSpec> = {
  "schedule.create": {
    label: "创建日程",
    async prepare(args, resolve) {
      const subject = text(args.subject, "日程标题", 128, true)!;
      const beginTime = time(args.begin_time, "开始时间");
      const endTime = time(args.end_time, "结束时间");
      if (endTime <= beginTime) throw new Error("结束时间必须晚于开始时间");
      const description = text(args.description, "备注", 1024);
      const location = text(args.location, "地点", 256);
      const attendees = await attendeeIds(args.attendees, resolve);
      const request = {
        subject,
        begin_time: beginTime,
        end_time: endTime,
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        ...(attendees.length > 0 ? { attendees } : {}),
      };
      return {
        summary: [
          `动作：创建日程`,
          `标题：${subject}`,
          `时间：${beginTime} → ${endTime}`,
          ...(location ? [`地点：${location}`] : []),
          ...(description ? [`备注：${description}`] : []),
          ...(attendees.length > 0 ? [`参与人：${attendees.map((one) => one.userid).join("、")}`] : []),
        ].join("\n"),
        command: ["calendar", "schedules", "create", "--json", JSON.stringify(request)],
      };
    },
  },
};

/** 提示词里列给 Runtime 看的动作清单。只列白名单里真实存在的。 */
export function actionCatalog(): string {
  return Object.entries(ACTIONS).map(([name, spec]) => `- ${name}：${spec.label}`).join("\n");
}

export function isKnownAction(name: string): boolean {
  return Object.hasOwn(ACTIONS, name);
}

/**
 * 从 Runtime 的回复里摘出动作提议。围栏整块都会被移除——群里只看到自然语言，看不到原始 JSON。
 * 解析失败按「没有提议」处理：宁可不执行，也不能猜用户想干什么。
 */
export function extractAction(reply: string): { reply: string; action?: ProposedAction } {
  const match = FENCE.exec(reply);
  if (!match) return { reply };
  const cleaned = reply.replace(match[0], "").replace(/\n{3,}/g, "\n\n").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]!.trim());
  } catch {
    return { reply: cleaned };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { reply: cleaned };
  const body = parsed as Record<string, unknown>;
  const name = typeof body.action === "string" ? body.action.trim() : "";
  if (!name || !isKnownAction(name)) return { reply: cleaned };
  const { action: _ignored, ...rest } = body;
  return { reply: cleaned, action: { name, arguments: rest } };
}

/** 校验并组装成可执行命令。任何一步不过关都抛错，错误会原样告诉用户。 */
export async function prepareAction(action: ProposedAction, resolve?: UserResolver): Promise<PreparedAction> {
  const spec = ACTIONS[action.name];
  if (!spec) throw new Error(`不支持的动作：${action.name}`);
  return spec.prepare(action.arguments, resolve);
}
