import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import type { GroupConfig, WardenConfig } from "./types.js";

const USER_ID = /^[A-Za-z0-9_@.-]{1,512}$/;

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

export function setupConfig(groupId: string, workspace: string, userId: string, current?: WardenConfig): string {
  if (!USER_ID.test(userId)) throw new Error("企业微信回调 userid 无效");
  const existing = current?.groups[groupId];
  if (existing && existing.workspace !== workspace) {
    throw new Error("该群已绑定其他 Workspace；请先明确移除原绑定，不会自动改写");
  }
  if (current && current.ownerUser !== userId) throw new Error("只有机器人 Warden Owner 可以新增群绑定");
  const groups = Object.fromEntries(Object.entries(current?.groups ?? {}).map(([id, group]) => [id, {
    workspace: group.workspace,
    allow_users: group.allowUsers,
  }]));
  groups[groupId] = {
    workspace,
    allow_users: [...new Set([...(existing?.allowUsers ?? []), current?.ownerUser ?? userId])],
  };
  return stringify({ version: 4, owner_user: current?.ownerUser ?? userId, groups });
}

export function configText(config: WardenConfig): string {
  const groups = Object.fromEntries(Object.entries(config.groups).map(([id, group]) => [id, {
    workspace: group.workspace,
    allow_users: group.allowUsers,
  }]));
  return stringify({ version: 4, owner_user: config.ownerUser, groups });
}

export async function saveConfig(path: string, config: WardenConfig): Promise<void> {
  const target = resolve(path);
  const directory = dirname(target);
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Warden 配置文件不能是符号链接");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    if ((await lstat(directory)).isSymbolicLink()) throw new Error("Warden 配置目录不能是符号链接");
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

export async function loadConfig(path: string): Promise<WardenConfig> {
  let document: unknown;
  try {
    document = parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new Error(`无法读取配置 ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }

  const root = object(document, "配置");
  if (root.version !== 4) throw new Error("配置 version 必须为 4；旧版配置不再兼容，请重新运行 warden setup");
  const unsupportedRootKeys = Object.keys(root).filter((key) => !["version", "owner_user", "groups"].includes(key));
  if (unsupportedRootKeys.length > 0) throw new Error(`配置包含不支持字段: ${unsupportedRootKeys.join(", ")}`);
  if (typeof root.owner_user !== "string" || !USER_ID.test(root.owner_user)) throw new Error("配置缺少有效的 owner_user");
  const rawGroups = object(root.groups, "groups");
  if (Object.keys(rawGroups).length === 0) throw new Error("至少需要配置一个企业微信群");

  const groups: Record<string, GroupConfig> = {};
  for (const [groupId, value] of Object.entries(rawGroups)) {
    const group = object(value, `群 ${groupId}`);
    const unsupportedGroupKeys = Object.keys(group).filter((key) => !["workspace", "allow_users"].includes(key));
    if (unsupportedGroupKeys.length > 0) throw new Error(`群 ${groupId} 包含不支持字段: ${unsupportedGroupKeys.join(", ")}`);
    if (typeof group.workspace !== "string") throw new Error(`群 ${groupId} 缺少 workspace`);
    if (!Array.isArray(group.allow_users) || !group.allow_users.every((user) => typeof user === "string" && USER_ID.test(user))) {
      throw new Error(`群 ${groupId} 的 allow_users 必须是非空字符串数组`);
    }
    if (group.allow_users.length === 0) throw new Error(`群 ${groupId} 的 allow_users 不能为空`);
    if (group.allow_users.length > 256) throw new Error(`群 ${groupId} 的 allow_users 超过 256 人上限`);
    if (!group.allow_users.includes(root.owner_user)) throw new Error(`群 ${groupId} 的 allow_users 必须包含机器人 owner_user`);
    groups[groupId] = {
      workspace: await resolveWorkspace(group.workspace),
      runtime: "codex",
      allowUsers: [...new Set(group.allow_users as string[])],
      context: { lookbackHours: 6, maxMessages: 80 },
    };
  }

  return { version: 4, ownerUser: root.owner_user, groups, security: { requireMention: true, readOnly: true } };
}
