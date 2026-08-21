import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { validateAgentId } from "./bots.js";
import { RUNTIME_NAMES } from "./types.js";
import type { AgentConfig, AgentDefinition, AgentView, GroupBinding, GroupConfig, RuntimeName, ThreadFerryConfig } from "./types.js";

const USER_ID = /^[A-Za-z0-9_@.-]{1,512}$/;
const RUNTIMES = new Set<RuntimeName>(RUNTIME_NAMES);

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

export async function resolveWorkspace(input: string): Promise<string> {
  if (!isAbsolute(input)) {
    throw new Error(`Workspace 必须是绝对路径: ${input}`);
  }
  let canonical: string;
  try {
    canonical = await realpath(input);
  } catch {
    throw new Error(`Workspace 不存在: ${input}`);
  }
  if (resolve(input) !== canonical) {
    throw new Error(`Workspace 不允许通过符号链接跳转: ${input}`);
  }
  if (!(await stat(canonical)).isDirectory()) {
    throw new Error(`Workspace 不是目录: ${input}`);
  }
  return canonical;
}

function validateAgent(agentId: string, agent: AgentDefinition): void {
  // agentId 同时是机器人凭据目录名（见 src/bots.ts），因此必须目录安全（允许中文，挡路径穿越）。
  validateAgentId(agentId);
  if (!RUNTIMES.has(agent.runtime)) throw new Error(`Agent ${agentId} 的 runtime 仅支持 ${RUNTIME_NAMES.join("、")}`);
  if (agent.model !== undefined && (!agent.model.trim() || agent.model.length > 256 || /[\r\n]/.test(agent.model))) {
    throw new Error(`Agent ${agentId} 的 model 无效`);
  }
  if (agent.configDir !== undefined && !isAbsolute(agent.configDir)) {
    throw new Error(`Agent ${agentId} 的 config_dir 必须是绝对路径`);
  }
}

export function onboardingDefaults(current: ThreadFerryConfig | undefined, cwd: string): {
  agentId: string;
  runtime: RuntimeName;
  workspace: string;
  model: string | undefined;
} {
  const initial = current ? Object.entries(current.agents)[0] : undefined;
  return {
    agentId: initial?.[0] ?? "default",
    runtime: initial?.[1].runtime ?? "codex",
    workspace: cwd,
    model: initial?.[1].model,
  };
}

export function setupConfig(
  groupId: string,
  agentId: string,
  agent: AgentDefinition,
  userId: string,
  current?: ThreadFerryConfig,
): string {
  if (!USER_ID.test(userId)) throw new Error("企业微信回调 userid 无效");
  validateAgent(agentId, agent);
  const existing = current?.groups[groupId];
  const configuredAgent = current?.agents[agentId];
  if (configuredAgent && (configuredAgent.workspace !== agent.workspace
    || configuredAgent.runtime !== agent.runtime || configuredAgent.model !== agent.model)) {
    throw new Error(`Agent ${agentId} 已存在且配置不同；请使用 threadferry agent add 新名称`);
  }
  const ownerUser = current?.ownerUser ?? userId;
  return configText({
    version: 6,
    ownerUser,
    agents: { ...(current?.agents ?? {}), [agentId]: { ...agent, ownerUser } },
    groups: {
      ...(current?.groups ?? {}),
      [groupId]: {
        // 群里已有的其他 Agent 原样保留：一个群可以同时启用多台机器人。
        agents: {
          ...(existing?.agents ?? {}),
          [agentId]: {
            allowUsers: [...new Set([...(existing?.agents[agentId]?.allowUsers ?? []), ownerUser])],
            ...(existing?.agents[agentId]?.allowAll ? { allowAll: true } : {}),
          },
        },
        context: existing?.context ?? { lookbackHours: 6, maxMessages: 80 },
      },
    },
    security: { requireMention: true, readOnly: true },
  });
}

export function pairConfig(
  agentId: string,
  agent: AgentDefinition,
  userId: string,
  current?: ThreadFerryConfig,
): string {
  if (!USER_ID.test(userId)) throw new Error("企业微信回调 userid 无效");
  validateAgent(agentId, agent);
  const configuredAgent = current?.agents[agentId];
  if (configuredAgent && (configuredAgent.workspace !== agent.workspace
    || configuredAgent.runtime !== agent.runtime || configuredAgent.model !== agent.model)) {
    throw new Error(`Agent ${agentId} 已存在且配置不同；请使用 threadferry agent add 新名称`);
  }
  return configText(adoptOwner({
    version: 6,
    ownerUser: current?.ownerUser ?? userId,
    // 配对确认的就是这个 Agent 机器人下的 Owner；adoptOwner 再把该 Agent 各群的授权名单迁移过去。
    agents: { ...(current?.agents ?? {}), [agentId]: { ...agent, ownerUser: current?.agents[agentId]?.ownerUser ?? userId } },
    groups: current?.groups ?? {},
    security: { requireMention: true, readOnly: true },
  }, agentId, userId));
}

// 换企业或重建机器人后回调 userid 会变。把 Owner 迁移到新 userid，并把各群授权
// 列表里的旧 Owner 一并替换，避免迁移后 Owner 反而不在自己群的可用名单里。
export function adoptOwner(config: ThreadFerryConfig, agentId: string, userId: string): ThreadFerryConfig {
  if (!USER_ID.test(userId)) throw new Error("企业微信回调 userid 无效");
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Agent ${agentId} 未配置`);
  const previousOwner = agent.ownerUser;
  return {
    ...config,
    // 顶层 ownerUser 是过渡期字段；只有主 Agent 换 Owner 时才跟着变。
    ...(config.ownerUser === previousOwner ? { ownerUser: userId } : {}),
    agents: { ...config.agents, [agentId]: { ...agent, ownerUser: userId } },
    groups: Object.fromEntries(Object.entries(config.groups).map(([id, group]) => {
      const access = group.agents[agentId];
      if (!access) return [id, group];
      return [id, {
        ...group,
        agents: {
          ...group.agents,
          [agentId]: {
            ...access,
            allowUsers: [...new Set([...access.allowUsers.map((user) => user === previousOwner ? userId : user), userId])],
          },
        },
      }];
    })),
  };
}

export function configText(config: ThreadFerryConfig): string {
  const groupsByAgent = new Map<string, Record<string, unknown>>();
  for (const [groupId, group] of Object.entries(config.groups)) {
    for (const [agentId, access] of Object.entries(group.agents)) {
      if (!config.agents[agentId]) throw new Error(`群 ${groupId} 引用了不存在的 Agent ${agentId}`);
      const bucket = groupsByAgent.get(agentId) ?? {};
      bucket[groupId] = { allow_users: access.allowUsers, ...(access.allowAll ? { allow_all: true } : {}) };
      groupsByAgent.set(agentId, bucket);
    }
  }
  // v6：Agent 是隔离单元，owner 和群都挂在 Agent 上。运行时暂时仍是单机器人，
  // 因此每个 Agent 写入同一个 owner；loadConfig 会强制这个不变式（见 readV6Document）。
  const agents = Object.fromEntries(Object.entries(config.agents).map(([id, agent]) => [id, {
    runtime: agent.runtime,
    workspace: agent.workspace,
    ...(agent.model ? { model: agent.model } : {}),
    owner_user: agent.ownerUser,
    ...(agent.configDir ? { config_dir: agent.configDir } : {}),
    groups: groupsByAgent.get(id) ?? {},
  }]));
  return stringify({ version: 6, agents });
}

// 新增 Agent 时它的机器人还没授权，无法得知自己企业下的 Owner userid，先继承主 Agent 的。
// 该 Agent 授权后，启动时的身份核对会提示更正（见 confirmOwnerIdentity）。
export function addAgent(config: ThreadFerryConfig, agentId: string, agent: AgentDefinition): ThreadFerryConfig {
  validateAgent(agentId, agent);
  if (config.agents[agentId]) throw new Error(`Agent ${agentId} 已存在`);
  return { ...config, agents: { ...config.agents, [agentId]: { ...agent, ownerUser: config.ownerUser } } };
}

// 每个 Agent 一个「单 Agent 配置视图」。createApp 处理的就是「一个 config + 按群路由」，
// 而单 Agent 视图正好是那个形状，所以运行时可以每个 Agent 起一个 app 实例而不改 app.ts。
// 副作用红利：processDirect 里取「第一个 Agent」由构造保证正确；serial/groupTails/controllers
// 都在各自闭包里，天然按 Agent 隔离。
export function agentView(config: ThreadFerryConfig, agentId: string): AgentView {
  const agent = config.agents[agentId];
  if (!agent) throw new Error(`Agent ${agentId} 未配置`);
  return {
    version: 6,
    ownerUser: agent.ownerUser,
    agents: { [agentId]: agent },
    groups: viewGroups(config, agentId),
    security: config.security,
  };
}

// 只挑出这个 Agent 参与的群，并摊平成「一个群一份授权」——正是 app.ts 一直在处理的形状。
function viewGroups(config: ThreadFerryConfig, agentId: string): Record<string, GroupConfig> {
  const groups: Record<string, GroupConfig> = {};
  for (const [groupId, group] of Object.entries(config.groups)) {
    const access = group.agents[agentId];
    if (!access) continue;
    groups[groupId] = {
      agent: agentId,
      allowUsers: access.allowUsers,
      ...(access.allowAll ? { allowAll: true } : {}),
      context: group.context,
    };
  }
  return groups;
}

// 配置热更新后就地刷新视图，让已经跑起来的 app 立刻看到新配置（与旧的单 app 行为一致）。
// Agent 被删掉时视图清空：该 app 随即拒绝所有群消息，私聊回「当前没有可用 Agent」。
export function refreshAgentView(view: AgentView, latest: ThreadFerryConfig, agentId: string): void {
  const agent = latest.agents[agentId];
  if (!agent) {
    view.agents = {};
    view.groups = {};
    return;
  }
  view.ownerUser = agent.ownerUser;
  view.agents = { [agentId]: agent };
  view.groups = viewGroups(latest, agentId);
}

export async function saveConfig(path: string, config: ThreadFerryConfig): Promise<void> {
  const target = resolve(path);
  const directory = dirname(target);
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("ThreadFerry 配置文件不能是符号链接");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("ThreadFerry 配置目录不能是符号链接");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, configText(config), { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await rm(temporary, { force: true });
  }
}

// readV6Document 只做结构校验和字段白名单，并把「群挂在 Agent 下」摊平成扁平形态，
// 之后由 loadConfig 做语义校验（workspace 解析、userid 格式、allow_users 不变式）。
// 内存结构仍是扁平的（顶层 ownerUser + 带 agent 字段的 groups），Phase 1b 才会改。
interface FlatAgentRaw { runtime: unknown; workspace: unknown; owner_user: unknown; model?: unknown; config_dir?: unknown }
interface FlatGroupRaw { id: string; agent: string; allow_users: unknown; allow_all?: unknown }
interface FlatDocument { agents: Record<string, FlatAgentRaw>; groups: FlatGroupRaw[] }

function rejectExtraKeys(actual: Record<string, unknown>, allowed: string[], label: string): void {
  const extra = Object.keys(actual).filter((key) => !allowed.includes(key));
  if (extra.length > 0) throw new Error(`${label}包含不支持字段: ${extra.join(", ")}`);
}

function readV6Document(root: Record<string, unknown>): FlatDocument {
  rejectExtraKeys(root, ["version", "agents"], "配置");
  const agents: Record<string, FlatAgentRaw> = {};
  // 一个群可以在多个 Agent 下各出现一次（群里有几台机器人就几次），所以这里是列表不是字典。
  const groups: FlatGroupRaw[] = [];
  for (const [agentId, value] of Object.entries(object(root.agents, "agents"))) {
    const agent = object(value, `Agent ${agentId}`);
    rejectExtraKeys(agent, ["runtime", "workspace", "model", "owner_user", "config_dir", "groups"], `Agent ${agentId} `);
    if (typeof agent.owner_user !== "string" || !USER_ID.test(agent.owner_user)) {
      throw new Error(`Agent ${agentId} 缺少有效的 owner_user`);
    }
    agents[agentId] = {
      runtime: agent.runtime,
      workspace: agent.workspace,
      owner_user: agent.owner_user,
      ...(agent.model !== undefined ? { model: agent.model } : {}),
      ...(agent.config_dir !== undefined ? { config_dir: agent.config_dir } : {}),
    };
    for (const [groupId, groupValue] of Object.entries(object(agent.groups ?? {}, `Agent ${agentId} 的 groups`))) {
      const group = object(groupValue, `群 ${groupId}`);
      rejectExtraKeys(group, ["allow_users", "allow_all"], `群 ${groupId} `);
      groups.push({
        id: groupId,
        agent: agentId,
        allow_users: group.allow_users,
        ...(group.allow_all !== undefined ? { allow_all: group.allow_all } : {}),
      });
    }
  }
  return { agents, groups };
}

export async function loadConfig(path: string): Promise<ThreadFerryConfig> {
  let document: unknown;
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    // 配置不存在是「还没初始化」，不是读文件出错——直接给出下一步，不要抛裸 ENOENT。
    if ((error as { code?: string }).code === "ENOENT") {
      throw new Error(`配置不存在: ${path}\n请先运行 threadferry onboard 完成引导配置。`);
    }
    throw new Error(`无法读取配置 ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    document = parse(raw);
  } catch (error) {
    throw new Error(`配置 ${path} 不是有效 YAML: ${error instanceof Error ? error.message : String(error)}`);
  }

  const root = object(document, "配置");
  if (root.version !== 6) throw new Error("配置 version 必须为 6");
  const flat = readV6Document(root);

  if (Object.keys(flat.agents).length === 0) throw new Error("至少需要配置一个 Agent");

  const agents: Record<string, AgentConfig> = {};
  for (const [agentId, agent] of Object.entries(flat.agents)) {
    if (typeof agent.runtime !== "string" || typeof agent.workspace !== "string") {
      throw new Error(`Agent ${agentId} 缺少 runtime 或 workspace`);
    }
    if (agent.model !== undefined && typeof agent.model !== "string") throw new Error(`Agent ${agentId} 的 model 必须是字符串`);
    if (agent.config_dir !== undefined && (typeof agent.config_dir !== "string" || !isAbsolute(agent.config_dir))) {
      throw new Error(`Agent ${agentId} 的 config_dir 必须是绝对路径`);
    }
    const configured: AgentConfig = {
      runtime: agent.runtime as RuntimeName,
      workspace: await resolveWorkspace(agent.workspace),
      ownerUser: agent.owner_user as string,
      ...(typeof agent.model === "string" ? { model: agent.model } : {}),
      ...(typeof agent.config_dir === "string" ? { configDir: agent.config_dir } : {}),
    };
    validateAgent(agentId, configured);
    agents[agentId] = configured;
  }

  const groups: Record<string, GroupBinding> = {};
  for (const group of flat.groups) {
    const groupId = group.id;
    const label = `群 ${groupId}（Agent ${group.agent}）`;
    if (!agents[group.agent]) throw new Error(`群 ${groupId} 引用了不存在的 Agent`);
    if (group.allow_all !== undefined && typeof group.allow_all !== "boolean") throw new Error(`${label} 的 allow_all 必须是布尔值`);
    if (!Array.isArray(group.allow_users) || !group.allow_users.every((user) => typeof user === "string" && USER_ID.test(user))) {
      throw new Error(`${label} 的 allow_users 必须是非空字符串数组`);
    }
    if (group.allow_users.length === 0) throw new Error(`${label} 的 allow_users 不能为空`);
    if (group.allow_users.length > 256) throw new Error(`${label} 的 allow_users 超过 256 人上限`);
    const groupOwner = agents[group.agent]!.ownerUser;
    if (!group.allow_users.includes(groupOwner)) throw new Error(`${label} 的 allow_users 必须包含该 Agent 的 owner_user`);
    const binding = groups[groupId] ?? { agents: {}, context: { lookbackHours: 6, maxMessages: 80 } };
    binding.agents[group.agent] = {
      allowUsers: [...new Set(group.allow_users as string[])],
      ...(group.allow_all === true ? { allowAll: true } : {}),
    };
    groups[groupId] = binding;
  }

  const primary = agents.default ? "default" : Object.keys(agents)[0]!;
  return {
    version: 6,
    // 过渡期字段：等于主 Agent 的 Owner。管理台和 CLI 的旧路径还在读它，
    // Phase 6 把管理台改成按 Agent 组织后删除。权威来源是 agents[id].ownerUser。
    ownerUser: agents[primary]!.ownerUser,
    agents,
    groups,
    security: { requireMention: true, readOnly: true },
  };
}
