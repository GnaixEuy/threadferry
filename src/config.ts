import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import type { AgentConfig, GroupConfig, RuntimeName, ThreadFerryConfig } from "./types.js";

const USER_ID = /^[A-Za-z0-9_@.-]{1,512}$/;
const RUNTIMES = new Set<RuntimeName>(["codex", "pi"]);

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

function validateAgent(agentId: string, agent: AgentConfig): void {
  const length = [...agentId].length;
  if (length < 1 || length > 64 || agentId !== agentId.trim() || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(agentId)) {
    throw new Error("Agent 名必须是 1-64 个字符，不能以空格开头或结尾，也不能包含控制字符");
  }
  if (!RUNTIMES.has(agent.runtime)) throw new Error(`Agent ${agentId} 的 runtime 仅支持 codex 或 pi`);
  if (agent.model !== undefined && (!agent.model.trim() || agent.model.length > 256 || /[\r\n]/.test(agent.model))) {
    throw new Error(`Agent ${agentId} 的 model 无效`);
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
  agent: AgentConfig,
  userId: string,
  current?: ThreadFerryConfig,
): string {
  if (!USER_ID.test(userId)) throw new Error("企业微信回调 userid 无效");
  validateAgent(agentId, agent);
  const existing = current?.groups[groupId];
  if (existing && existing.agent !== agentId) {
    throw new Error("该群已绑定其他 Agent；请通过 Owner 私聊命令切换，不会自动改写");
  }
  const configuredAgent = current?.agents[agentId];
  if (configuredAgent && (configuredAgent.workspace !== agent.workspace
    || configuredAgent.runtime !== agent.runtime || configuredAgent.model !== agent.model)) {
    throw new Error(`Agent ${agentId} 已存在且配置不同；请使用 threadferry agent add 新名称`);
  }
  const agents = { ...(current?.agents ?? {}), [agentId]: agent };
  const groups = Object.fromEntries(Object.entries(current?.groups ?? {}).map(([id, group]) => [id, {
    agent: group.agent,
    allow_users: group.allowUsers,
  }]));
  groups[groupId] = {
    agent: agentId,
    allow_users: [...new Set([...(existing?.allowUsers ?? []), current?.ownerUser ?? userId])],
  };
  return stringify({ version: 5, owner_user: current?.ownerUser ?? userId, agents, groups });
}

export function configText(config: ThreadFerryConfig): string {
  const agents = Object.fromEntries(Object.entries(config.agents).map(([id, agent]) => [id, {
    runtime: agent.runtime,
    workspace: agent.workspace,
    ...(agent.model ? { model: agent.model } : {}),
  }]));
  const groups = Object.fromEntries(Object.entries(config.groups).map(([id, group]) => [id, {
    agent: group.agent,
    allow_users: group.allowUsers,
  }]));
  return stringify({ version: 5, owner_user: config.ownerUser, agents, groups });
}

export function addAgent(config: ThreadFerryConfig, agentId: string, agent: AgentConfig): ThreadFerryConfig {
  validateAgent(agentId, agent);
  if (config.agents[agentId]) throw new Error(`Agent ${agentId} 已存在`);
  return { ...config, agents: { ...config.agents, [agentId]: agent } };
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

export async function loadConfig(path: string): Promise<ThreadFerryConfig> {
  let document: unknown;
  try {
    document = parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取配置 ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const root = object(document, "配置");
  if (root.version !== 5) throw new Error("配置 version 必须为 5；旧版配置不再兼容，请重新运行 threadferry setup");
  const unsupportedRootKeys = Object.keys(root).filter((key) => !["version", "owner_user", "agents", "groups"].includes(key));
  if (unsupportedRootKeys.length > 0) throw new Error(`配置包含不支持字段: ${unsupportedRootKeys.join(", ")}`);
  if (typeof root.owner_user !== "string" || !USER_ID.test(root.owner_user)) throw new Error("配置缺少有效的 owner_user");
  const rawAgents = object(root.agents, "agents");
  if (Object.keys(rawAgents).length === 0) throw new Error("至少需要配置一个 Agent");
  const agents: Record<string, AgentConfig> = {};
  for (const [agentId, value] of Object.entries(rawAgents)) {
    const agent = object(value, `Agent ${agentId}`);
    const unsupportedAgentKeys = Object.keys(agent).filter((key) => !["runtime", "workspace", "model"].includes(key));
    if (unsupportedAgentKeys.length > 0) throw new Error(`Agent ${agentId} 包含不支持字段: ${unsupportedAgentKeys.join(", ")}`);
    if (typeof agent.runtime !== "string" || typeof agent.workspace !== "string") {
      throw new Error(`Agent ${agentId} 缺少 runtime 或 workspace`);
    }
    const configured: AgentConfig = {
      runtime: agent.runtime as RuntimeName,
      workspace: await resolveWorkspace(agent.workspace),
      ...(typeof agent.model === "string" ? { model: agent.model } : {}),
    };
    if (agent.model !== undefined && typeof agent.model !== "string") throw new Error(`Agent ${agentId} 的 model 必须是字符串`);
    validateAgent(agentId, configured);
    agents[agentId] = configured;
  }

  const rawGroups = object(root.groups, "groups");
  if (Object.keys(rawGroups).length === 0) throw new Error("至少需要配置一个企业微信群");

  const groups: Record<string, GroupConfig> = {};
  for (const [groupId, value] of Object.entries(rawGroups)) {
    const group = object(value, `群 ${groupId}`);
    const unsupportedGroupKeys = Object.keys(group).filter((key) => !["agent", "allow_users"].includes(key));
    if (unsupportedGroupKeys.length > 0) throw new Error(`群 ${groupId} 包含不支持字段: ${unsupportedGroupKeys.join(", ")}`);
    if (typeof group.agent !== "string" || !agents[group.agent]) throw new Error(`群 ${groupId} 引用了不存在的 Agent`);
    if (!Array.isArray(group.allow_users) || !group.allow_users.every((user) => typeof user === "string" && USER_ID.test(user))) {
      throw new Error(`群 ${groupId} 的 allow_users 必须是非空字符串数组`);
    }
    if (group.allow_users.length === 0) throw new Error(`群 ${groupId} 的 allow_users 不能为空`);
    if (group.allow_users.length > 256) throw new Error(`群 ${groupId} 的 allow_users 超过 256 人上限`);
    if (!group.allow_users.includes(root.owner_user)) throw new Error(`群 ${groupId} 的 allow_users 必须包含机器人 owner_user`);
    groups[groupId] = {
      agent: group.agent,
      allowUsers: [...new Set(group.allow_users as string[])],
      context: { lookbackHours: 6, maxMessages: 80 },
    };
  }

  return { version: 5, ownerUser: root.owner_user, agents, groups, security: { requireMention: true, readOnly: true } };
}
