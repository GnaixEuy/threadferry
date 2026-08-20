import { createHash, randomBytes } from "node:crypto";
import { authorize } from "./authorization.js";
import { buildContext } from "./context-builder.js";
import { resolveDirectoryUser } from "./directory.js";
import { newErrorId, sessionScope, ThreadFerryState, type FailurePhase } from "./state.js";
import { actionMode, actionPrivate, extractAction, isExplicitActionRequest, prepareAction, type PreparedAction } from "./actions.js";
import type { AgentView, DirectoryUser, GroupMessage, IncomingDirectMessage, IncomingMention, Reply, RuntimeRequest, RuntimeResult } from "./types.js";

export type HandleResult = "handled" | "stale" | "failed" | "command" | "delivery_pending" | "duplicate" | "unauthorized_group" | "missing_mention" | "unauthorized_user";

/** 待 Owner 确认的动作。Runtime 只能提议，执行永远由 ThreadFerry 在确认后进行。 */
interface PendingAction {
  prepared: PreparedAction;
  /** 提议发生在哪个会话：群 ID，或私聊时为 undefined。确认后回执发回原处。 */
  groupId?: string;
  requestedBy: string;
  expiresAt: number;
}

export interface AppDependencies {
  history: (groupId: string, options: { lookbackHours: number; maxMessages: number; endTime: Date }) => Promise<GroupMessage[]>;
  runtime: (request: RuntimeRequest) => Promise<RuntimeResult>;
  updateAllowUsers?: (groupId: string, users: string[]) => Promise<void>;
  updateGroupAccess?: (groupId: string, allowAll: boolean) => Promise<void>;
  bindGroup?: (groupId: string) => Promise<void>;
  listGroups?: () => Promise<Array<{ id: string; name?: string }>>;
  searchUsers?: (keywords: string[]) => Promise<DirectoryUser[]>;
  /** 执行一个已校验的白名单动作（由 ThreadFerry 自己调 wecom-cli，不经过 Runtime 沙箱）。 */
  runAction?: (command: string[], write: boolean) => Promise<Record<string, unknown> | void>;
  /** Owner 在私聊里确认后，把回执发回提议发生的那个群。 */
  notifyGroup?: (groupId: string, content: string) => Promise<void>;
  onError?: (error: { errorId: string; phase: FailurePhase; reason?: string }) => void;
}

type ManagementCommand = "help" | "whoami" | "groups" | "agents" | "users" | "invite" | "join" | "add" | "remove" | "bind" | "open" | "close" | "confirm";
const USER_ID = /^[A-Za-z0-9_@.-]{1,512}$/;

function managementCommand(text: string): { name: ManagementCommand; arguments: string[] } | undefined {
  const match = text.match(/(?:^|[\s@])threadferry\s+(help|whoami|groups|agents|users|invite|join|add|remove|bind|open|close|confirm)(?:\s+(.+?))?\s*$/i);
  if (!match) return undefined;
  return { name: match[1]!.toLowerCase() as ManagementCommand, arguments: match[2]?.trim().split(/\s+/) ?? [] };
}

// 仅用于本机控制台日志：Runtime 与 wecom-cli 的 Error.message 都是固定诊断文案，
// 不含群消息内容；这里再压成单行并截断，避免污染日志。reason 不入库也不进群回复。
// 失败回复里直接带上原因。原先只给错误编号、原因单独进本机控制台，实践证明这在私聊里
// 毫无意义——私聊对象只可能是 Owner（非 Owner 在跑 Runtime 之前就被拒），对他隐瞒原因
// 只是让他多跑一趟终端。错误编号继续保留，用于和日志对账。
//
// 唯一需要小心的是**群聊**：群里有非 Owner 的同事。原因文本来自 Runtime CLI 的固定文案
// 或 wecom-cli 的错误说明，不含群消息内容；但配置类错误可能带 Workspace 绝对路径，
// 所以群聊回复里把看起来像本机路径的片段替换掉。
const HOME_LIKE_PATH = /(?:\/(?:Users|home)\/[^\s"']+|\/(?:private\/)?(?:var|tmp)\/[^\s"']+)/g;

function publicReason(reason: string): string {
  return reason.replace(HOME_LIKE_PATH, "<本机路径>");
}

function withReason(base: string, reason: string | undefined, audience: "direct" | "group"): string {
  if (!reason) return base;
  return `${base}\n\n原因：${audience === "group" ? publicReason(reason) : reason}`;
}

function failureReason(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) return undefined;
  const single = error.message.replace(/\s+/g, " ").trim();
  if (!single) return undefined;
  return single.length > 200 ? `${single.slice(0, 200)}…` : single;
}

function ownerOnly(action: string, senderId: string): string {
  return `只有机器人创建者（ThreadFerry Owner）可以${action}。\n\n你的 userid：\`${senderId}\`\n如果你更换了企业或重建了机器人，回调 userid 会变化，需要在运行 ThreadFerry 的机器上重新确认 Owner：重启 \`threadferry start\` 按提示更新，或执行 \`threadferry setup\`。`;
}

function limitUtf8(input: string, maxBytes = 12_000): string {
  if (Buffer.byteLength(input) <= maxBytes) return input;
  let result = "";
  for (const character of input) {
    if (Buffer.byteLength(result + character + "\n\n[回复已截断]") > maxBytes) break;
    result += character;
  }
  return result + "\n\n[回复已截断]";
}

function historyFingerprint(history: GroupMessage[], current: IncomingMention): string {
  const currentSecond = Math.floor(current.time.getTime() / 1000);
  const normalized = history
    .filter((message) => !(message.senderId === current.senderId
      && Math.floor(message.time.getTime() / 1000) === currentSecond
      && message.text === current.text))
    .map((message) => [
      message.time.toISOString(),
      message.senderId,
      message.senderName ?? "",
      message.text,
      message.quote?.type ?? "",
      message.quote?.text ?? "",
      (message.attachments ?? []).map((attachment) => [attachment.type, attachment.name ?? ""]),
    ])
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function createApp(config: AgentView, dependencies: AppDependencies, state = new ThreadFerryState()) {
  // 一个 app 实例只服务一个 Agent。群里同时 @ 两台机器人时，同一条消息（msgId 相同）
  // 会被每台的连接各收一次，所以状态里的「已处理」判定必须带上 Agent，否则第二台不回话。
  const selfAgent = () => Object.keys(config.agents)[0];
  const groupTails = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const invites = new Map<string, { groupId: string; expiresAt: number }>();
  // Runtime 提议的动作在这里等 Owner 确认。只存在内存里：重启后未确认的提议自然作废，
  // 这正是我们想要的——没人确认过的写操作不该跨重启存活。
  const pendingActions = new Map<string, PendingAction>();
  const callbackDirectoryIds = new Map<string, string>();
  let accessTail = Promise.resolve();
  let shuttingDown = false;

  function updateUsers(groupId: string, change: (current: string[]) => string[]): Promise<string[]> {
    const operation = accessTail.then(async () => {
      const group = config.groups[groupId];
      if (!group || !dependencies.updateAllowUsers) throw new Error("当前启动方式不支持用户管理");
      const users = [...new Set(change(group.allowUsers))];
      if (!users.every((user) => USER_ID.test(user))) throw new Error("userid 无效");
      if (!users.includes(config.ownerUser)) throw new Error("不能移除 ThreadFerry Owner");
      if (users.length > 256) throw new Error("可使用用户已达到 256 人上限");
      await dependencies.updateAllowUsers(groupId, users);
      group.allowUsers = users;
      return users;
    });
    accessTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  function updateAccess(groupId: string, allowAll: boolean): Promise<void> {
    const operation = accessTail.then(async () => {
      const group = config.groups[groupId];
      if (!group || !dependencies.updateGroupAccess) throw new Error("当前启动方式不支持访问开关管理");
      await dependencies.updateGroupAccess(groupId, allowAll);
      group.allowAll = allowAll;
    });
    accessTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  // 一个 app 实例只服务一个 Agent，所以绑定就是「绑到我」——不需要也不接受 Agent 参数。
  function bindGroup(groupId: string): Promise<void> {
    const operation = accessTail.then(async () => {
      if (config.groups[groupId]) throw new Error("这个群已经绑给我了");
      const [agentId] = Object.entries(config.agents)[0] ?? [];
      if (!agentId) throw new Error("当前没有可用 Agent。");
      if (!dependencies.bindGroup) throw new Error("当前启动方式不支持群绑定");
      await dependencies.bindGroup(groupId);
      config.groups[groupId] = { agent: agentId, allowUsers: [config.ownerUser], context: { lookbackHours: 6, maxMessages: 80 } };
    });
    accessTail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  // Runtime 只会「提议」动作。这里把提议从回复里摘掉、校验参数；Owner 本人的明确请求直接执行，
  // 其他人的请求才挂起等 Owner 确认。
  // 校验失败就把原因当成普通回复发出去——绝不猜测用户意图，也绝不擅自执行。
  async function stageAction(text: string, instruction: string, requestedBy: string, groupId?: string): Promise<string> {
    const { reply: cleaned, action } = extractAction(text);
    if (!action) return text;
    if (!dependencies.runAction) return cleaned || "当前启动方式不支持代为执行企业微信动作。";
    if (groupId && (actionMode(action.name) === "read" || actionPrivate(action.name))) {
      return `${cleaned ? `${cleaned}\n\n` : ""}该企业微信操作只在 Owner 私聊中执行，避免把个人数据或操作内容发到群里。`;
    }
    let prepared: PreparedAction;
    try {
      prepared = await prepareAction(action, (reference) => resolveDirectoryUser(reference, dependencies.searchUsers));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "动作参数无效";
      return `${cleaned ? `${cleaned}\n\n` : ""}这个动作我没法执行：${reason}`;
    }
    if (prepared.mode === "read") {
      try {
        const result = await dependencies.runAction(prepared.command, false) ?? {};
        const details = prepared.formatResult?.(result);
        return `${cleaned ? `${cleaned}\n\n` : ""}${details ?? "查询完成。"}`;
      } catch (error) {
        return `${cleaned ? `${cleaned}\n\n` : ""}${withReason("查询失败。", failureReason(error), "direct")}`;
      }
    }
    if (isExplicitActionRequest(action, instruction) && await isOwner(requestedBy)) {
      try {
        const result = await dependencies.runAction(prepared.command, true) ?? {};
        const details = prepared.formatResult?.(result);
        return `${cleaned ? `${cleaned}\n\n` : ""}已自动执行：\n${prepared.summary}${details ? `\n${details}` : ""}`;
      } catch (error) {
        const errorId = newErrorId();
        const reason = failureReason(error);
        dependencies.onError?.({ errorId, phase: "host", ...(reason ? { reason } : {}) });
        const failure = groupId
          ? `动作执行失败（错误编号 ${errorId}）。请联系机器人 Owner。`
          : withReason(`动作执行失败（错误编号 ${errorId}）。`, reason, "direct");
        return `${cleaned ? `${cleaned}\n\n` : ""}${failure}`;
      }
    }
    for (const [known, item] of pendingActions) if (item.expiresAt < Date.now()) pendingActions.delete(known);
    const code = randomBytes(3).toString("hex").toUpperCase();
    pendingActions.set(code, {
      prepared,
      ...(groupId ? { groupId } : {}),
      requestedBy,
      expiresAt: Date.now() + 10 * 60_000,
    });
    return [
      cleaned,
      cleaned ? "" : undefined,
      prepared.summary,
      "",
      `我不会自己动手。请 Owner 私聊我发送 \`threadferry confirm ${code}\` 执行（10 分钟内有效）。`,
    ].filter((line) => line !== undefined).join("\n");
  }

  async function respond(reply: Reply, content: string): Promise<HandleResult> {
    try {
      await reply(limitUtf8(content), true);
      return "command";
    } catch {
      return "failed";
    }
  }

  async function groupSessions(): Promise<Array<{ id: string; name?: string }>> {
    try {
      return await dependencies.listGroups?.() ?? [];
    } catch {
      throw new Error("暂时无法读取机器人群列表；请稍后重试，或改用群 ID。");
    }
  }

  async function resolveGroup(reference: string): Promise<{ id: string; name?: string }> {
    if (config.groups[reference]) return { id: reference };
    if (!reference) throw new Error("缺少群名。请先发送 `threadferry groups` 查看可管理群。");
    const sessions = await groupSessions();
    const matches = sessions.filter((session) => session.name === reference);
    const configured = matches.filter((session) => config.groups[session.id]);
    if (configured.length === 1) return configured[0]!;
    if (configured.length > 1) {
      throw new Error(`有多个同名群“${reference}”，请改用群 ID：\n${configured.map((group) => `- \`${group.id}\``).join("\n")}`);
    }
    if (matches.length > 0) throw new Error(`群“${reference}”还没绑定给我，请先发送 \`threadferry bind ${reference}\`。`);
    throw new Error(`没有找到已配置群“${reference}”。请先发送 \`threadferry groups\`。`);
  }

  // bind 用：群必须是「这个机器人看得见、但还没配置」的。
  async function resolveUnboundGroup(reference: string): Promise<{ id: string; name?: string }> {
    if (!reference) throw new Error("缺少群名。请先发送 `threadferry groups` 查看可绑定的群。");
    if (config.groups[reference]) throw new Error("该群已经配置");
    const sessions = await groupSessions();
    const byId = sessions.find((session) => session.id === reference);
    if (byId) return byId;
    const matches = sessions.filter((session) => session.name === reference);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`有多个同名群“${reference}”，请改用群 ID：\n${matches.map((group) => `- \`${group.id}\``).join("\n")}`);
    }
    throw new Error(`我看不到群“${reference}”。把我拉进该内部群后，群里最近 7 天要有消息才能被发现——`
      + `可以在群里随便发一条或 @ 我一次，然后发送 \`threadferry groups\`。`);
  }

  async function resolveGroupAndValue(arguments_: string[], label: string): Promise<{ group: { id: string; name?: string }; value: string }> {
    if (arguments_.length < 2) throw new Error(`缺少群名或${label}。`);
    if (config.groups[arguments_[0]!]) {
      return { group: { id: arguments_[0]! }, value: arguments_.slice(1).join(" ") };
    }
    const sessions = await groupSessions();
    const byId = sessions.find((session) => session.id === arguments_[0]);
    if (byId) {
      throw new Error(`群 \`${byId.id}\` 还没绑定给我，请先发送 \`threadferry bind ${byId.name ?? byId.id}\`。`);
    }
    const input = arguments_.join(" ");
    const named = sessions
      .filter((session) => session.name && input.startsWith(`${session.name} `))
      .sort((left, right) => right.name!.length - left.name!.length);
    if (named.length === 0) throw new Error("没有识别出群名。请先发送 `threadferry groups`，也可以改用群 ID。");
    const longest = named[0]!.name!;
    const matches = named.filter((session) => session.name === longest && config.groups[session.id]);
    if (matches.length > 1) {
      throw new Error(`有多个同名群“${longest}”，请改用群 ID：\n${matches.map((group) => `- \`${group.id}\``).join("\n")}`);
    }
    if (matches.length === 0) throw new Error(`群“${longest}”还没绑定给我，请先发送 \`threadferry bind ${longest}\`。`);
    return { group: matches[0]!, value: input.slice(longest.length).trim() };
  }

  async function directoryIdForCallback(callbackId: string): Promise<string | undefined> {
    const cached = callbackDirectoryIds.get(callbackId);
    if (cached) return cached;
    if (!dependencies.searchUsers) return undefined;
    const users = await dependencies.searchUsers([callbackId]);
    const matches = users.filter((user) => user.matchedKeywords?.includes(callbackId));
    const user = matches.length === 1 ? matches[0] : undefined;
    if (user) callbackDirectoryIds.set(callbackId, user.id);
    return user?.id;
  }

  // 企业微信存在两套 userid：事件回调用的是明文 corp userid（如 SuYueXiang），
  // 目录/identity 用的是加密 userid（如 wowBknbg...）。配置里存的是目录 ID，
  // 所以私聊授权、whoami 展示都要先映射，否则创建者本人会被当成陌生人拒绝。
  async function authoritativeId(senderId: string): Promise<string> {
    return (await directoryIdForCallback(senderId)) ?? senderId;
  }

  async function isOwner(senderId: string): Promise<boolean> {
    if (senderId === config.ownerUser) return true;
    return (await directoryIdForCallback(senderId)) === config.ownerUser;
  }

  async function authorizeMessage(message: IncomingMention): Promise<ReturnType<typeof authorize>> {
    const authorization = authorize(config, message);
    if (authorization.allowed || authorization.reason !== "user") return authorization;
    try {
      const directoryId = await directoryIdForCallback(message.senderId);
      const group = config.groups[message.groupId]!;
      return directoryId && group.allowUsers.includes(directoryId) ? { allowed: true, group } : authorization;
    } catch {
      return authorization;
    }
  }

  async function equivalentAllowedIds(directoryId: string, allowed: string[]): Promise<Set<string>> {
    const ids = new Set([directoryId]);
    for (const [callbackId, mappedId] of callbackDirectoryIds) if (mappedId === directoryId) ids.add(callbackId);
    if (!dependencies.searchUsers) return ids;
    try {
      for (let index = 0; index < allowed.length; index += 10) {
        const batch = allowed.slice(index, index + 10);
        for (const user of await dependencies.searchUsers(batch)) {
          if (user.id !== directoryId) continue;
          for (const keyword of user.matchedKeywords ?? []) if (batch.includes(keyword)) ids.add(keyword);
        }
      }
    } catch {
      // 精确通讯录 ID 仍会被移除；旧邀请码产生的回调 ID 可用 id: 显式移除。
    }
    return ids;
  }

  async function formatUsers(userIds: string[]): Promise<string> {
    if (!dependencies.searchUsers) return userIds.map((id) => `- \`${id}\``).join("\n");
    const found: DirectoryUser[] = [];
    try {
      for (let index = 0; index < userIds.length; index += 10) {
        found.push(...await dependencies.searchUsers(userIds.slice(index, index + 10)));
      }
    } catch {
      return userIds.map((id) => `- \`${id}\``).join("\n");
    }
    const byId = new Map<string, DirectoryUser>();
    for (const user of found) {
      byId.set(user.id, user);
      for (const keyword of user.matchedKeywords ?? []) if (userIds.includes(keyword)) byId.set(keyword, user);
    }
    return userIds.map((id) => {
      const user = byId.get(id);
      return user ? `- ${user.name}${user.alias ? `（${user.alias}）` : ""}  \`${id}\`` : `- \`${id}\``;
    }).join("\n");
  }

  async function join(senderId: string, codeInput: string | undefined, reply: Reply, currentGroupId?: string): Promise<HandleResult> {
    const code = codeInput?.toUpperCase();
    const invite = code ? invites.get(code) : undefined;
    if (!code || !invite || invite.expiresAt < Date.now() || (currentGroupId && invite.groupId !== currentGroupId)) {
      if (code && invite?.expiresAt && invite.expiresAt < Date.now()) invites.delete(code);
      return respond(reply, "邀请码无效、已过期或不属于当前群，请联系机器人 Owner 重新生成。");
    }
    invites.delete(code);
    try {
      const directoryId = await authoritativeId(senderId);
      await updateUsers(invite.groupId, (users) => [...users, directoryId]);
      return respond(reply, `授权成功。你现在可以在群 \`${invite.groupId}\` 使用 ThreadFerry。`);
    } catch (error) {
      const errorId = newErrorId();
      const reason = failureReason(error);
      dependencies.onError?.({ errorId, phase: "host", ...(reason ? { reason } : {}) });
      return respond(reply, withReason(`权限更新失败（错误编号 ${errorId}）。请联系机器人 Owner。`, reason, "group"));
    }
  }

  async function handleDirect(message: IncomingDirectMessage, reply: Reply): Promise<HandleResult> {
    if (!(await state.claimCommand(message.msgId, `direct:${message.senderId}`, selfAgent()))) return "duplicate";
    const command = managementCommand(message.text);
    if (!command) {
      if (!(await isOwner(message.senderId))) return respond(reply, ownerOnly("私聊 Agent", await authoritativeId(message.senderId)));
      const scope = `direct:${message.senderId}`;
      const queued = groupTails.has(scope);
      try {
        await reply(queued ? "ThreadFerry 已收到，当前私聊有任务处理中，已排队。" : "ThreadFerry 已收到，正在分析。", false);
      } catch {
        return "failed";
      }
      return serial(scope, () => processDirect(message, reply));
    }
    if (command.name === "whoami") return respond(reply, `你的 ThreadFerry userid：\`${await authoritativeId(message.senderId)}\``);
    if (command.name === "join") return join(message.senderId, command.arguments[0], reply);
    if (!(await isOwner(message.senderId))) return respond(reply, ownerOnly("在私聊中管理群权限", await authoritativeId(message.senderId)));
    if (command.name === "help") {
      const [selfId, self] = Object.entries(config.agents)[0] ?? [];
      const selfLine = selfId ? `你正在和 Agent \`${selfId}\` 对话，Workspace 是 ${self!.workspace}。\n\n` : "";
      return respond(reply, `${selfLine}直接发送普通消息即可让我在这个 Workspace 里分析。\n\n接入群聊：\n1. 请企业管理员批准机器人的数据访问权限，并把我加入目标内部群\n2. 发送 \`threadferry groups\` 查看群名或群 ID\n3. 发送 \`threadferry bind <群名或ID>\` 把该群绑定给我\n\n其他管理命令：\n- \`threadferry users <群名>\` 查看可使用用户\n- \`threadferry invite <群名>\` 生成一次性邀请码\n- \`threadferry add <群名> <姓名>\` 直接授权\n- \`threadferry remove <群名> <姓名>\` 移除授权\n- \`threadferry open <群名>\` 允许群内所有成员使用\n- \`threadferry close <群名>\` 恢复仅授权成员可用\n- \`threadferry whoami\` 查看自己的 userid\n\n每个 Agent 对应一个机器人：想用别的 Workspace，就去和那个机器人私聊。\n群或成员重名时，按我返回的 ID 重新发送即可。`);
    }
    if (command.name === "confirm") {
      const code = command.arguments[0]?.toUpperCase() ?? "";
      const pending = pendingActions.get(code);
      if (!pending || pending.expiresAt < Date.now()) {
        pendingActions.delete(code);
        return respond(reply, "确认码无效或已过期。请重新提出需求，我会给一个新的确认码。");
      }
      if (!dependencies.runAction) return respond(reply, "当前启动方式不支持代为执行企业微信动作。");
      pendingActions.delete(code);
      let details: string | undefined;
      try {
        const result = await dependencies.runAction(pending.prepared.command, true) ?? {};
        details = pending.prepared.formatResult?.(result);
      } catch (error) {
        const reason = failureReason(error);
        return respond(reply, withReason("动作执行失败。", reason, "direct"));
      }
      // 提议发生在群里就把回执发回群里，省得群里的人不知道到底做没做。
      if (pending.groupId) {
        await dependencies.notifyGroup?.(pending.groupId, `已按 Owner 确认执行：\n${pending.prepared.summary}${details ? `\n${details}` : ""}`)
          .catch(() => undefined);
      }
      return respond(reply, `已执行：\n${pending.prepared.summary}${details ? `\n${details}` : ""}`);
    }
    if (command.name === "agents") {
      const lines = Object.entries(config.agents).map(([id, agent]) => `- \`${id}\`：${agent.runtime}${agent.model ? ` / ${agent.model}` : ""}\n  ${agent.workspace}`);
      return respond(reply, `可用 Agent：\n${lines.join("\n")}`);
    }
    if (command.name === "groups") {
      let sessions: Array<{ id: string; name?: string }> = [];
      try {
        sessions = await dependencies.listGroups?.() ?? [];
      } catch {
        // 群列表接口失败时仍展示配置中的群 ID，不泄露 CLI 错误详情。
      }
      const byId = new Map(sessions.map((session) => [session.id, session]));
      const ids = [...new Set([...sessions.map((session) => session.id), ...Object.keys(config.groups)])];
      const lines = ids.map((id) => {
        const session = byId.get(id);
        const configured = Boolean(config.groups[id]);
        const agent = config.groups[id]?.agent;
        const openTag = config.groups[id]?.allowAll ? " 全员可用" : "";
        return `- ${configured ? `[${agent}]` : "[未配置 Agent]"}${openTag} ${session?.name ?? "未获取群名"}\n  \`${id}\``;
      });
      return respond(reply, `机器人最近群会话：\n${lines.length ? lines.join("\n") : "暂无可见群会话"}`);
    }

    let group: { id: string; name?: string };
    let target: { group: { id: string; name?: string }; value: string } | undefined;
    try {
      if (command.name === "add" || command.name === "remove") {
        target = await resolveGroupAndValue(command.arguments, "用户姓名");
        group = target.group;
      } else if (command.name === "bind") {
        group = await resolveUnboundGroup(command.arguments.join(" "));
      } else {
        group = await resolveGroup(command.arguments.join(" "));
      }
    } catch (error) {
      return respond(reply, error instanceof Error ? error.message : "群名解析失败。");
    }
    const groupLabel = group.name ?? group.id;
    if (command.name === "bind") {
      try {
        await bindGroup(group.id);
        return respond(reply, `群“${groupLabel}”已绑定到我。群内成员 @我 即可使用，可用 \`threadferry open ${groupLabel}\` 放开给全员。`);
      } catch (error) {
        return respond(reply, error instanceof Error ? error.message : "群绑定失败。");
      }
    }
    const configured = config.groups[group.id]!;
    if (command.name === "users") {
      const heading = configured.allowAll
        ? `群“${groupLabel}”已开启全员可用，群内所有成员都可以 @机器人 使用。\n关闭后仍然生效的授权用户：`
        : `群“${groupLabel}”可使用用户：`;
      return respond(reply, `${heading}\n${await formatUsers(configured.allowUsers)}`);
    }
    if (command.name === "invite") {
      for (const [code, item] of invites) if (item.groupId === group.id) invites.delete(code);
      const code = randomBytes(6).toString("hex").toUpperCase();
      invites.set(code, { groupId: group.id, expiresAt: Date.now() + 10 * 60_000 });
      return respond(reply, `群“${groupLabel}”的一次性邀请码：\`${code}\`\n\n目标用户可私聊机器人发送 \`threadferry join ${code}\`，或在该群发送 \`@机器人 threadferry join ${code}\`。10 分钟内有效。`);
    }
    if (command.name === "open" || command.name === "close") {
      const allowAll = command.name === "open";
      try {
        await updateAccess(group.id, allowAll);
        return respond(reply, allowAll
          ? `已开启：群“${groupLabel}”的所有成员都可以 @机器人 使用，关闭请发送 \`threadferry close <群名>\`。`
          : `已关闭：群“${groupLabel}”恢复为仅授权成员可使用。`);
      } catch (error) {
        return respond(reply, error instanceof Error ? error.message : "访问开关更新失败。");
      }
    }
    let user: DirectoryUser;
    try {
      user = await resolveDirectoryUser(target!.value, dependencies.searchUsers);
    } catch (error) {
      return respond(reply, error instanceof Error ? error.message : "用户姓名解析失败。");
    }
    if (command.name === "remove") {
      let ownerDirectoryId: string | undefined;
      try {
        ownerDirectoryId = await directoryIdForCallback(config.ownerUser);
      } catch {
        // Owner 的原始回调 userid 仍受下面的精确比较保护。
      }
      if (user.id === config.ownerUser || user.id === ownerDirectoryId) {
        return respond(reply, "不能移除机器人 ThreadFerry Owner。");
      }
    }
    try {
      const removeIds = command.name === "remove" ? await equivalentAllowedIds(user.id, configured.allowUsers) : undefined;
      const users = await updateUsers(group.id, (current) => command.name === "add"
        ? [...current, user.id]
        : current.filter((id) => !removeIds!.has(id)));
      return respond(reply, command.name === "add"
        ? `已在群“${groupLabel}”授权 ${user.name}。当前 ${users.length} 人。`
        : `已从群“${groupLabel}”移除 ${user.name}。当前 ${users.length} 人。`);
    } catch (error) {
      const errorId = newErrorId();
      const reason = failureReason(error);
      dependencies.onError?.({ errorId, phase: "host", ...(reason ? { reason } : {}) });
      return respond(reply, `权限更新失败（错误编号 ${errorId}）。请执行 \`threadferry status\`。`);
    }
  }

  async function handleGroupCommand(message: IncomingMention, reply: Reply, command: { name: ManagementCommand; arguments: string[] }): Promise<HandleResult> {
    if (!config.groups[message.groupId]) return "unauthorized_group";
    if (!(await state.claimCommand(message.msgId, message.groupId, selfAgent()))) return "duplicate";
    if (command.name === "whoami") return respond(reply, `你的 ThreadFerry userid：\`${await authoritativeId(message.senderId)}\``);
    if (command.name === "join") return join(message.senderId, command.arguments[0], reply, message.groupId);
    return respond(reply, "机器人权限管理请私聊 ThreadFerry，并发送 `threadferry help` 查看命令。");
  }

  function serial<T>(groupId: string, operation: () => Promise<T>): Promise<T> {
    const previous = groupTails.get(groupId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    groupTails.set(groupId, tail);
    return current.finally(() => {
      if (groupTails.get(groupId) === tail) groupTails.delete(groupId);
    });
  }

  async function processDirect(message: IncomingDirectMessage, reply: Reply): Promise<HandleResult> {
    const scope = `direct:${message.senderId}`;
    const entry = Object.entries(config.agents)[0];
    if (!entry) return respond(reply, "当前没有可用 Agent。");
    const [agentId, agent] = entry;
    try {
      if (shuttingDown) throw new Error("ThreadFerry 正在停止");
      const scopeKey = sessionScope(agentId, agent);
      const sessionId = await state.session(scope, scopeKey);
      const controller = new AbortController();
      controllers.set(scope, controller);
      let result: RuntimeResult;
      try {
        result = await dependencies.runtime({
          agentId,
          ...agent,
          prompt: buildContext([], message, { lookbackHours: 0, maxMessages: 1 }, "direct"),
          ...(sessionId ? { sessionId } : {}),
          signal: controller.signal,
        });
      } finally {
        if (controllers.get(scope) === controller) controllers.delete(scope);
      }
      if (result.sessionId) await state.setSession(scope, scopeKey, result.sessionId);
      await reply(limitUtf8(await stageAction(result.text, message.text, message.senderId)), true);
      return "handled";
    } catch (error) {
      const errorId = newErrorId();
      const reason = failureReason(error);
      dependencies.onError?.({ errorId, phase: "runtime", ...(reason ? { reason } : {}) });
      // 原先私聊失败不落盘，于是回复里让用户跑 threadferry status 却查不到任何东西。
      await state.finish(message.msgId, "failed", { errorId, phase: "runtime" }, selfAgent()).catch(() => undefined);
      // 私聊对象只可能是 Owner，原因给全。
      await reply(withReason(`ThreadFerry 处理失败（错误编号 ${errorId}）。`, reason, "direct"), true).catch(() => undefined);
      return "failed";
    }
  }

  async function complete(
    message: IncomingMention,
    reply: Reply,
    status: "handled" | "stale" | "failed",
    content: string,
    failure?: { errorId: string; phase: FailurePhase },
  ): Promise<HandleResult> {
    // 待补发的回复要记住是哪台机器人算出来的：同群多机器人时不能用另一台的身份发出去。
    const deliveryId = await state.finishWithDelivery(
      message.msgId, message.groupId, status, content, failure, selfAgent());
    try {
      await reply(content, true);
      await state.completeDelivery(deliveryId);
      return status;
    } catch (error) {
      const errorId = newErrorId();
      await state.deliveryFailed(deliveryId, errorId).catch(() => undefined);
      const reason = failureReason(error);
      dependencies.onError?.({ errorId, phase: "reply", ...(reason ? { reason } : {}) });
      return status === "failed" ? "failed" : "delivery_pending";
    }
  }

  async function fail(message: IncomingMention, reply: Reply, phase: FailurePhase, error?: unknown): Promise<HandleResult> {
    const errorId = newErrorId();
    const reason = failureReason(error);
    dependencies.onError?.({ errorId, phase, ...(reason ? { reason } : {}) });
    const content = withReason(
      `ThreadFerry 处理失败（错误编号 ${errorId}）。`,
      reason,
      "group",
    ) + "\n\n如需更多细节，请在运行 ThreadFerry 的机器上执行 `threadferry status` 和 `threadferry doctor`。";
    try {
      return await complete(message, reply, "failed", content, { errorId, phase });
    } catch {
      await state.finish(message.msgId, "failed", { errorId, phase }, selfAgent()).catch(() => undefined);
      await reply(content, true).catch(() => undefined);
      return "failed";
    }
  }

  async function process(message: IncomingMention, reply: Reply, agentId: string, context: { lookbackHours: number; maxMessages: number }): Promise<HandleResult> {
    let phase: FailurePhase = "history";
    try {
      if (shuttingDown) throw new Error("ThreadFerry 正在停止");
      await state.markRunning(message.msgId, selfAgent());
      const history = await dependencies.history(message.groupId, { ...context, endTime: message.time });
      const fingerprint = historyFingerprint(history, message);
      const prompt = buildContext(history, message, context);
      const agent = config.agents[agentId];
      if (!agent) throw new Error("群绑定的 Agent 不存在");
      const scopeKey = sessionScope(agentId, agent);
      const sessionId = await state.session(message.groupId, scopeKey);
      phase = "runtime";
      const controller = new AbortController();
      controllers.set(message.groupId, controller);
      let result: RuntimeResult;
      try {
        result = await dependencies.runtime({ agentId, ...agent, prompt, ...(sessionId ? { sessionId } : {}), signal: controller.signal });
      } finally {
        if (controllers.get(message.groupId) === controller) controllers.delete(message.groupId);
      }
      if (result.sessionId) await state.setSession(message.groupId, scopeKey, result.sessionId);

      phase = "freshness";
      const latest = await dependencies.history(message.groupId, { ...context, endTime: new Date() });
      if (historyFingerprint(latest, message) !== fingerprint) {
        return complete(message, reply, "stale", "分析期间群里出现了新消息。为避免发送过期结论，请重新 @机器人。");
      }

      phase = "reply";
      return complete(message, reply, "handled",
        limitUtf8(await stageAction(result.text, message.text, message.senderId, message.groupId)));
    } catch (error) {
      return fail(message, reply, phase, error);
    }
  }

  async function replay(message: IncomingMention, reply: Reply): Promise<HandleResult> {
    const authorization = await authorizeMessage(message);
    if (!authorization.allowed) {
      const errorId = newErrorId();
      await state.finish(message.msgId, "failed", { errorId, phase: "host" }, selfAgent()).catch(() => undefined);
      dependencies.onError?.({ errorId, phase: "host" });
      return authorization.reason === "group"
        ? "unauthorized_group"
        : authorization.reason === "mention"
          ? "missing_mention"
          : "unauthorized_user";
    }
    const agentId = authorization.group.agent;
    return serial(message.groupId, () => process(message, reply, agentId, authorization.group.context));
  }

  return {
    async handle(message: IncomingMention, reply: Reply): Promise<HandleResult> {
      const command = managementCommand(message.text);
      if (command && message.mentioned) return handleGroupCommand(message, reply, command);
      const authorization = await authorizeMessage(message);
      if (!authorization.allowed) {
        return authorization.reason === "group"
          ? "unauthorized_group"
          : authorization.reason === "mention"
            ? "missing_mention"
            : "unauthorized_user";
      }
      // 状态里的身份一律用视图自己的 Agent（selfAgent），和后面的 markRunning / finish 保持一致；
      // 混用群记录里的 agent 会算出两个不同的 turn id，收尾时找不到自己的记录。
      if (!(await state.enqueue(message, selfAgent()))) return "duplicate";

      const queued = groupTails.has(message.groupId);
      try {
        await reply(queued ? "ThreadFerry 已收到，当前群有任务处理中，已排队。" : "ThreadFerry 已收到，正在分析。", false);
      } catch (error) {
        return fail(message, reply, "ack", error);
      }
      return serial(message.groupId, () => process(message, reply, authorization.group.agent, authorization.group.context));
    },
    handleDirect,
    replay,
    cancel(groupId: string): boolean {
      const controller = controllers.get(groupId);
      controller?.abort();
      return Boolean(controller);
    },
    async shutdown(cancel = true): Promise<void> {
      if (cancel) {
        shuttingDown = true;
        for (const controller of controllers.values()) controller.abort();
      }
      await Promise.all([...groupTails.values()]);
    },
  };
}
