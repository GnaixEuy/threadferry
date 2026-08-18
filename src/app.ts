import { createHash, randomBytes } from "node:crypto";
import { authorize } from "./authorization.js";
import { buildContext } from "./context-builder.js";
import { newErrorId, WardenState, type FailurePhase } from "./state.js";
import type { DirectoryUser, GroupMessage, IncomingDirectMessage, IncomingMention, Reply, RuntimeResult, WardenConfig } from "./types.js";

export type HandleResult = "handled" | "stale" | "failed" | "command" | "delivery_pending" | "duplicate" | "unauthorized_group" | "missing_mention" | "unauthorized_user";

export interface AppDependencies {
  history: (groupId: string, options: { lookbackHours: number; maxMessages: number; endTime: Date }) => Promise<GroupMessage[]>;
  runtime: (request: { workspace: string; prompt: string; sessionId?: string; signal?: AbortSignal }) => Promise<RuntimeResult>;
  updateAllowUsers?: (groupId: string, users: string[]) => Promise<void>;
  listGroups?: () => Promise<Array<{ id: string; name?: string }>>;
  searchUsers?: (keywords: string[]) => Promise<DirectoryUser[]>;
  onError?: (error: { errorId: string; phase: FailurePhase }) => void;
}

type ManagementCommand = "help" | "whoami" | "groups" | "users" | "invite" | "join" | "add" | "remove";
const USER_ID = /^[A-Za-z0-9_@.-]{1,512}$/;

function managementCommand(text: string): { name: ManagementCommand; arguments: string[] } | undefined {
  const match = text.match(/(?:^|[\s@])warden\s+(help|whoami|groups|users|invite|join|add|remove)(?:\s+(.+?))?\s*$/i);
  if (!match) return undefined;
  return { name: match[1]!.toLowerCase() as ManagementCommand, arguments: match[2]?.trim().split(/\s+/) ?? [] };
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

export function createApp(config: WardenConfig, dependencies: AppDependencies, state = new WardenState()) {
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
      if (!users.includes(config.ownerUser)) throw new Error("不能移除 Warden Owner");
      if (users.length > 256) throw new Error("可使用用户已达到 256 人上限");
      await dependencies.updateAllowUsers(groupId, users);
      group.allowUsers = users;
      return users;
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
    if (!reference) throw new Error("缺少群名。请先发送 `warden groups` 查看可管理群。");
    const sessions = await groupSessions();
    const matches = sessions.filter((session) => session.name === reference);
    const configured = matches.filter((session) => config.groups[session.id]);
    if (configured.length === 1) return configured[0]!;
    if (configured.length > 1) {
      throw new Error(`有多个同名群“${reference}”，请改用群 ID：\n${configured.map((group) => `- \`${group.id}\``).join("\n")}`);
    }
    if (matches.length > 0) throw new Error(`群“${reference}”尚未配置 Workspace，请先运行 warden setup。`);
    throw new Error(`没有找到已配置群“${reference}”。请先发送 \`warden groups\`。`);
  }

  async function resolveGroupAndUser(arguments_: string[]): Promise<{ group: { id: string; name?: string }; userReference: string }> {
    if (arguments_.length < 2) throw new Error("缺少群名或用户姓名。");
    if (config.groups[arguments_[0]!]) {
      return { group: { id: arguments_[0]! }, userReference: arguments_.slice(1).join(" ") };
    }
    const input = arguments_.join(" ");
    const sessions = (await groupSessions())
      .filter((session) => session.name && input.startsWith(`${session.name} `))
      .sort((left, right) => right.name!.length - left.name!.length);
    if (sessions.length === 0) throw new Error("没有识别出群名。请先发送 `warden groups`，也可以改用群 ID。");
    const longest = sessions[0]!.name!;
    const matches = sessions.filter((session) => session.name === longest && config.groups[session.id]);
    if (matches.length > 1) {
      throw new Error(`有多个同名群“${longest}”，请改用群 ID：\n${matches.map((group) => `- \`${group.id}\``).join("\n")}`);
    }
    if (matches.length === 0) throw new Error(`群“${longest}”尚未配置 Workspace，请先运行 warden setup。`);
    return { group: matches[0]!, userReference: input.slice(longest.length).trim() };
  }

  async function resolveUser(reference: string): Promise<DirectoryUser> {
    if (reference.startsWith("id:")) {
      const id = reference.slice(3);
      if (!USER_ID.test(id)) throw new Error("userid 无效。");
      return { id, name: id };
    }
    if (!reference || !dependencies.searchUsers) throw new Error("当前启动方式不支持按姓名查询用户。");
    let users: DirectoryUser[];
    try {
      users = await dependencies.searchUsers([reference]);
    } catch {
      throw new Error("企业微信通讯录查询失败。请检查 wecom-cli 授权，或使用 `id:<userid>`。");
    }
    const normalized = reference.toLocaleLowerCase();
    const exact = users.filter((user) => user.name.toLocaleLowerCase() === normalized || user.alias?.toLocaleLowerCase() === normalized);
    const matches = exact.length > 0 ? exact : users;
    if (matches.length === 1) return matches[0]!;
    if (matches.length === 0) throw new Error(`通讯录中没有找到“${reference}”。也可以使用 \`id:<userid>\`。`);
    const choices = matches.slice(0, 10).map((user) => {
      const department = user.departments?.length ? `，${user.departments.join(" / ")}` : "";
      return `- ${user.name}${user.alias ? `（${user.alias}）` : ""}${department}：\`id:${user.id}\``;
    });
    throw new Error(`找到多个“${reference}”，请使用对应的 id 重新发送：\n${choices.join("\n")}`);
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
      return respond(reply, `授权成功。你现在可以在群 \`${invite.groupId}\` 使用 Warden。`);
    } catch {
      const errorId = newErrorId();
      dependencies.onError?.({ errorId, phase: "host" });
      return respond(reply, `权限更新失败（错误编号 ${errorId}）。请联系机器人 Owner。`);
    }
  }

  async function handleDirect(message: IncomingDirectMessage, reply: Reply): Promise<HandleResult> {
    if (!(await state.claimCommand(message.msgId, `direct:${message.senderId}`))) return "duplicate";
    const command = managementCommand(message.text);
    if (!command) return respond(reply, "Warden 私聊仅用于机器人管理。发送 `warden help` 查看命令。");
    if (command.name === "whoami") return respond(reply, `你的 Warden userid：\`${message.senderId}\``);
    if (command.name === "join") return join(message.senderId, command.arguments[0], reply);
    if (message.senderId !== config.ownerUser) return respond(reply, "只有机器人创建者（Warden Owner）可以在私聊中管理群权限。");
    if (command.name === "help") {
      return respond(reply, "Warden 私聊管理命令：\n- `warden groups` 查看机器人所在群\n- `warden users <群名>` 查看可使用用户\n- `warden invite <群名>` 生成一次性邀请码\n- `warden add <群名> <姓名>` 直接授权\n- `warden remove <群名> <姓名>` 移除授权\n- `warden whoami` 查看自己的 userid\n\n群或成员重名时，按机器人返回的 ID 重新发送即可。");
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
        return `- ${configured ? "[已配置]" : "[未配置 Workspace]"} ${session?.name ?? "未获取群名"}\n  \`${id}\``;
      });
      return respond(reply, `机器人最近群会话：\n${lines.length ? lines.join("\n") : "暂无可见群会话"}`);
    }

    let group: { id: string; name?: string };
    let target: { group: { id: string; name?: string }; userReference: string } | undefined;
    try {
      if (command.name === "add" || command.name === "remove") {
        target = await resolveGroupAndUser(command.arguments);
        group = target.group;
      } else {
        group = await resolveGroup(command.arguments.join(" "));
      }
    } catch (error) {
      return respond(reply, error instanceof Error ? error.message : "群名解析失败。");
    }
    const configured = config.groups[group.id]!;
    const groupLabel = group.name ?? group.id;
    if (command.name === "users") {
      return respond(reply, `群“${groupLabel}”可使用用户：\n${await formatUsers(configured.allowUsers)}`);
    }
    if (command.name === "invite") {
      for (const [code, item] of invites) if (item.groupId === group.id) invites.delete(code);
      const code = randomBytes(6).toString("hex").toUpperCase();
      invites.set(code, { groupId: group.id, expiresAt: Date.now() + 10 * 60_000 });
      return respond(reply, `群“${groupLabel}”的一次性邀请码：\`${code}\`\n\n目标用户可私聊机器人发送 \`warden join ${code}\`，或在该群发送 \`@机器人 warden join ${code}\`。10 分钟内有效。`);
    }

    let user: DirectoryUser;
    try {
      user = await resolveUser(target!.userReference);
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
        return respond(reply, "不能移除机器人 Warden Owner。");
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
    } catch {
      const errorId = newErrorId();
      dependencies.onError?.({ errorId, phase: "host" });
      return respond(reply, `权限更新失败（错误编号 ${errorId}）。请执行 \`warden status\`。`);
    }
  }

  async function handleGroupCommand(message: IncomingMention, reply: Reply, command: { name: ManagementCommand; arguments: string[] }): Promise<HandleResult> {
    if (!config.groups[message.groupId]) return "unauthorized_group";
    if (!(await state.claimCommand(message.msgId, message.groupId))) return "duplicate";
    if (command.name === "whoami") return respond(reply, `你的 Warden userid：\`${message.senderId}\``);
    if (command.name === "join") return join(message.senderId, command.arguments[0], reply, message.groupId);
    return respond(reply, "机器人权限管理请私聊 Warden，并发送 `warden help` 查看命令。");
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
    } catch {
      const errorId = newErrorId();
      await state.deliveryFailed(deliveryId, errorId).catch(() => undefined);
      dependencies.onError?.({ errorId, phase: "reply" });
      return status === "failed" ? "failed" : "delivery_pending";
    }
  }

  async function fail(message: IncomingMention, reply: Reply, phase: FailurePhase): Promise<HandleResult> {
    const errorId = newErrorId();
    dependencies.onError?.({ errorId, phase });
    const content = "Warden 处理失败（错误编号 " + errorId + "）。请在运行 Warden 的机器上执行 `warden status` 和 `warden doctor`。";
    try {
      return await complete(message, reply, "failed", content, { errorId, phase });
    } catch {
      await state.finish(message.msgId, "failed", { errorId, phase }).catch(() => undefined);
      await reply(content, true).catch(() => undefined);
      return "failed";
    }
  }

  async function process(message: IncomingMention, reply: Reply, workspace: string, context: { lookbackHours: number; maxMessages: number }): Promise<HandleResult> {
    let phase: FailurePhase = "history";
    try {
      if (shuttingDown) throw new Error("Warden 正在停止");
      await state.markRunning(message.msgId);
      const history = await dependencies.history(message.groupId, { ...context, endTime: message.time });
      const fingerprint = historyFingerprint(history, message);
      const prompt = buildContext(history, message, context);
      const sessionId = await state.session(message.groupId, workspace);
      phase = "runtime";
      const controller = new AbortController();
      controllers.set(message.groupId, controller);
      let result: RuntimeResult;
      try {
        result = await dependencies.runtime({ workspace, prompt, ...(sessionId ? { sessionId } : {}), signal: controller.signal });
      } finally {
        if (controllers.get(message.groupId) === controller) controllers.delete(message.groupId);
      }
      if (result.sessionId) await state.setSession(message.groupId, workspace, result.sessionId);

      phase = "freshness";
      const latest = await dependencies.history(message.groupId, { ...context, endTime: new Date() });
      if (historyFingerprint(latest, message) !== fingerprint) {
        return complete(message, reply, "stale", "分析期间群里出现了新消息。为避免发送过期结论，请重新 @机器人。");
      }

      phase = "reply";
      return complete(message, reply, "handled", limitUtf8(result.text));
    } catch {
      return fail(message, reply, phase);
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
    return serial(message.groupId, () => process(message, reply, authorization.group.workspace, authorization.group.context));
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
        await reply(queued ? "Warden 已收到，当前群有任务处理中，已排队。" : "Warden 已收到，正在分析。", false);
      } catch {
        return fail(message, reply, "ack");
      }
      return serial(message.groupId, () => process(message, reply, authorization.group.workspace, authorization.group.context));
    },
    handleDirect,
    replay,
    cancel(groupId: string): boolean {
      const controller = controllers.get(groupId);
      controller?.abort();
      return Boolean(controller);
    },
    async shutdown(): Promise<void> {
      shuttingDown = true;
      for (const controller of controllers.values()) controller.abort();
      await Promise.all([...groupTails.values()]);
    },
  };
}
