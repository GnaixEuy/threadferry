import { createHash, randomBytes } from "node:crypto";
import { authorize } from "./authorization.js";
import { buildContext } from "./context-builder.js";
import { resolveDirectoryUser } from "./directory.js";
import { newErrorId, ThreadFerryState, type FailurePhase } from "./state.js";
import type { DirectoryUser, GroupMessage, IncomingDirectMessage, IncomingMention, Reply, RuntimeRequest, RuntimeResult, ThreadFerryConfig } from "./types.js";

export type HandleResult = "handled" | "stale" | "failed" | "command" | "delivery_pending" | "duplicate" | "unauthorized_group" | "missing_mention" | "unauthorized_user";

export interface AppDependencies {
  history: (groupId: string, options: { lookbackHours: number; maxMessages: number; endTime: Date }) => Promise<GroupMessage[]>;
  runtime: (request: RuntimeRequest) => Promise<RuntimeResult>;
  updateAllowUsers?: (groupId: string, users: string[]) => Promise<void>;
  updateGroupAgent?: (groupId: string, agentId: string) => Promise<void>;
  updateGroupAccess?: (groupId: string, allowAll: boolean) => Promise<void>;
  bindGroup?: (groupId: string, agentId: string) => Promise<void>;
  listGroups?: () => Promise<Array<{ id: string; name?: string }>>;
  searchUsers?: (keywords: string[]) => Promise<DirectoryUser[]>;
  onError?: (error: { errorId: string; phase: FailurePhase; reason?: string }) => void;
}

type ManagementCommand = "help" | "whoami" | "groups" | "agents" | "users" | "invite" | "join" | "add" | "remove" | "use" | "bind" | "open" | "close";
const USER_ID = /^[A-Za-z0-9_@.-]{1,512}$/;

function managementCommand(text: string): { name: ManagementCommand; arguments: string[] } | undefined {
  const match = text.match(/(?:^|[\s@])threadferry\s+(help|whoami|groups|agents|users|invite|join|add|remove|use|bind|open|close)(?:\s+(.+?))?\s*$/i);
  if (!match) return undefined;
  return { name: match[1]!.toLowerCase() as ManagementCommand, arguments: match[2]?.trim().split(/\s+/) ?? [] };
}

// 仅用于本机控制台日志：Runtime 与 wecom-cli 的 Error.message 都是固定诊断文案，
// 不含群消息内容；这里再压成单行并截断，避免污染日志。reason 不入库也不进群回复。
function failureReason(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.message) return undefined;
  const single = error.message.replace(/\s+/g, " ").trim();
  if (!single) return undefined;
  return single.length > 200 ? `${single.slice(0, 200)}…` : single;
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

export function createApp(config: ThreadFerryConfig, dependencies: AppDependencies, state = new ThreadFerryState()) {
  const groupTails = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const invites = new Map<string, { groupId: string; expiresAt: number }>();
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

  function updateAgent(groupId: string, agentId: string): Promise<void> {
    const operation = accessTail.then(async () => {
      const group = config.groups[groupId];
      if (!group || !dependencies.updateGroupAgent) throw new Error("当前启动方式不支持 Agent 管理");
      if (!config.agents[agentId]) throw new Error(`Agent \`${agentId}\` 不存在。请先发送 \`threadferry agents\`。`);
      await dependencies.updateGroupAgent(groupId, agentId);
      group.agent = agentId;
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

  function bindGroup(groupId: string, agentId: string): Promise<void> {
    const operation = accessTail.then(async () => {
      if (config.groups[groupId]) throw new Error("该群已经配置");
      if (!config.agents[agentId]) throw new Error(`Agent \`${agentId}\` 不存在。请先发送 \`threadferry agents\`。`);
      if (!dependencies.bindGroup) throw new Error("当前启动方式不支持群绑定");
      await dependencies.bindGroup(groupId, agentId);
      config.groups[groupId] = { agent: agentId, allowUsers: [config.ownerUser], context: { lookbackHours: 6, maxMessages: 80 } };
    });
    accessTail = operation.then(() => undefined, () => undefined);
    return operation;
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
    if (matches.length > 0) throw new Error(`群“${reference}”尚未配置 Agent，请先运行 threadferry setup。`);
    throw new Error(`没有找到已配置群“${reference}”。请先发送 \`threadferry groups\`。`);
  }

  async function resolveGroupAndValue(arguments_: string[], label: string, requireConfigured = true): Promise<{ group: { id: string; name?: string }; value: string }> {
    if (arguments_.length < 2) throw new Error(`缺少群名或${label}。`);
    if (config.groups[arguments_[0]!]) {
      return { group: { id: arguments_[0]! }, value: arguments_.slice(1).join(" ") };
    }
    const sessions = await groupSessions();
    const byId = sessions.find((session) => session.id === arguments_[0]);
    if (byId) {
      if (requireConfigured) throw new Error(`群 \`${byId.id}\` 尚未配置 Agent，请先发送 \`threadferry bind <群名或ID> <Agent名>\`。`);
      return { group: byId, value: arguments_.slice(1).join(" ") };
    }
    const input = arguments_.join(" ");
    const named = sessions
      .filter((session) => session.name && input.startsWith(`${session.name} `))
      .sort((left, right) => right.name!.length - left.name!.length);
    if (named.length === 0) throw new Error("没有识别出群名。请先发送 `threadferry groups`，也可以改用群 ID。");
    const longest = named[0]!.name!;
    const matches = named.filter((session) => session.name === longest && (!requireConfigured || config.groups[session.id]));
    if (matches.length > 1) {
      throw new Error(`有多个同名群“${longest}”，请改用群 ID：\n${matches.map((group) => `- \`${group.id}\``).join("\n")}`);
    }
    if (matches.length === 0) throw new Error(`群“${longest}”尚未配置 Agent，请先发送 \`threadferry bind <群名或ID> <Agent名>\`。`);
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
      await updateUsers(invite.groupId, (users) => [...users, senderId]);
      return respond(reply, `授权成功。你现在可以在群 \`${invite.groupId}\` 使用 ThreadFerry。`);
    } catch (error) {
      const errorId = newErrorId();
      const reason = failureReason(error);
      dependencies.onError?.({ errorId, phase: "host", ...(reason ? { reason } : {}) });
      return respond(reply, `权限更新失败（错误编号 ${errorId}）。请联系机器人 Owner。`);
    }
  }

  async function handleDirect(message: IncomingDirectMessage, reply: Reply): Promise<HandleResult> {
    if (!(await state.claimCommand(message.msgId, `direct:${message.senderId}`))) return "duplicate";
    const command = managementCommand(message.text);
    if (!command) {
      if (message.senderId !== config.ownerUser) return respond(reply, "只有机器人创建者（ThreadFerry Owner）可以私聊 Agent。");
      const scope = `direct:${message.senderId}`;
      const queued = groupTails.has(scope);
      try {
        await reply(queued ? "ThreadFerry 已收到，当前私聊有任务处理中，已排队。" : "ThreadFerry 已收到，正在分析。", false);
      } catch {
        return "failed";
      }
      return serial(scope, () => processDirect(message, reply));
    }
    if (command.name === "whoami") return respond(reply, `你的 ThreadFerry userid：\`${message.senderId}\``);
    if (command.name === "join") return join(message.senderId, command.arguments[0], reply);
    if (message.senderId !== config.ownerUser) return respond(reply, "只有机器人创建者（ThreadFerry Owner）可以在私聊中管理群权限。");
    if (command.name === "help") {
      return respond(reply, "直接发送普通消息即可私聊默认 Agent。\n\n接入群聊：\n1. 请企业管理员批准机器人的数据访问权限，并把机器人加入目标内部群\n2. 发送 `threadferry groups` 查看群名或群 ID\n3. 发送 `threadferry agents` 查看 Agent 名\n4. 发送 `threadferry bind <群名或ID> <Agent名>` 完成绑定\n\n其他管理命令：\n- `threadferry use <群名> <Agent名>` 切换群 Agent\n- `threadferry users <群名>` 查看可使用用户\n- `threadferry invite <群名>` 生成一次性邀请码\n- `threadferry add <群名> <姓名>` 直接授权\n- `threadferry remove <群名> <姓名>` 移除授权\n- `threadferry open <群名>` 允许群内所有成员使用\n- `threadferry close <群名>` 恢复仅授权成员可用\n- `threadferry whoami` 查看自己的 userid\n\n群或成员重名时，按机器人返回的 ID 重新发送即可。");
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
      if (command.name === "add" || command.name === "remove" || command.name === "use" || command.name === "bind") {
        target = await resolveGroupAndValue(command.arguments, command.name === "use" || command.name === "bind" ? " Agent 名" : "用户姓名", command.name !== "bind");
        group = target.group;
      } else {
        group = await resolveGroup(command.arguments.join(" "));
      }
    } catch (error) {
      return respond(reply, error instanceof Error ? error.message : "群名解析失败。");
    }
    const groupLabel = group.name ?? group.id;
    if (command.name === "bind") {
      try {
        await bindGroup(group.id, target!.value);
        return respond(reply, `群“${groupLabel}”已绑定 Agent \`${target!.value}\`。`);
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
    if (command.name === "use") {
      try {
        await updateAgent(group.id, target!.value);
        return respond(reply, `群“${groupLabel}”已切换到 Agent \`${target!.value}\`。下一条 @ 消息生效。`);
      } catch (error) {
        return respond(reply, error instanceof Error ? error.message : "Agent 切换失败。");
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
    if (!(await state.claimCommand(message.msgId, message.groupId))) return "duplicate";
    if (command.name === "whoami") return respond(reply, `你的 ThreadFerry userid：\`${message.senderId}\``);
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
      const sessionScope = `${agentId}\0${agent.runtime}\0${agent.workspace}`;
      const sessionId = await state.session(scope, sessionScope);
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
      if (result.sessionId) await state.setSession(scope, sessionScope, result.sessionId);
      await reply(limitUtf8(result.text), true);
      return "handled";
    } catch (error) {
      const errorId = newErrorId();
      const reason = failureReason(error);
      dependencies.onError?.({ errorId, phase: "runtime", ...(reason ? { reason } : {}) });
      await reply(`ThreadFerry 处理失败（错误编号 ${errorId}）。请在运行 ThreadFerry 的机器上执行 \`threadferry status\`。`, true).catch(() => undefined);
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
    const deliveryId = await state.finishWithDelivery(message.msgId, message.groupId, status, content, failure);
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
    const content = "ThreadFerry 处理失败（错误编号 " + errorId + "）。请在运行 ThreadFerry 的机器上执行 `threadferry status` 和 `threadferry doctor`。";
    try {
      return await complete(message, reply, "failed", content, { errorId, phase });
    } catch {
      await state.finish(message.msgId, "failed", { errorId, phase }).catch(() => undefined);
      await reply(content, true).catch(() => undefined);
      return "failed";
    }
  }

  async function process(message: IncomingMention, reply: Reply, agentId: string, context: { lookbackHours: number; maxMessages: number }): Promise<HandleResult> {
    let phase: FailurePhase = "history";
    try {
      if (shuttingDown) throw new Error("ThreadFerry 正在停止");
      await state.markRunning(message.msgId);
      const history = await dependencies.history(message.groupId, { ...context, endTime: message.time });
      const fingerprint = historyFingerprint(history, message);
      const prompt = buildContext(history, message, context);
      const agent = config.agents[agentId];
      if (!agent) throw new Error("群绑定的 Agent 不存在");
      const sessionScope = `${agentId}\0${agent.runtime}\0${agent.workspace}`;
      const sessionId = await state.session(message.groupId, sessionScope);
      phase = "runtime";
      const controller = new AbortController();
      controllers.set(message.groupId, controller);
      let result: RuntimeResult;
      try {
        result = await dependencies.runtime({ agentId, ...agent, prompt, ...(sessionId ? { sessionId } : {}), signal: controller.signal });
      } finally {
        if (controllers.get(message.groupId) === controller) controllers.delete(message.groupId);
      }
      if (result.sessionId) await state.setSession(message.groupId, sessionScope, result.sessionId);

      phase = "freshness";
      const latest = await dependencies.history(message.groupId, { ...context, endTime: new Date() });
      if (historyFingerprint(latest, message) !== fingerprint) {
        return complete(message, reply, "stale", "分析期间群里出现了新消息。为避免发送过期结论，请重新 @机器人。");
      }

      phase = "reply";
      return complete(message, reply, "handled", limitUtf8(result.text));
    } catch (error) {
      return fail(message, reply, phase, error);
    }
  }

  async function replay(message: IncomingMention, reply: Reply): Promise<HandleResult> {
    const authorization = await authorizeMessage(message);
    if (!authorization.allowed) {
      const errorId = newErrorId();
      await state.finish(message.msgId, "failed", { errorId, phase: "host" }).catch(() => undefined);
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
      if (!(await state.enqueue(message))) return "duplicate";

      const queued = groupTails.has(message.groupId);
      try {
        await reply(queued ? "ThreadFerry 已收到，当前群有任务处理中，已排队。" : "ThreadFerry 已收到，正在分析。", false);
      } catch (error) {
        return fail(message, reply, "ack", error);
      }
      const agentId = authorization.group.agent;
      return serial(message.groupId, () => process(message, reply, agentId, authorization.group.context));
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
