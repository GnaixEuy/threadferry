import type { DirectoryUser } from "./types.js";

/**
 * 白名单动作。
 *
 * ThreadFerry 的 Runtime 是**只读**的：沙箱不给网络、不给 shell、不继承环境变量，提示词也明确
 * 禁止写操作。要让「@机器人 帮我建个日程」能真的落地，走的不是"给 Runtime 开权限"，而是：
 *
 *   Runtime 只**提议**一个结构化动作 → ThreadFerry 校验它在白名单里 → Owner 请求直接执行，
 *   其他人的请求等 Owner 确认 → ThreadFerry 自己调 wecom-cli 执行。
 *
 * 这样群历史仍然是不可信输入：提示词注入最多让 Runtime 提议动作；只有 Owner 当前指令里明确
 * 要求了对应操作才自动执行，否则仍要 Owner 确认。Runtime 的沙箱一点不用松。
 */

export interface ProposedAction {
  name: string;
  arguments: Record<string, unknown>;
}

export interface PreparedAction {
  /** 给人看的动作摘要。 */
  summary: string;
  /** 真正要执行的 wecom-cli 参数。 */
  command: string[];
  mode: "read" | "write" | "destructive";
  private?: boolean;
  formatResult?: (result: Record<string, unknown>) => string | undefined;
}

export type UserResolver = (reference: string) => Promise<DirectoryUser>;

// Runtime 用这个围栏提议动作；ThreadFerry 会把整块从回复里摘掉，群里不会看到原始 JSON。
const FENCE = /```threadferry-action[^\n]*\n([\s\S]*?)```/;
const TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const CREATE_CONFIRMATION = /(?:^|\s)(?:创建(?:\s*没问题)?|确认创建|可以创建|没问题[，,\s]*创建)(?:[。.!！\s]|$)/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ATTENDEES = 50;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function byteText(value: unknown, field: string, maxBytes: number, required = false): string | undefined {
  const parsed = text(value, field, maxBytes, required);
  if (parsed && Buffer.byteLength(parsed) > maxBytes) throw new Error(`${field}过长（最多 ${maxBytes} 字节）`);
  return parsed;
}

function unixTime(value: string): string {
  return String(Date.parse(`${value.replace(" ", "T")}+08:00`) / 1000);
}

function optionalTime(value: unknown, field: string): string | undefined {
  return value === undefined || value === null || value === "" ? undefined : time(value, field);
}

function patchText(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error(`${field}必须是文本`);
  const trimmed = value.trim();
  if (trimmed.length > max) throw new Error(`${field}过长（最多 ${max} 个字符）`);
  return trimmed;
}

function integer(value: unknown, field: string, fallback: number, minimum: number, maximum: number): number {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${field}必须是 ${minimum}～${maximum} 的整数`);
  }
  return value as number;
}

function texts(value: unknown, field: string, maximum = 10, required = false): string[] {
  const values = typeof value === "string" ? [value] : value;
  if (values === undefined || values === null) {
    if (required) throw new Error(`${field}不能为空`);
    return [];
  }
  if (!Array.isArray(values) || values.length > maximum) throw new Error(`${field}必须是最多 ${maximum} 项的文本列表`);
  const parsed = values.map((entry) => text(entry, field, 200, true)!);
  if (required && parsed.length === 0) throw new Error(`${field}不能为空`);
  return [...new Set(parsed)];
}

function deadline(value: unknown): { type: "date" | "datetime"; value: string } | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = text(value, "截止时间", 32, true)!;
  if (DATE.test(parsed)) {
    time(`${parsed} 00:00:00`, "截止时间");
    return { type: "date", value: parsed };
  }
  return { type: "datetime", value: time(parsed, "截止时间") };
}

function records(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function field(item: Record<string, unknown>, name: string): string | undefined {
  const value = item[name];
  return typeof value === "string" && value ? value : undefined;
}

function meetingCode(value: string): string {
  return value.replace(/\D/g, "").replace(/(.{3})(?=.)/g, "$1-");
}

function formatMeetingCreate(result: Record<string, unknown>): string | undefined {
  const code = field(result, "meeting_code");
  const link = field(result, "meeting_link");
  const lines = [code ? `会议号：${meetingCode(code)}` : undefined, link ? `入会链接：${link}` : undefined].filter(Boolean);
  return lines.length ? lines.join("\n") : undefined;
}

function formatMeetings(result: Record<string, unknown>): string {
  const meetings = records(result.meetings);
  if (!meetings.length) return "没有找到匹配的会议。";
  return meetings.map((item, index) => [
    `${index + 1}. ${field(item, "subject") ?? "未命名会议"}`,
    `   时间：${field(item, "begin_time") ?? "未知"} → ${field(item, "end_time") ?? "未知"}`,
    typeof item.attendee_count === "number" ? `   参与人数：${item.attendee_count}` : undefined,
    field(item, "location") ? `   地点：${field(item, "location")}` : undefined,
    field(item, "meeting_id") ? `   会议 ID：${field(item, "meeting_id")}` : undefined,
  ].filter(Boolean).join("\n")).join("\n\n") + "\n\n修改或取消时请带上会议 ID。";
}

function formatSchedules(result: Record<string, unknown>): string {
  const schedules = records(result.schedules);
  if (!schedules.length) return "没有找到匹配的日程。";
  return schedules.map((item, index) => [
    `${index + 1}. ${field(item, "subject") ?? "未命名日程"}`,
    `   时间：${field(item, "begin_time") ?? "未知"} → ${field(item, "end_time") ?? "未知"}`,
    field(item, "location") ? `   地点：${field(item, "location")}` : undefined,
    field(item, "schedule_id") ? `   日程 ID：${field(item, "schedule_id")}` : undefined,
  ].filter(Boolean).join("\n")).join("\n\n") + "\n\n修改或取消时请带上日程 ID。";
}

function formatFreeSlots(result: Record<string, unknown>): string {
  const slots = records(result.slots);
  if (!slots.length) return field(result, "extra_info") ?? "没有找到符合条件的共同空闲时间。";
  return slots.map((item, index) => `${index + 1}. ${field(item, "begin_time") ?? "未知"} → ${field(item, "end_time") ?? "未知"}`
    + (typeof item.available_count === "number" ? `（${item.available_count} 人空闲）` : "")).join("\n");
}

function formatTodos(result: Record<string, unknown>): string {
  const items = records(result.items);
  if (!items.length) return "没有找到符合条件的待办。";
  return items.map((item, index) => {
    const due = item.deadline && typeof item.deadline === "object" && !Array.isArray(item.deadline)
      ? field(item.deadline as Record<string, unknown>, "value") : undefined;
    return [
      `${index + 1}. ${field(item, "title") ?? "未命名待办"}${field(item, "status") === "finished" ? "（已完成）" : ""}`,
      due ? `   截止：${due}` : undefined,
      field(item, "todo_id") ? `   待办 ID：${field(item, "todo_id")}` : undefined,
    ].filter(Boolean).join("\n");
  }).join("\n\n") + "\n\n完成或删除时请带上待办 ID。";
}

function formatTodoMutation(result: Record<string, unknown>): string | undefined {
  const items = records(result.items);
  if (!items.length) return undefined;
  return items.map((item) => `${item.success === false ? "失败" : "成功"}：${field(item, "title") ?? "待办"}`
    + (field(item, "extra_info") ? `（${field(item, "extra_info")}）` : "")
    + (field(item, "errmsg") ? `：${field(item, "errmsg")}` : "")).join("\n");
}

function formatMails(result: Record<string, unknown>): string {
  const mails = records(result.mails);
  if (!mails.length) return "没有找到匹配的邮件。";
  return mails.map((item, index) => {
    const sender = item.sender && typeof item.sender === "object" && !Array.isArray(item.sender)
      ? item.sender as Record<string, unknown> : undefined;
    return [
      `${index + 1}. ${field(item, "subject") ?? "无主题邮件"}${item.is_read === false ? "（未读）" : ""}`,
      sender ? `   发件人：${field(sender, "name") ?? field(sender, "email") ?? "未知"}` : undefined,
      field(item, "send_time") ? `   时间：${field(item, "send_time")}` : undefined,
      field(item, "mail_id") ? `   邮件 ID：${field(item, "mail_id")}` : undefined,
    ].filter(Boolean).join("\n");
  }).join("\n\n");
}

function formatMailSend(result: Record<string, unknown>): string | undefined {
  const mailId = field(result, "mail_id");
  return mailId ? `邮件 ID：${mailId}` : undefined;
}

function formatDocs(result: Record<string, unknown>): string {
  const docs = records(result.docs);
  if (!docs.length) return "没有找到匹配的文档。";
  return docs.map((item, index) => [
    `${index + 1}. ${field(item, "doc_name") ?? "未命名文档"}${field(item, "doc_type") ? `（${field(item, "doc_type")}）` : ""}`,
    field(item, "creator_name") ? `   创建者：${field(item, "creator_name")}` : undefined,
    field(item, "modify_time") ? `   更新：${field(item, "modify_time")}` : undefined,
    field(item, "url") ? `   链接：${field(item, "url")}` : undefined,
  ].filter(Boolean).join("\n")).join("\n\n");
}

function formatDocCreate(result: Record<string, unknown>): string | undefined {
  const url = field(result, "url");
  return url ? `文档链接：${url}` : undefined;
}

function formatDiskFiles(result: Record<string, unknown>): string {
  const files = records(result.files);
  if (!files.length) return "没有找到匹配的微盘文件。";
  return files.map((item, index) => [
    `${index + 1}. ${field(item, "file_name") ?? "未命名文件"}${field(item, "type") ? `（${field(item, "type")}）` : ""}`,
    field(item, "path") ? `   路径：${field(item, "path")}` : undefined,
    field(item, "space_name") ? `   空间：${field(item, "space_name")}` : undefined,
    field(item, "doc_url") ? `   链接：${field(item, "doc_url")}` : undefined,
    field(item, "id") ? `   文件 ID：${field(item, "id")}` : undefined,
  ].filter(Boolean).join("\n")).join("\n\n");
}

async function attendeeIds(value: unknown, resolve: UserResolver | undefined): Promise<Array<{ userid: string; name: string }>> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("参与人必须是列表");
  if (value.length > MAX_ATTENDEES) throw new Error(`参与人最多 ${MAX_ATTENDEES} 人`);
  if (value.length === 0) return [];
  if (!resolve) throw new Error("当前启动方式不支持解析参与人");
  const ids: Array<{ userid: string; name: string }> = [];
  for (const entry of value) {
    const reference = text(entry, "参与人", 512, true)!;
    const user = await resolve(reference);
    if (!ids.some((known) => known.userid === user.id)) ids.push({ userid: user.id, name: user.name });
  }
  return ids;
}

async function recipients(value: unknown, fieldName: string, resolve: UserResolver | undefined, required = false): Promise<{
  value: { emails?: string[]; userids?: string[] };
  labels: string[];
}> {
  const references = texts(value, fieldName, 50, required);
  const emails = references.filter((reference) => EMAIL.test(reference));
  const users = await attendeeIds(references.filter((reference) => !EMAIL.test(reference)), resolve);
  return {
    value: { ...(emails.length ? { emails } : {}), ...(users.length ? { userids: users.map(({ userid }) => userid) } : {}) },
    labels: [...emails, ...users.map(({ name }) => name)],
  };
}

interface ActionSpec {
  guide: string;
  mode: PreparedAction["mode"];
  private?: boolean;
  explicitRequest?: RegExp;
  formatResult?: PreparedAction["formatResult"];
  prepare: (args: Record<string, unknown>, resolve?: UserResolver) => Promise<Pick<PreparedAction, "summary" | "command">>;
}

const ACTIONS: Record<string, ActionSpec> = {
  "schedule.create": {
    guide: "创建普通日历日程；参数：subject、begin_time、end_time，选填 description、location、attendees（参与人姓名数组）",
    mode: "write",
    explicitRequest: /(?:(?:创建|新建|建|添加|安排).{0,20}(?:日程|行程)|(?:日程|行程).{0,20}(?:创建|新建|建|添加|安排)|(?:create|schedule|book|set up).{0,40}(?:calendar event|schedule))/i,
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
        ...(attendees.length > 0 ? { attendees: attendees.map(({ userid }) => ({ userid })) } : {}),
      };
      return {
        summary: [
          `动作：创建日程`,
          `标题：${subject}`,
          `时间：${beginTime} → ${endTime}`,
          ...(location ? [`地点：${location}`] : []),
          ...(description ? [`备注：${description}`] : []),
          ...(attendees.length > 0 ? [`参与人：${attendees.map((one) => one.name).join("、")}`] : []),
        ].join("\n"),
        command: ["calendar", "schedules", "create", "--json", JSON.stringify(request)],
      };
    },
  },
  "schedule.search": {
    guide: "搜索日程；参数：keywords（关键词数组），选填 begin_time、end_time；只在 Owner 私聊执行",
    mode: "read",
    formatResult: formatSchedules,
    async prepare(args) {
      const keywords = texts(args.keywords, "搜索关键词", 10, true);
      const beginTime = optionalTime(args.begin_time, "开始时间");
      const endTime = optionalTime(args.end_time, "结束时间");
      if (beginTime && endTime && endTime <= beginTime) throw new Error("结束时间必须晚于开始时间");
      const request = { keywords, ...(beginTime ? { begin_time: beginTime } : {}), ...(endTime ? { end_time: endTime } : {}), limit: 10 };
      return { summary: `动作：搜索日程\n关键词：${keywords.join("、")}`, command: ["calendar", "schedules", "search", "--json", JSON.stringify(request)] };
    },
  },
  "schedule.free": {
    guide: "查询参与人的共同空闲时间；参数：attendees、begin_time、end_time，选填 min_duration_minutes；只在 Owner 私聊执行",
    mode: "read",
    formatResult: formatFreeSlots,
    async prepare(args, resolve) {
      const attendees = await attendeeIds(args.attendees, resolve);
      if (!attendees.length) throw new Error("参与人不能为空");
      const beginTime = time(args.begin_time, "开始时间");
      const endTime = time(args.end_time, "结束时间");
      if (endTime <= beginTime) throw new Error("结束时间必须晚于开始时间");
      const duration = integer(args.min_duration_minutes, "最短时长", 30, 1, 1440);
      const request = { userids: attendees.map(({ userid }) => ({ userid })), begin_time: beginTime, end_time: endTime, min_duration_minutes: duration, limit: 10 };
      return {
        summary: `动作：查询共同空闲时间\n参与人：${attendees.map(({ name }) => name).join("、")}\n范围：${beginTime} → ${endTime}\n最短时长：${duration} 分钟`,
        command: ["calendar", "schedules", "free", "list", "--json", JSON.stringify(request)],
      };
    },
  },
  "schedule.update": {
    guide: "更新日程；参数：schedule_id，及 subject、begin_time、end_time、description、location、add_attendees、remove_attendees 中至少一项",
    mode: "write",
    explicitRequest: /(?:(?:修改|更新|调整|改).{0,20}(?:日程|行程)|(?:日程|行程).{0,20}(?:修改|更新|调整|改))/i,
    async prepare(args, resolve) {
      const scheduleId = text(args.schedule_id, "日程 ID", 512, true)!;
      const subject = args.subject === undefined ? undefined : text(args.subject, "日程标题", 128, true);
      const beginTime = optionalTime(args.begin_time, "开始时间");
      const endTime = optionalTime(args.end_time, "结束时间");
      if (beginTime && endTime && endTime <= beginTime) throw new Error("结束时间必须晚于开始时间");
      const description = patchText(args.description, "备注", 1024);
      const location = patchText(args.location, "地点", 256);
      const added = await attendeeIds(args.add_attendees, resolve);
      const removed = await attendeeIds(args.remove_attendees, resolve);
      const request = {
        schedule_id: scheduleId,
        ...(subject ? { subject } : {}), ...(beginTime ? { begin_time: beginTime } : {}), ...(endTime ? { end_time: endTime } : {}),
        ...(description !== undefined ? { description } : {}), ...(location !== undefined ? { location } : {}),
        ...(added.length ? { add_attendees: added.map(({ userid }) => ({ userid })) } : {}),
        ...(removed.length ? { remove_attendees: removed.map(({ userid }) => ({ userid })) } : {}),
      };
      if (Object.keys(request).length === 1) throw new Error("至少要提供一项日程修改内容");
      return { summary: `动作：更新日程\n日程 ID：${scheduleId}`, command: ["calendar", "schedules", "update", "--json", JSON.stringify(request)] };
    },
  },
  "schedule.cancel": {
    guide: "取消日程；参数：schedule_id；取消前始终要求 Owner 再确认",
    mode: "destructive",
    async prepare(args) {
      const scheduleId = text(args.schedule_id, "日程 ID", 512, true)!;
      return { summary: `动作：取消日程\n日程 ID：${scheduleId}`, command: ["calendar", "schedules", "cancel", "--json", JSON.stringify({ schedule_id: scheduleId })] };
    },
  },
  "meeting.create": {
    guide: "创建企业微信会议（用户说会议时使用）；参数：subject、begin_time、end_time，选填 description、location、attendees（参与人姓名数组；用户说了邀请谁就必须完整带上）",
    mode: "write",
    explicitRequest: /(?:(?:创建|新建|建|发起|安排|预约|约).{0,20}(?:会议|开会|个会)|(?:会议|开会).{0,20}(?:创建|新建|建|发起|安排|预约)|(?:create|schedule|book|set up).{0,40}meeting)/i,
    formatResult: formatMeetingCreate,
    async prepare(args, resolve) {
      const subject = byteText(args.subject, "会议标题", 255, true)!;
      const beginTime = time(args.begin_time, "开始时间");
      const endTime = time(args.end_time, "结束时间");
      if (endTime <= beginTime) throw new Error("结束时间必须晚于开始时间");
      const description = byteText(args.description, "备注", 500);
      const location = byteText(args.location, "地点", 128);
      const attendees = await attendeeIds(args.attendees, resolve);
      const request = {
        subject,
        begin_time: unixTime(beginTime),
        end_time: unixTime(endTime),
        ...(description ? { description } : {}),
        ...(location ? { location } : {}),
        ...(attendees.length > 0 ? { attendees: attendees.map(({ userid }) => ({ userid })) } : {}),
      };
      return {
        summary: [
          "动作：创建会议",
          `标题：${subject}`,
          `时间：${beginTime} → ${endTime}`,
          ...(location ? [`地点：${location}`] : []),
          ...(description ? [`备注：${description}`] : []),
          ...(attendees.length > 0 ? [`参与人：${attendees.map((one) => one.name).join("、")}（创建时主动邀请）`] : []),
        ].join("\n"),
        command: ["meeting", "create", "--json", JSON.stringify(request)],
      };
    },
  },
  "meeting.search": {
    guide: "搜索会议；参数：keywords（关键词数组），选填 begin_time、end_time；只在 Owner 私聊执行",
    mode: "read",
    formatResult: formatMeetings,
    async prepare(args) {
      const keywords = texts(args.keywords, "搜索关键词", 10, true);
      const beginTime = optionalTime(args.begin_time, "开始时间");
      const endTime = optionalTime(args.end_time, "结束时间");
      if (beginTime && endTime && endTime <= beginTime) throw new Error("结束时间必须晚于开始时间");
      const request = { keywords, ...(beginTime ? { begin_time: beginTime } : {}), ...(endTime ? { end_time: endTime } : {}), limit: 10 };
      return { summary: `动作：搜索会议\n关键词：${keywords.join("、")}`, command: ["meeting", "search", "--json", JSON.stringify(request)] };
    },
  },
  "meeting.update": {
    guide: "更新会议；参数：meeting_id，及 subject、begin_time、end_time、description、location、add_attendees、remove_attendees 中至少一项",
    mode: "write",
    explicitRequest: /(?:(?:修改|更新|调整|改).{0,20}(?:会议|开会)|(?:会议|开会).{0,20}(?:修改|更新|调整|改))/i,
    async prepare(args, resolve) {
      const meetingId = text(args.meeting_id, "会议 ID", 512, true)!;
      const subject = args.subject === undefined ? undefined : text(args.subject, "会议标题", 128, true);
      const beginTime = optionalTime(args.begin_time, "开始时间");
      const endTime = optionalTime(args.end_time, "结束时间");
      if (beginTime && endTime && endTime <= beginTime) throw new Error("结束时间必须晚于开始时间");
      const description = patchText(args.description, "备注", 5000);
      const location = patchText(args.location, "地点", 256);
      const added = await attendeeIds(args.add_attendees, resolve);
      const removed = await attendeeIds(args.remove_attendees, resolve);
      const request = {
        meeting_id: meetingId,
        ...(subject ? { subject } : {}), ...(beginTime ? { begin_time: beginTime } : {}), ...(endTime ? { end_time: endTime } : {}),
        ...(description !== undefined ? { description } : {}), ...(location !== undefined ? { location } : {}),
        ...(added.length ? { add_attendees: added.map(({ userid }) => ({ userid })) } : {}),
        ...(removed.length ? { remove_attendees: removed.map(({ userid }) => ({ userid })) } : {}),
      };
      if (Object.keys(request).length === 1) throw new Error("至少要提供一项会议修改内容");
      return { summary: `动作：更新会议\n会议 ID：${meetingId}`, command: ["meeting", "update", "--json", JSON.stringify(request)] };
    },
  },
  "meeting.cancel": {
    guide: "取消会议；参数：meeting_id；取消前始终要求 Owner 再确认",
    mode: "destructive",
    async prepare(args) {
      const meetingId = text(args.meeting_id, "会议 ID", 512, true)!;
      return { summary: `动作：取消会议\n会议 ID：${meetingId}`, command: ["meeting", "cancel", "--json", JSON.stringify({ meeting_id: meetingId })] };
    },
  },
  "todo.create": {
    guide: "创建待办；参数：title，选填 description、deadline（日期或时间）、attendees（参与人姓名数组）",
    mode: "write",
    explicitRequest: /(?:(?:创建|新建|建|添加|安排).{0,20}(?:待办|任务)|(?:待办|任务).{0,20}(?:创建|新建|建|添加|安排))/i,
    formatResult: formatTodoMutation,
    async prepare(args, resolve) {
      const title = text(args.title, "待办标题", 4000, true)!;
      const description = text(args.description, "待办描述", 4000);
      const due = deadline(args.deadline);
      const attendees = await attendeeIds(args.attendees, resolve);
      const item = {
        title,
        ...(description ? { description } : {}),
        ...(due ? { deadline: due } : {}),
        ...(attendees.length ? { follower_ids: attendees.map(({ userid }) => userid) } : {}),
      };
      return {
        summary: ["动作：创建待办", `标题：${title}`, due ? `截止：${due.value}` : undefined,
          attendees.length ? `参与人：${attendees.map(({ name }) => name).join("、")}` : undefined].filter(Boolean).join("\n"),
        command: ["todo", "create", "--json", JSON.stringify({ items: [item] })],
      };
    },
  },
  "todo.list": {
    guide: "查询待办；选填 keywords、status（proceed、finished 或 all）；只在 Owner 私聊执行",
    mode: "read",
    formatResult: formatTodos,
    async prepare(args) {
      const keywords = texts(args.keywords, "搜索关键词", 10);
      const status = args.status === undefined ? "proceed" : text(args.status, "状态", 16, true)!;
      if (!["proceed", "finished", "all"].includes(status)) throw new Error("状态只支持 proceed、finished 或 all");
      const statusFilter = status === "all" ? ["proceed", "finished"] : [status];
      const request = { ...(keywords.length ? { keywords } : {}), status_filter: statusFilter, limit: 10 };
      return { summary: `动作：查询待办\n状态：${status}`, command: ["todo", "list", "--json", JSON.stringify(request)] };
    },
  },
  "todo.update": {
    guide: "更新待办；参数：todo_id，及 title、description、deadline 中至少一项",
    mode: "write",
    explicitRequest: /(?:(?:修改|更新|调整|改).{0,20}(?:待办|任务)|(?:待办|任务).{0,20}(?:修改|更新|调整|改))/i,
    formatResult: formatTodoMutation,
    async prepare(args) {
      const todoId = text(args.todo_id, "待办 ID", 512, true)!;
      const title = args.title === undefined ? undefined : text(args.title, "待办标题", 4000, true);
      const description = patchText(args.description, "待办描述", 4000);
      const due = args.deadline === undefined ? undefined : deadline(args.deadline);
      const item = {
        todo_id: todoId,
        ...(title ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(due ? { deadline: due } : {}),
      };
      if (Object.keys(item).length === 1) throw new Error("至少要提供一项待办修改内容");
      return {
        summary: ["动作：更新待办", `待办 ID：${todoId}`, title ? `标题：${title}` : undefined,
          due ? `截止：${due.value}` : undefined].filter(Boolean).join("\n"),
        command: ["todo", "update", "--json", JSON.stringify({ items: [item] })],
      };
    },
  },
  "todo.finish": {
    guide: "完成整个待办；参数：todo_id；执行前始终要求 Owner 再确认",
    mode: "destructive",
    formatResult: formatTodoMutation,
    async prepare(args) {
      const todoId = text(args.todo_id, "待办 ID", 512, true)!;
      return { summary: `动作：完成待办\n待办 ID：${todoId}`, command: ["todo", "finish", "--json", JSON.stringify({ items: [{ todo_id: todoId, finished_all: true }] })] };
    },
  },
  "todo.delete": {
    guide: "删除待办；参数：todo_id；删除前始终要求 Owner 再确认",
    mode: "destructive",
    formatResult: formatTodoMutation,
    async prepare(args) {
      const todoId = text(args.todo_id, "待办 ID", 512, true)!;
      return { summary: `动作：删除待办\n待办 ID：${todoId}`, command: ["todo", "delete", "--json", JSON.stringify({ items: [{ todo_id: todoId }] })] };
    },
  },
  "mail.search": {
    guide: "搜索邮件；参数：keywords，选填 sender、receiver、begin_time、end_time、only_unread；只在 Owner 私聊执行",
    mode: "read",
    private: true,
    formatResult: formatMails,
    async prepare(args) {
      const keywords = texts(args.keywords, "搜索关键词", 10);
      const sender = text(args.sender, "发件人", 256);
      const receiver = text(args.receiver, "收件人", 256);
      const beginTime = optionalTime(args.begin_time, "开始时间");
      const endTime = optionalTime(args.end_time, "结束时间");
      if (beginTime && endTime && endTime <= beginTime) throw new Error("结束时间必须晚于开始时间");
      if (args.only_unread !== undefined && typeof args.only_unread !== "boolean") throw new Error("only_unread 必须是布尔值");
      if (!keywords.length && !sender && !receiver && !beginTime && !endTime && args.only_unread !== true) {
        throw new Error("至少要提供关键词、发件人、收件人、时间范围或未读条件中的一项");
      }
      const request = {
        ...(keywords.length ? { keywords } : {}), ...(sender ? { sender } : {}), ...(receiver ? { receiver } : {}),
        ...(beginTime ? { begin_time: beginTime } : {}), ...(endTime ? { end_time: endTime } : {}),
        ...(args.only_unread === true ? { only_unread: true } : {}), limit: 10,
      };
      return { summary: "动作：搜索邮件", command: ["mail", "search", "--json", JSON.stringify(request)] };
    },
  },
  "mail.send": {
    guide: "发送纯文本或 Markdown 邮件；参数：to（姓名或邮箱数组）、subject、content，选填 cc、bcc；只在 Owner 私聊，发送前始终再确认",
    mode: "destructive",
    private: true,
    formatResult: formatMailSend,
    async prepare(args, resolve) {
      const to = await recipients(args.to, "收件人", resolve, true);
      const cc = await recipients(args.cc, "抄送人", resolve);
      const bcc = await recipients(args.bcc, "密送人", resolve);
      const subject = text(args.subject, "邮件主题", 255, true)!;
      const content = text(args.content, "邮件正文", 8_000, true)!;
      const request = {
        to: to.value,
        ...(cc.labels.length ? { cc: cc.value } : {}),
        ...(bcc.labels.length ? { bcc: bcc.value } : {}),
        subject,
        content,
        content_type: "markdown",
      };
      return {
        summary: [
          "动作：发送邮件",
          `收件人：${to.labels.join("、")}`,
          ...(cc.labels.length ? [`抄送：${cc.labels.join("、")}`] : []),
          ...(bcc.labels.length ? [`密送：${bcc.labels.join("、")}`] : []),
          `主题：${subject}`,
          `正文：\n${content}`,
        ].join("\n"),
        command: ["mail", "send", "--json", JSON.stringify(request)],
      };
    },
  },
  "doc.search": {
    guide: "搜索企业微信文档；参数：keywords，选填 doc_types；只在 Owner 私聊执行",
    mode: "read",
    private: true,
    formatResult: formatDocs,
    async prepare(args) {
      const keywords = texts(args.keywords, "搜索关键词", 20, true);
      const docTypes = texts(args.doc_types, "文档类型", 10);
      const allowed = ["doc", "sheet", "collect", "ppt", "mind", "flow", "smartsheet", "journal", "pdf", "smartpage"];
      if (docTypes.some((type) => !allowed.includes(type))) throw new Error(`文档类型只支持 ${allowed.join("、")}`);
      const request = { keywords, ...(docTypes.length ? { doc_types: docTypes } : {}), search_scope: "title_content", limit: 10 };
      return { summary: `动作：搜索文档\n关键词：${keywords.join("、")}`, command: ["doc", "search", "--json", JSON.stringify(request)] };
    },
  },
  "doc.create": {
    guide: "创建企业微信文档；参数：doc_name，选填 content（Markdown）；只在 Owner 私聊执行",
    mode: "write",
    private: true,
    explicitRequest: /(?:(?:创建|新建|建).{0,20}(?:文档|在线文档)|(?:文档|在线文档).{0,20}(?:创建|新建|建))/i,
    formatResult: formatDocCreate,
    async prepare(args) {
      const docName = text(args.doc_name, "文档标题", 255, true)!;
      const content = text(args.content, "文档内容", 50_000);
      const request = { doc_name: docName, doc_type: "doc", ...(content ? { content, content_type: "markdown" } : {}) };
      return {
        summary: `动作：创建文档\n标题：${docName}${content ? `\n内容：${content.length > 500 ? `${content.slice(0, 500)}…` : content}` : ""}`,
        command: ["doc", "create", "--json", JSON.stringify(request)],
      };
    },
  },
  "disk.search": {
    guide: "搜索微盘文件、文件夹或空间；参数：keywords，选填 file_types、space_keywords；只在 Owner 私聊执行",
    mode: "read",
    private: true,
    formatResult: formatDiskFiles,
    async prepare(args) {
      const keywords = texts(args.keywords, "搜索关键词", 20, true);
      const fileTypes = texts(args.file_types, "文件类型", 10);
      const spaceKeywords = texts(args.space_keywords, "空间关键词", 10);
      const allowed = ["doc", "sheet", "ppt", "collect", "mind", "flow", "smartsheet", "smartpage", "journal", "pdf", "offline_word", "offline_excel", "offline_ppt", "offline_pdf", "image", "videoaudio", "design"];
      if (fileTypes.some((type) => !allowed.includes(type))) throw new Error(`文件类型只支持 ${allowed.join("、")}`);
      const request = {
        keywords,
        ...(fileTypes.length ? { file_types: fileTypes } : {}),
        ...(spaceKeywords.length ? { space_keywords: spaceKeywords } : {}),
        search_type: "all",
        limit: 10,
      };
      return { summary: `动作：搜索微盘\n关键词：${keywords.join("、")}`, command: ["disk", "files", "search", "--json", JSON.stringify(request)] };
    },
  },
};

/** 提示词里列给 Runtime 看的动作清单。只列白名单里真实存在的。 */
export function actionCatalog(): string {
  return Object.entries(ACTIONS).map(([name, spec]) => `- ${name}：${spec.guide}`).join("\n");
}

export function isKnownAction(name: string): boolean {
  return Object.hasOwn(ACTIONS, name);
}

export function actionMode(name: string): PreparedAction["mode"] | undefined {
  return ACTIONS[name]?.mode;
}

export function actionPrivate(name: string): boolean {
  return ACTIONS[name]?.private ?? false;
}

/** Owner 免二次确认只认当前指令里的明确操作意图，不能由 Runtime 或历史消息替用户授权。 */
export function isExplicitActionRequest(action: ProposedAction, instruction: string): boolean {
  const spec = ACTIONS[action.name];
  return (action.name.endsWith(".create") && CREATE_CONFIRMATION.test(instruction))
    || (spec?.explicitRequest?.test(instruction) ?? false);
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
  return {
    ...await spec.prepare(action.arguments, resolve),
    mode: spec.mode,
    ...(spec.private ? { private: true } : {}),
    ...(spec.formatResult ? { formatResult: spec.formatResult } : {}),
  };
}
