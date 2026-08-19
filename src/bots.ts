import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { loadWecomCliCredentials } from "./wecom-credentials.js";

// 一个 Agent 对应一个企业微信机器人（严格 1:1），所以本模块里的 name 参数就是 agentId，
// 没有独立的「机器人名」概念。agentId 会拼进凭据目录路径，因此必须目录安全：
// 允许中文、空格等常见字符，但挡掉路径分隔符、控制字符、`.`/`..` 和超长。
const MAX_AGENT_ID = 128;
const BANNED = /[\u0000-\u001f\u007f/\\]/;

export function validateAgentId(name: string): string {
  if (name.length === 0) throw new Error("Agent 名无效：不能为空");
  if (name.length > MAX_AGENT_ID) throw new Error(`Agent 名无效：过长（最多 ${MAX_AGENT_ID} 个字符）`);
  if (name === "." || name === "..") throw new Error(`Agent 名「${name}」无效：不能是 . 或 ..`);
  if (name.trim() !== name) throw new Error(`Agent 名「${name}」无效：不能以空格开头或结尾`);
  if (BANNED.test(name)) throw new Error(`Agent 名「${name}」无效：不能包含路径分隔符或控制字符`);
  return name;
}

// wecom-cli 没有 profile 概念，但认 WECOM_CLI_CONFIG_DIR，所以每个 Agent 一个独立目录。
// 配置文件里只记目录：Secret 始终留在 wecom-cli 的加密存储里，ThreadFerry 既不落盘，
// 也不写入环境变量。
export function botConfigDir(name: string, override?: string): string {
  validateAgentId(name);
  if (override !== undefined) {
    if (!isAbsolute(override)) throw new Error(`Agent ${name} 的 config_dir 必须是绝对路径`);
    return override;
  }
  return join(homedir(), ".threadferry", "wecom", name);
}

// 注入给 wecom-cli 子进程的环境。只覆盖 config dir，其余继承父进程。
export function wecomEnv(configDir: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...base, WECOM_CLI_CONFIG_DIR: configDir };
}

export interface BotCredentials {
  botId: string;
  secret: string;
  configDir: string;
}

export async function loadBotCredentials(name: string, override?: string): Promise<BotCredentials | undefined> {
  const configDir = botConfigDir(name, override);
  const saved = await loadWecomCliCredentials(configDir);
  return saved ? { ...saved, configDir } : undefined;
}

export interface BotStatus {
  name: string;
  configDir: string;
  authorized: boolean;
  botId?: string;
}

export async function botStatus(name: string, override?: string): Promise<BotStatus> {
  const configDir = botConfigDir(name, override);
  const credentials = await loadBotCredentials(name, override);
  return {
    name,
    configDir,
    authorized: Boolean(credentials),
    ...(credentials ? { botId: credentials.botId } : {}),
  };
}

export function authorizeHint(name: string, override?: string): string {
  return [
    `Agent ${name} 还没有机器人凭据。请执行：`,
    `  threadferry agent login ${name}`,
    `或手动：WECOM_CLI_CONFIG_DIR=${botConfigDir(name, override)} wecom-cli auth init`,
  ].join("\n");
}
