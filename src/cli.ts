#!/usr/bin/env node
import spawn from "cross-spawn";
import { randomBytes } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createApp } from "./app.js";
import { AgentOriginCache } from "./agent-origin.js";
import { startAdminServer, type BotAuthorization, type ConfigUpdater } from "./admin.js";
import { DirectoryNameCache } from "./directory-names.js";
import { fanOutTargets, quotedReply } from "./group-fanout.js";
import { authorizeHint, botConfigDir, botStatus, loadBotCredentials, validateAgentId, wecomEnv, type BotCredentials } from "./bots.js";
import type { WSClient } from "@wecom/aibot-node-sdk";
import { listWecomGroups, pushWecomMessage, runWecomAction, searchWecomUsers, sendWecomReply, startWecomChannel, WecomActionUnknownError, wecomFailureReason } from "./channels/wecom.js";
import {
  addAgent,
  adoptOwner,
  agentView,
  ensureGroupAccess,
  loadConfig,
  pairConfig,
  refreshAgentView,
  resolveWorkspace,
  saveConfig,
} from "./config.js";
import { fetchWecomHistory, WecomHistory } from "./history/wecom-cli.js";
import { describeIdentity, fetchWecomIdentity } from "./identity.js";
import { runCommand } from "./process.js";
import { runClaude } from "./runtimes/claude.js";
import { runCodex } from "./runtimes/codex.js";
import { runGrok } from "./runtimes/grok.js";
import { runPi } from "./runtimes/pi.js";
import { acquireHostLock, defaultStatePath, newErrorId, sessionScope, ThreadFerryState } from "./state.js";
import {
  agentDefinitionForPairing,
  agentNameFromBot,
  authAnnouncement,
  DEFAULT_PAIR_TIMEOUT_MS,
  onboardIntro,
  ownerAdoptPrompt,
  pairInstructions,
  resolveSetupPlan,
  waitForPair,
  type SetupPlan,
} from "./setup-wizard.js";
import { isRuntimeName, RUNTIME_NAMES } from "./types.js";
import type { AgentConnectionHealth, AgentView, CommandRunner, GroupMessage, IncomingMention, RuntimeName, RuntimeRequest, RuntimeResult, ThreadFerryConfig } from "./types.js";
import { findUpdate, installUpdate } from "./update.js";
import { installOfficialWecomSkills, officialWecomSkillsInstalled } from "./wecom-skills.js";
import { runWorkflowTick } from "./workflow.js";

const VERSION = "0.32.3";
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const WORKFLOW_INTERVAL_MS = 30_000;
interface DesktopParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}
const USAGE = `ThreadFerry ${VERSION}

Usage:
  threadferry onboard [--config <path>] [--timeout <seconds>]
  threadferry setup [--workspace <absolute-path>] [--agent <name>] [--runtime codex|pi|claude|grok] [--model <id>] [--config <path>] [--timeout <seconds>]
  threadferry agent add --name <name> --runtime codex|pi|claude|grok --workspace <absolute-path> [--model <id>] [--config <path>]
  threadferry agent list [--config <path>]
  threadferry agent login <name> [--config <path>]
  threadferry doctor [--config <path>]
  threadferry skills install
  threadferry status [--config <path>]
  threadferry update
  threadferry session reset --group <group-id> [--config <path>]
  threadferry start [--config <path>] [--admin-port <port>] [--agents <a,b>] [--mock]
`;

function defaultConfigPath(): string {
  return join(homedir(), ".threadferry", "threadferry.yaml");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} 缺少值`);
  return value;
}

function atLeast(output: string, minimum: [number, number, number]): boolean {
  const match = output.match(/\d+\.\d+\.\d+/);
  if (!match) return false;
  const version = match[0].split(".").map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    if (version[index] !== minimum[index]) return (version[index] ?? 0) > minimum[index]!;
  }
  return true;
}

async function applyUpdate(): Promise<string | undefined> {
  const release = await findUpdate(VERSION);
  if (!release) return undefined;
  console.log(`[update] 发现 ThreadFerry ${release.version}，正在升级...`);
  const binary = await installUpdate(release);
  console.log(`[update] 已升级到 ThreadFerry ${release.version}。`);
  return binary;
}

async function autoUpdate(): Promise<string | undefined> {
  if (process.env.THREADFERRY_DESKTOP === "1") return undefined;
  try {
    const binary = await applyUpdate();
    if (!binary) console.log(`[update] 已检查，ThreadFerry ${VERSION} 已是最新版本。`);
    return binary;
  } catch (error) {
    console.error(`[update] 自动更新失败，将继续运行当前版本：${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

// 同一时刻只允许存在一个 readline 接口，原因有两个：
// 1) 嵌套创建第二个接口会让两个接口争抢 stdin，按键被拆分或重复投递；
// 2) wecom-cli auth init 以 stdio:"inherit" 继承 stdin，父进程若还挂着接口，
//    扫码流程的输入会被父进程吃掉。
// 所以每次提问都新建并立刻关闭，绝不跨越子进程或跨越另一次提问存活。
// promptDepth 是守卫：把「静默的输入损坏」变成一次显式报错。
let promptDepth = 0;

async function askLine(question: string): Promise<string> {
  if (promptDepth > 0) throw new Error("内部错误：嵌套读取终端输入会破坏按键投递");
  promptDepth += 1;
  const wasPaused = process.stdin.isPaused();
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await prompt.question(question);
  } finally {
    prompt.close();
    if (wasPaused) process.stdin.pause();
    promptDepth -= 1;
  }
}

async function runUpdated(binary: string, args: string[]): Promise<void> {
  console.log("[update] 正在使用新版本重新启动...");
  await new Promise<void>((done, reject) => {
    const child = spawn(binary, args, { env: process.env, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => child.kill(signal);
    const onInterrupt = () => forward("SIGINT");
    const onTerminate = () => forward("SIGTERM");
    const cleanup = () => {
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onTerminate);
    };
    process.on("SIGINT", onInterrupt);
    process.on("SIGTERM", onTerminate);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanup();
      if (signal) reject(new Error(`新版本被 ${signal} 终止`));
      else if (code !== 0) reject(new Error(`新版本退出码为 ${code ?? "unknown"}`));
      else done();
    });
  });
}

function wecomRunner(configDir: string): CommandRunner {
  return (command, args, options) => runCommand(command, args, { ...options, env: wecomEnv(configDir) });
}

function runtimeName(input: string | undefined): RuntimeName {
  if (input === undefined) return "codex";
  if (isRuntimeName(input)) return input;
  throw new Error(`--runtime 仅支持 ${RUNTIME_NAMES.join("、")}`);
}

function runAgentRuntime(request: RuntimeRequest): Promise<RuntimeResult> {
  switch (request.runtime) {
    case "codex": return runCodex(request);
    case "pi": return runPi(request);
    case "claude": return runClaude(request);
    case "grok": return runGrok(request);
  }
}

function adminPort(input: string | undefined): number {
  if (input === undefined) return 17_638;
  const port = Number(input);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--admin-port 必须是 1-65535 的端口");
  return port;
}

function pairTimeoutMs(input: string | undefined): number | undefined {
  if (input === undefined) return undefined;
  const seconds = Number(input);
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error("--timeout 必须是大于 0 的秒数");
  return Math.round(seconds * 1000);
}

// 已有配置时给「新增 Agent」路径一个不冲突的默认名。
function suggestAgentName(existing: ThreadFerryConfig): string {
  if (!existing.agents.reviewer) return "reviewer";
  let suffix = 2;
  while (existing.agents[`reviewer${suffix}`]) suffix += 1;
  return `reviewer${suffix}`;
}

// 每个 Agent 的机器人凭据都由 wecom-cli 在自己的目录里加密保存（threadferry agent login）。
// ThreadFerry 因此不再提示输入 Bot Secret，也不再把凭据写进环境变量——只在建立连接时读一次。
export interface StartupAgent {
  agentId: string;
  botId: string;
  secret: string;
  configDir: string;
}

// 每个已授权 Agent 都会起一条自己的连接。没有凭据的 Agent 显式报出来后跳过——
// 对齐 larkin 的 agents.filter(a => a.feishuProfile)，不静默忽略。
async function startupAgents(config: ThreadFerryConfig, only?: Set<string>): Promise<StartupAgent[]> {
  if (only) {
    const unknown = [...only].filter((agentId) => !config.agents[agentId]);
    if (unknown.length > 0) {
      throw new Error(`--agents 指定了未配置的 Agent: ${unknown.join(", ")}\n已配置: ${Object.keys(config.agents).join(", ")}`);
    }
  }
  const candidates = Object.entries(config.agents).filter(([agentId]) => !only || only.has(agentId));
  const ready: StartupAgent[] = [];
  for (const [agentId, agent] of candidates) {
    const credentials = await loadBotCredentials(agentId, agent.configDir);
    if (credentials) ready.push({ agentId, ...credentials });
    else console.error(`[bot] 跳过 Agent ${agentId}：没有机器人凭据。执行 threadferry agent login ${agentId} 后可用`);
  }
  if (ready.length === 0) {
    const [first] = candidates[0] ?? [];
    throw new Error(`没有任何待启动的 Agent 拥有机器人凭据。\n${authorizeHint(first ?? "default", first ? config.agents[first]?.configDir : undefined)}`);
  }
  return ready;
}

async function preflightDependencies(runtimes: Set<RuntimeName>): Promise<void> {
  let wecomVersion: string;
  try {
    wecomVersion = (await runCommand("wecom-cli", ["--version"], { timeoutMs: 10_000 })).stdout;
  } catch {
    throw new Error("找不到企业微信官方 wecom-cli 1.2.0+；请安装并加入 PATH");
  }
  if (!atLeast(wecomVersion, [1, 2, 0])) throw new Error("ThreadFerry 要求 wecom-cli 1.2.0+");
  try {
    await runCommand("wecom-cli", ["identity", "whoami", "--json", "{}"], { timeoutMs: 30_000 });
  } catch {
    throw new Error("wecom-cli 尚未授权；请先运行 wecom-cli auth init");
  }
  if (runtimes.has("codex")) {
    let version: string;
    try {
      version = (await runCommand("codex", ["--version"], { timeoutMs: 10_000 })).stdout;
    } catch {
      throw new Error("找不到 Codex CLI 0.138.0+；请安装并运行 codex login");
    }
    if (!atLeast(version, [0, 138, 0])) throw new Error("ThreadFerry 要求 codex-cli 0.138.0+");
    try {
      await runCommand("codex", ["login", "status"], { timeoutMs: 10_000 });
    } catch {
      throw new Error("Codex CLI 尚未登录；请先运行 codex login");
    }
  }
  if (runtimes.has("pi")) {
    let version: string;
    try {
      version = (await runCommand("pi", ["--version"], { timeoutMs: 10_000 })).stdout;
    } catch {
      throw new Error("找不到 Pi CLI 0.84.2+；请安装 @earendil-works/pi-coding-agent 并完成模型授权");
    }
    if (!atLeast(version, [0, 84, 2])) throw new Error("ThreadFerry 要求 pi 0.84.2+");
  }
  if (runtimes.has("claude")) {
    let version: string;
    try {
      version = (await runCommand("claude", ["--version"], { timeoutMs: 10_000 })).stdout;
    } catch {
      throw new Error("找不到 Claude Code 2.1.233+；请安装并运行 claude auth login");
    }
    if (!atLeast(version, [2, 1, 233])) throw new Error("ThreadFerry 要求 Claude Code 2.1.233+");
    try {
      await runCommand("claude", ["auth", "status"], { timeoutMs: 10_000 });
    } catch {
      throw new Error("Claude Code 尚未登录；请先运行 claude auth login");
    }
  }
  if (runtimes.has("grok")) {
    let version: string;
    try {
      version = (await runCommand("grok", ["--version"], { timeoutMs: 10_000 })).stdout;
    } catch {
      throw new Error("找不到 Grok Build 1.0.5+；请安装并运行 grok login");
    }
    if (!atLeast(version, [1, 0, 5])) throw new Error("ThreadFerry 要求 Grok Build 1.0.5+");
    try {
      await runCommand("grok", ["models"], { timeoutMs: 30_000 });
    } catch {
      throw new Error("Grok Build 尚未登录；请先运行 grok login");
    }
  }
}

async function preflightReal(config: ThreadFerryConfig, only?: Set<string>): Promise<StartupAgent[]> {
  const agents = await startupAgents(config, only);
  await preflightDependencies(new Set(agents.map(({ agentId }) => config.agents[agentId]!.runtime)));
  return agents;
}

async function setup(configPath: string, options: {
  agentId: string;
  workspace?: string;
  runtime?: RuntimeName;
  model?: string;
  timeoutMs?: number;
}): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("threadferry setup 需要交互式终端确认私聊身份");
  const target = resolve(configPath);
  validateAgentId(options.agentId);
  const existing = existsSync(target) ? await loadConfig(target) : undefined;
  // 显式传入的 --workspace 也要走既有校验（绝对路径、真实目录、非符号链接跳转）。
  const requestedWorkspace = options.workspace === undefined ? undefined : await resolveWorkspace(options.workspace);
  // 已有配置时 --workspace 可以省略：沿用该 Agent 已配置的 Workspace/Runtime/Model。
  const plan = resolveSetupPlan(existing, options.agentId, {
    workspace: requestedWorkspace,
    runtime: options.runtime,
    model: options.model,
  });
  const credentials = await authorizeBot(options.agentId, existing?.agents[options.agentId]?.configDir);
  const adopted = await adoptAuthorizedOwner(target, options.agentId, credentials, plan, existing);
  if (adopted) return;

  await pairOwner(configPath, {
    agentId: options.agentId,
    workspace: plan.workspace,
    runtime: plan.runtime,
    ...(plan.model ? { model: plan.model } : {}),
    timeoutMs: options.timeoutMs,
  });
  console.log(`Agent ${options.agentId} 配对完成（Workspace: ${plan.workspace}，Runtime: ${plan.runtime}）。`);
}

// 授权机器人时扫码的就是机器人创建者：直接读取其身份并认领为该 Agent 的 Owner。
// 终端默认同意（扫码的人就在电脑前）；拒绝后返回 false，由调用方回退到手机配对。
async function adoptAuthorizedOwner(
  target: string,
  agentId: string,
  credentials: BotCredentials,
  plan: SetupPlan,
  existing: ThreadFerryConfig | undefined,
): Promise<boolean> {
  const identity = await fetchWecomIdentity(wecomRunner(credentials.configDir));
  const authorized = identity.user;
  const userId = authorized?.id;
  if (!userId) {
    console.log("未能识别授权用户身份，请通过手机私聊配对指定 Owner。");
    return false;
  }
  const approved = await confirmOwnerAdopt(agentId, authorized);
  if (!approved) {
    console.log("已拒绝自动认领；请通过手机私聊配对指定其他 Owner。");
    return false;
  }
  await writePairedConfig(target, agentId, agentDefinitionForPairing(
    { workspace: plan.workspace, runtime: plan.runtime, ...(plan.model ? { model: plan.model } : {}) },
    existing?.agents[agentId],
  ), userId);
  console.log(`Agent ${agentId} 的 Owner 已设为 ${describeIdentity(authorized)}（本机已确认）。`);
  console.log(`配置已更新: ${target}`);
  return true;
}

// 终端确认将授权用户认领为该 Agent 的 Owner。默认同意（扫码的人就在电脑前）。
async function confirmOwnerAdopt(agentId: string, user: { name?: string; id?: string }): Promise<boolean> {
  const answer = (await askLine(ownerAdoptPrompt(agentId, user))).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

// 把配对的 Agent 写入配置文件（原子写：临时文件 + rename），沿用已有 Agent 的 config_dir。
async function writePairedConfig(target: string, agentId: string, agentDef: { workspace: string; runtime: RuntimeName; model?: string; configDir?: string }, userId: string): Promise<void> {
  const current = existsSync(target) ? await loadConfig(target) : undefined;
  const content = pairConfig(agentId, agentDef, userId, current);
  const directory = dirname(target);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function pairOwner(configPath: string, options: {
  agentId: string;
  workspace: string;
  runtime: RuntimeName;
  model?: string;
  timeoutMs?: number;
}): Promise<void> {
  const target = resolve(configPath);
  const existing = existsSync(target) ? await loadConfig(target) : undefined;
  const credentials = await loadBotCredentials(options.agentId, existing?.agents[options.agentId]?.configDir);
  if (!credentials) throw new Error(`Agent ${options.agentId} 还没有机器人凭据；请先授权再配对`);
  await preflightDependencies(new Set([options.runtime]));
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS;
  const code = randomBytes(8).toString("hex");
  console.log(pairInstructions(options.agentId, code));
  console.log(`配对码在 ${Math.round(timeoutMs / 60_000)} 分钟内有效；等待期间会周期性提示，Ctrl+C 可取消。配置不会保存机器人凭据。`);

  const result = await waitForPair({
    code,
    agentId: options.agentId,
    workspace: options.workspace,
    onLog: (message) => console.log(message),
    confirm: async (senderId) => {
      const answer = (await askLine(`收到 userid ${senderId} 的私聊配对请求，确认为 Agent ${options.agentId} 的 Owner？[y/N]: `)).trim().toLowerCase();
      const approved = answer === "y" || answer === "yes";
      if (!approved) console.log("[setup] 已拒绝本次配对，继续等待其他消息。");
      return approved;
    },
    onApproved: async (senderId) => {
      await writePairedConfig(target, options.agentId, agentDefinitionForPairing(
        { workspace: options.workspace, runtime: options.runtime, ...(options.model ? { model: options.model } : {}) },
        existing?.agents[options.agentId],
      ), senderId);
      console.log(`配置已更新: ${target}`);
    },
    startChannel: (handler) => startWecomChannel(credentials, handler),
    timeoutMs,
  });

  if (result === "timeout") throw new Error(`等待超时：未收到 Agent ${options.agentId} 的私聊配对。请确认机器人已授权后重新执行。`);
  if (result === "cancelled") throw new Error("setup 已取消");
}

const TEMP_CREDENTIAL_PREFIX = "tmp-";

function wecomRoot(): string {
  return join(homedir(), ".threadferry", "wecom");
}

// 清理历史遗留的临时授权目录。onboard 开头调用一次，覆盖以前中断留下的残留。
async function pruneTempCredentials(): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(wecomRoot(), { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(TEMP_CREDENTIAL_PREFIX)) continue;
    try {
      await rm(join(wecomRoot(), entry.name), { recursive: true, force: true });
      removed += 1;
    } catch {
      // 删不掉就跳过，不影响引导本身。
    }
  }
  return removed;
}

async function onboard(configOption?: string, timeoutMs?: number): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("threadferry onboard 需要交互式终端；无人值守环境请使用 setup/start 参数和环境变量");
  }
  const configPath = resolve(configOption ?? defaultConfigPath());
  const existing = existsSync(configPath) ? await loadConfig(configPath) : undefined;

  const pruned = await pruneTempCredentials();
  if (pruned > 0) console.log(`已清理 ${pruned} 个上次中断留下的临时授权目录。`);

  console.log(onboardIntro(Boolean(existing)));

  // 本次引导创建的临时目录；无论成功失败都不留残留。
  const temporaryDirs = new Set<string>();
  try {
    const ask = async (label: string, fallback: string) => {
      const answer = (await askLine(`${label} [${fallback}]: `)).trim();
      return answer || fallback;
    };
    const askModel = async (fallback?: string) => {
      const answer = (await askLine(`模型 ID（留空使用 Runtime 默认）${fallback ? ` [${fallback}]` : ""}: `)).trim();
      return answer || fallback;
    };
    const pickRuntimeWorkspaceModel = async (agentId: string) => {
      const runtime = runtimeName((await ask("Runtime (codex/pi/claude/grok)", existing?.agents[agentId]?.runtime ?? "codex")).toLowerCase());
      const workspace = await resolveWorkspace(await ask("Workspace 绝对路径", existing?.agents[agentId]?.workspace ?? process.cwd()));
      const model = await askModel(existing?.agents[agentId]?.model);
      return { runtime, workspace, ...(model ? { model } : {}) } as Omit<SetupPlan, "reused">;
    };
    // 先扫码授权机器人（凭据暂存到临时目录），再读取机器人名作为默认 Agent 名。
    // 授权或读身份失败时必须删掉临时目录：里面可能有半写入的凭据，留着既是垃圾也是风险。
    const authorizeTemp = async (): Promise<{ tempDir: string; botName?: string }> => {
      const tempDir = join(wecomRoot(), `${TEMP_CREDENTIAL_PREFIX}${randomBytes(6).toString("hex")}`);
      await mkdir(tempDir, { recursive: true, mode: 0o700 });
      temporaryDirs.add(tempDir);
      console.log(authAnnouncement("待授权机器人", tempDir));
      console.log();
      await runAuthInit(tempDir);
      const identity = await fetchWecomIdentity(wecomRunner(tempDir));
      return { tempDir, botName: identity.bot?.name?.trim() };
    };
    const moveCredentials = async (fromDir: string, toDir: string): Promise<void> => {
      if (fromDir === toDir) return;
      await mkdir(dirname(toDir), { recursive: true, mode: 0o700 });
      await rename(fromDir, toDir);
      temporaryDirs.delete(fromDir);
    };
    const proposeName = (botName: string | undefined): string => {
      if (botName) {
        try {
          return validateAgentId(botName);
        } catch {
          // 机器人名不合目录名规则时退回默认名。
        }
      }
      return existing ? suggestAgentName(existing) : "default";
    };
    // Agent 名直接取自机器人名：1:1 架构下两者本就该一致，避免用户手敲出和机器人对不上的名字。
    const autoName = (botName: string | undefined): string | undefined =>
      agentNameFromBot(botName, Object.keys(existing?.agents ?? {}));
    const nameFromBot = async (botName: string | undefined, label: string): Promise<string> => {
      const auto = autoName(botName);
      if (auto) {
        console.log(`${label}名: ${auto}（取自机器人名）`);
        return auto;
      }
      return await ask(`${label}名（机器人名不可用，请手动指定）`, proposeName(botName));
    };

    if (existing && Object.keys(existing.agents).length > 0) {
      const choice = (await askLine(
        `已有配置，Agent：${Object.keys(existing.agents).join(", ")}。要做什么？
  1) 新增一个 Agent + 一个机器人
  2) 为已有 Agent 重新配对 Owner
  3) 取消
请选择 [1/2/3]: `,
      )).trim();
      if (choice === "2") {
        const names = Object.keys(existing.agents);
        const picked = (await askLine(`选择要重新配对的 Agent ${names.join(" / ")} [${names[0]}]: `)).trim();
        const agentId = picked || names[0]!;
        if (!existing.agents[agentId]) throw new Error(`Agent ${agentId} 未配置`);
        console.log("\n[2/6] 授权企业微信机器人（已有凭据则跳过）");
        const credentials = await authorizeBot(agentId, existing.agents[agentId].configDir);
        const plan = resolveSetupPlan(existing, agentId);
        await claimOwner(configPath, agentId, credentials, plan, existing, timeoutMs);
      } else if (choice === "3" || choice.toLowerCase() === "q" || choice.toLowerCase() === "cancel") {
        console.log("已取消。");
        return;
      } else {
        // 新增 Agent：先授权机器人，再用机器人名作 Agent 名（自动，无需输入）。
        console.log("\n[2/6] 授权企业微信机器人（扫码）");
        const { tempDir, botName } = await authorizeTemp();
        const agentId = await nameFromBot(botName, "新 Agent");
        validateAgentId(agentId);
        await moveCredentials(tempDir, botConfigDir(agentId));
        const credentials = await loadBotCredentials(agentId, botConfigDir(agentId));
        if (!credentials) throw new Error(authorizeHint(agentId));
        const plan = { ...(await pickRuntimeWorkspaceModel(agentId)), reused: false };
        await claimOwner(configPath, agentId, credentials, plan, existing, timeoutMs);
      }
    } else {
      // 首次配置：先授权机器人，再用机器人名作 Agent 名（自动，无需输入）。
      console.log("\n[2/6] 授权企业微信机器人（扫码）");
      const { tempDir, botName } = await authorizeTemp();
      const agentId = await nameFromBot(botName, "Agent");
      validateAgentId(agentId);
      await moveCredentials(tempDir, botConfigDir(agentId));
      const credentials = await loadBotCredentials(agentId, botConfigDir(agentId));
      if (!credentials) throw new Error(authorizeHint(agentId));
      const plan = { ...(await pickRuntimeWorkspaceModel(agentId)), reused: false };
      await claimOwner(configPath, agentId, credentials, plan, existing, timeoutMs);
    }
  } finally {
    for (const dir of temporaryDirs) await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    temporaryDirs.clear();
  }

  console.log("\n[4/6] 安装企业微信官方 Skill");
  await installOfficialWecomSkills();
  console.log("官方企业微信 Skill 已安装或更新到 ~/.agents/skills。");

  console.log("\n[5/6] 运行环境诊断");
  if (!(await doctor(configPath))) {
    console.error(
      "\n[error] 环境诊断未通过。请根据上面的 [error] 条目修复问题。\n" +
      "修复后重新运行 threadferry onboard 即可（它会复用已有配置和配对），也可以直接运行 threadferry start。",
    );
    throw new Error(`环境诊断未通过；修复后运行 threadferry doctor --config ${configPath} 复查。`);
  }

  console.log("\n[6/6] 启动 ThreadFerry");
  const startAnswer = (await askLine("现在启动并保持当前终端运行？[Y/n]: ")).trim().toLowerCase();
  const shouldStart = startAnswer === "" || startAnswer === "y" || startAnswer === "yes";
  if (shouldStart) {
    const updatedBinary = await start(configPath, false, 17_638);
    if (updatedBinary) await runUpdated(updatedBinary, ["start", "--config", configPath]);
  }
  else console.log(`配置完成。稍后运行: threadferry start --config ${configPath}`);
}

// 认领 Owner：默认直接采用授权用户（终端确认），拒绝时回退到手机配对。
async function claimOwner(configPath: string, agentId: string, credentials: BotCredentials, plan: SetupPlan, existing: ThreadFerryConfig | undefined, timeoutMs?: number): Promise<void> {
  console.log("\n[3/6] 认领 Owner（默认使用授权用户，也可手机配对指定）");
  const adopted = await adoptAuthorizedOwner(configPath, agentId, credentials, plan, existing);
  if (!adopted) {
    await pairOwner(configPath, { agentId, workspace: plan.workspace, runtime: plan.runtime, ...(plan.model ? { model: plan.model } : {}), timeoutMs });
  }
}

// 运行 wecom-cli auth init 扫码授权，凭据写入指定目录（由 WECOM_CLI_CONFIG_DIR 决定）。
async function runAuthInit(configDir: string): Promise<void> {
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("wecom-cli", ["auth", "init"], { stdio: "inherit", env: wecomEnv(configDir), shell: false });
    child.on("error", (error) => reject(new Error(`无法启动 wecom-cli: ${error.message}`)));
    child.on("close", resolve);
  });
  if (code !== 0) throw new Error(`wecom-cli auth init 未成功（退出码 ${code ?? "unknown"}）`);
}

async function doctor(configPath?: string): Promise<boolean> {
  const checks: Array<{ ok: boolean; message: string }> = [];
  let loadedConfig: ThreadFerryConfig | undefined;
  let configuredRuntimes = new Set<RuntimeName>(["codex"]);
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ ok: major >= 22, message: major >= 22 ? `Node ${process.version}` : `Node ${process.version}；请安装 Node.js 22+ LTS` });
  const skillsInstalled = await officialWecomSkillsInstalled();
  checks.push({
    ok: skillsInstalled,
    message: skillsInstalled ? "企业微信官方 Skill 已安装且来源已验证" : "企业微信官方 Skill 未完整安装或来源无法验证；请执行 threadferry skills install",
  });

  const chosenConfig = resolve(configPath ?? defaultConfigPath());
  if (!existsSync(chosenConfig)) {
    checks.push({ ok: false, message: `配置不存在: ${chosenConfig}；请先运行 threadferry onboard` });
  } else {
    try {
      loadedConfig = await loadConfig(chosenConfig);
      configuredRuntimes = new Set(Object.values(loadedConfig.agents).map((agent) => agent.runtime));
      checks.push({ ok: true, message: `配置有效：${Object.keys(loadedConfig.agents).length} 个 Agent，${Object.keys(loadedConfig.groups).length} 个群` });
    } catch (error) {
      checks.push({ ok: false, message: error instanceof Error ? error.message : String(error) });
    }
  }

  try {
    const snapshot = await new ThreadFerryState(defaultStatePath()).snapshot();
    checks.push({ ok: true, message: `本地状态存储有效（${snapshot.turns.length} 条执行记录，${snapshot.sessions.length} 个 Session）` });
  } catch {
    checks.push({ ok: false, message: "本地状态存储无效；请检查 ~/.threadferry 的权限和 state-v3.json 格式" });
  }

  // 凭据按 Agent 隔离，逐个报告。值始终不显示。
  let authorizedAgents = 0;
  for (const [agentId, agent] of Object.entries(loadedConfig?.agents ?? {})) {
    const status = await botStatus(agentId, agent.configDir);
    if (status.authorized) authorizedAgents += 1;
    checks.push({
      ok: status.authorized,
      message: status.authorized
        ? `Agent ${agentId} 机器人凭据可用（wecom-cli 加密存储，值未显示）`
        : `Agent ${agentId} 缺少机器人凭据；请执行 threadferry agent login ${agentId}`,
    });
  }

  // 身份和群历史都必须用该 Agent 自己的凭据目录来查；用默认目录会检查到别的机器人。
  let probeAgent: string | undefined;
  for (const [agentId, agent] of Object.entries(loadedConfig?.agents ?? {})) {
    if (await loadBotCredentials(agentId, agent.configDir)) { probeAgent = agentId; break; }
  }
  const probeRunner = probeAgent
    ? wecomRunner(botConfigDir(probeAgent, loadedConfig?.agents[probeAgent]?.configDir))
    : undefined;

  let wecomAuthorized = false;
  try {
    const { stdout } = await runCommand("wecom-cli", ["--version"], { timeoutMs: 10_000 });
    const supported = atLeast(stdout, [1, 2, 0]);
    checks.push({ ok: supported, message: supported ? stdout.trim() : `${stdout.trim()}；ThreadFerry 要求 1.2.0+` });
    if (probeRunner && probeAgent) {
      try {
        await probeRunner("wecom-cli", ["identity", "whoami", "--json", "{}"], { timeoutMs: 30_000 });
        wecomAuthorized = true;
        checks.push({ ok: true, message: `Agent ${probeAgent} 的机器人身份授权有效（详情未显示）` });
      } catch {
        checks.push({ ok: false, message: `Agent ${probeAgent} 的机器人身份检查失败；请重新执行 threadferry agent login ${probeAgent}` });
      }
    }
  } catch {
    checks.push({ ok: false, message: "找不到 wecom-cli；请安装企业微信官方 wecom-cli 1.2.0+ 并加入 PATH" });
  }

  const probeGroup = probeAgent
    && Object.entries(loadedConfig?.groups ?? {}).find(([, group]) => group.agents[probeAgent])?.[0];
  if (wecomAuthorized && probeGroup && probeRunner) {
    try {
      await fetchWecomHistory(probeGroup, { lookbackHours: 1 / 60, maxMessages: 1, endTime: new Date() }, probeRunner);
      checks.push({ ok: true, message: "企业微信群消息历史权限有效" });
    } catch (error) {
      checks.push({ ok: false, message: error instanceof Error ? error.message : "企业微信群消息历史检查失败" });
    }
  }

  if (configuredRuntimes.has("codex")) {
    try {
      const { stdout } = await runCommand("codex", ["--version"], { timeoutMs: 10_000 });
      const supported = atLeast(stdout, [0, 138, 0]);
      checks.push({ ok: supported, message: supported ? stdout.trim() : `${stdout.trim()}；ThreadFerry 要求 0.138.0+` });
      try {
        await runCommand("codex", ["login", "status"], { timeoutMs: 10_000 });
        checks.push({ ok: true, message: "Codex CLI 登录有效（详情未显示）" });
      } catch {
        checks.push({ ok: false, message: "Codex CLI 尚未登录；请先运行 codex login" });
      }
    } catch {
      checks.push({ ok: false, message: "找不到 Codex CLI；请安装并执行 codex login" });
    }
  }
  if (configuredRuntimes.has("pi")) {
    try {
      const { stdout } = await runCommand("pi", ["--version"], { timeoutMs: 10_000 });
      const supported = atLeast(stdout, [0, 84, 2]);
      checks.push({ ok: supported, message: supported ? `pi ${stdout.trim()}` : `${stdout.trim()}；ThreadFerry 要求 pi 0.84.2+` });
    } catch {
      checks.push({ ok: false, message: "找不到 Pi CLI；请安装 @earendil-works/pi-coding-agent 并完成模型授权" });
    }
  }
  if (configuredRuntimes.has("claude")) {
    try {
      const { stdout } = await runCommand("claude", ["--version"], { timeoutMs: 10_000 });
      const supported = atLeast(stdout, [2, 1, 233]);
      checks.push({ ok: supported, message: supported ? stdout.trim() : `${stdout.trim()}；ThreadFerry 要求 Claude Code 2.1.233+` });
      try {
        await runCommand("claude", ["auth", "status"], { timeoutMs: 10_000 });
        checks.push({ ok: true, message: "Claude Code 登录有效（详情未显示）" });
      } catch {
        checks.push({ ok: false, message: "Claude Code 尚未登录；请先运行 claude auth login" });
      }
    } catch {
      checks.push({ ok: false, message: "找不到 Claude Code；请安装并执行 claude auth login" });
    }
  }
  if (configuredRuntimes.has("grok")) {
    try {
      const { stdout } = await runCommand("grok", ["--version"], { timeoutMs: 10_000 });
      const supported = atLeast(stdout, [1, 0, 5]);
      checks.push({ ok: supported, message: supported ? stdout.trim() : `${stdout.trim()}；ThreadFerry 要求 Grok Build 1.0.5+` });
      try {
        await runCommand("grok", ["models"], { timeoutMs: 30_000 });
        checks.push({ ok: true, message: "Grok Build 登录有效（详情未显示）" });
      } catch {
        checks.push({ ok: false, message: "Grok Build 尚未登录；请先运行 grok login" });
      }
    } catch {
      checks.push({ ok: false, message: "找不到 Grok Build；请安装并执行 grok login" });
    }
  }

  for (const check of checks) console.log(`${check.ok ? "[ok]" : "[error]"} ${check.message}`);
  return checks.every((check) => check.ok);
}

async function runMock(config: ThreadFerryConfig): Promise<void> {
  const [groupId, binding] = Object.entries(config.groups)[0]!;
  const agentId = Object.keys(binding.agents)[0]!;
  const agent = config.agents[agentId]!;
  // mock 也走单 Agent 视图，和真实运行时同一条路径。
  const view = agentView(config, agentId);
  const group = view.groups[groupId]!;
  const currentTime = new Date();
  const at = (minutesAgo: number) => new Date(currentTime.getTime() - minutesAgo * 60_000);
  const history: GroupMessage[] = [
    { senderId: "zhangsan", senderName: "张三", time: at(5), text: "这个接口有问题" },
    { senderId: "lisi", senderName: "李四", time: at(4), text: "可能是 Redis" },
    { senderId: "wangwu", senderName: "王五", time: at(3), text: "线上出现三次" },
  ];
  const message: IncomingMention = {
    msgId: "mock-msg-1",
    groupId,
    senderId: group.allowUsers[0]!,
    senderName: "用户",
    time: currentTime,
    text: "@ThreadFerry 帮忙分析",
    mentioned: true,
  };
  const app = createApp(view, {
    history: async () => history,
    runtime: async ({ agentId, runtime, workspace, prompt }) => {
      if (!prompt.includes("张三") || !prompt.includes("李四") || !prompt.includes("王五")) {
        throw new Error("Mock Context Builder 未包含预期消息");
      }
      console.log(`[mock] Agent ${agentId}: ${runtime} workspace=${workspace}`);
      return { text: "Mock 分析完成：接口异常可能与 Redis 有关，且线上已重复出现三次。", sessionId: "mock-session" };
    },
  });
  if (!agent) throw new Error("Mock 群绑定的 Agent 不存在");
  const status = await app.handle(message, async (content) => console.log(`[mock] WeCom reply: ${content}`));
  console.log(`[mock] status: ${status}`);
}

async function status(configPath?: string): Promise<void> {
  const config = await loadConfig(resolve(configPath ?? defaultConfigPath()));
  const snapshot = await new ThreadFerryState(defaultStatePath()).snapshot();
  const counts = new Map<string, number>();
  for (const turn of snapshot.turns) counts.set(turn.status, (counts.get(turn.status) ?? 0) + 1);
  const active = (counts.get("queued") ?? 0) + (counts.get("running") ?? 0);
  const reminders = (snapshot.reminders ?? []).filter((item) => item.status === "scheduled" || item.status === "running").length;
  const workItems = (snapshot.workItems ?? []).filter((item) => item.status !== "completed" && item.status !== "failed").length;
  const lastFailure = snapshot.turns.slice().reverse().find((turn) => turn.status === "failed");
  console.log(`ThreadFerry: ${active > 0 ? `${active} 个任务处理中或排队` : "空闲"}`);
  console.log(`配置 Agent: ${Object.keys(config.agents).length}；群: ${Object.keys(config.groups).length}；Session: ${snapshot.sessions.length}；执行记录: ${snapshot.turns.length}`);
  console.log(`可靠性队列: inbox=${snapshot.inbox.length}, outbox=${snapshot.outbox.length}`);
  console.log(`主动工作: reminders=${reminders}, work=${workItems}`);
  console.log(`结果: handled=${counts.get("handled") ?? 0}, stale=${counts.get("stale") ?? 0}, failed=${counts.get("failed") ?? 0}`);
  if (lastFailure) console.log(`最近失败: ${lastFailure.errorId ?? "无错误编号"} phase=${lastFailure.failurePhase ?? "unknown"} time=${lastFailure.updatedAt}`);
}

async function resetSession(configPath: string | undefined, groupId: string): Promise<void> {
  const lock = await acquireHostLock();
  try {
    const config = await loadConfig(resolve(configPath ?? defaultConfigPath()));
    const group = config.groups[groupId];
    if (!group) throw new Error("指定群未配置");
    // 一个群里可以有多台机器人，每台各有自己的 Session；「重置这个群」就是把它们都清掉。
    const state = new ThreadFerryState(defaultStatePath());
    let removed = 0;
    for (const agentId of Object.keys(group.agents)) {
      const agent = config.agents[agentId];
      if (agent && await state.clearSession(groupId, sessionScope(agentId, agent))) removed += 1;
    }
    console.log(removed > 0 ? `该群 ${removed} 个 Agent 的 Runtime Session 已重置。` : "该群当前没有已保存的 Runtime Session。");
  } finally {
    await lock.release();
  }
}

// 换企业或重建机器人后，本机 wecom-cli 授权的真人 userid 会变，而配置里的 Owner
// 还是旧值，表现为「只有机器人创建者可以私聊 Agent」。启动时先亮明双方身份，
// 不一致就在本机终端询问——信任根仍是本机，与 setup 配对确认保持一致。
async function confirmOwnerIdentity(config: ThreadFerryConfig, agentId: string, updateConfig: ConfigUpdater): Promise<void> {
  const agent = config.agents[agentId]!;
  const identity = await fetchWecomIdentity(wecomRunner(botConfigDir(agentId, agent.configDir)));
  const bot = describeIdentity(identity.bot);
  const user = describeIdentity(identity.user);
  if (bot) console.log(`企业微信机器人: ${bot}`);
  console.log(`当前授权用户: ${user ?? "未能识别"}`);
  // 一致时直接展示「名字（ID）」，不一致时只能展示配置里存的原始 ID。
  const ownerLabel = agent.ownerUser === identity.user?.id && user ? user : agent.ownerUser;
  console.log(`Agent ${agentId} 配置的 Owner: ${ownerLabel}`);
  const currentUser = identity.user?.id;
  if (!currentUser || currentUser === agent.ownerUser) return;

  console.warn(`[owner] Agent ${agentId} 的当前授权用户与配置 Owner 不一致；在更正之前，私聊该 Agent 会被拒绝。`);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.warn("[owner] 非交互式启动不会自动更改；请在交互式终端执行 threadferry setup 重新确认 Owner。");
    return;
  }
  const answer = (await askLine("是否把 Owner 更新为当前授权用户？[y/N]: ")).trim().toLowerCase();
  const approved = answer === "y" || answer === "yes";
  if (!approved) {
    console.log("[owner] 保持原有 Owner；可随时执行 threadferry setup 重新确认。");
    return;
  }
  await updateConfig((latest) => {
    const adopted = adoptOwner(latest, agentId, currentUser);
    latest.ownerUser = adopted.ownerUser;
    latest.agents = adopted.agents;
    latest.groups = adopted.groups;
  });
  console.log(`[owner] Agent ${agentId} 的 Owner 已更新为 ${user}`);
}

async function loginAgentBot(agentId: string, override?: string): Promise<void> {
  const configDir = botConfigDir(agentId, override);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  console.log(authAnnouncement(agentId, configDir));
  console.log();
  const code = await new Promise<number | null>((resolve, reject) => {
    const child = spawn("wecom-cli", ["auth", "init"], {
      stdio: "inherit",
      env: wecomEnv(configDir),
      shell: false,
    });
    child.on("error", (error) => reject(new Error(`无法启动 wecom-cli: ${error.message}`)));
    child.on("close", resolve);
  });
  if (code !== 0) throw new Error(`wecom-cli auth init 未成功（退出码 ${code ?? "unknown"}）`);
  const status = await botStatus(agentId, override);
  if (!status.authorized) throw new Error(`授权流程结束但 ${configDir} 下仍没有可用凭据`);
  console.log(`\nAgent ${agentId} 已绑定机器人 ${status.botId}。`);
}

async function authorizeBotFromAdmin(agentId: string, override: string | undefined, authorization: BotAuthorization): Promise<void> {
  const configDir = botConfigDir(agentId, override);
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  if (authorization.mode === "manual") {
    try {
      await runCommand("wecom-cli", ["auth", "init", "--manual"], {
        env: wecomEnv(configDir),
        input: `${authorization.botId}\n${authorization.secret}\n`,
      });
    } catch (error) {
      throw new Error(wecomFailureReason(error));
    }
    if (!(await botStatus(agentId, override)).authorized) throw new Error("授权结束但未检测到可用机器人凭据");
    return;
  }
  const child = spawn("wecom-cli", ["auth", "init", "--noninteractive"], {
    stdio: "ignore",
    env: wecomEnv(configDir),
    shell: false,
  });
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", (error) => reject(new Error(`无法启动 wecom-cli: ${error.message}`)));
  });
  child.unref();
}

// 保证该 Agent 有机器人凭据：已有则跳过，没有则先预告再扫码授权。
async function authorizeBot(agentId: string, configDir?: string): Promise<BotCredentials> {
  const existing = await loadBotCredentials(agentId, configDir);
  if (existing) {
    console.log(`Agent ${agentId} 已有机器人凭据，跳过扫码授权。`);
    return existing;
  }
  await loginAgentBot(agentId, configDir);
  const after = await loadBotCredentials(agentId, configDir);
  if (!after) throw new Error(authorizeHint(agentId, configDir));
  return after;
}

function selectedAgents(input: string | undefined): Set<string> | undefined {
  if (input === undefined) return undefined;
  const names = new Set(input.split(",").map((name) => name.trim()).filter(Boolean));
  if (names.size === 0) throw new Error("--agents 至少需要一个 Agent 名");
  return names;
}

async function start(
  configPath: string,
  mock: boolean,
  port: number,
  only?: Set<string>,
): Promise<string | undefined> {
  const configFile = resolve(configPath);
  const config = await loadConfig(configFile);
  if (mock) {
    await runMock(config);
    return undefined;
  }
  const startup = await preflightReal(config, only);
  const lock = await acquireHostLock();
  let restartBinary: string | undefined;
  try {
    let configTail = Promise.resolve();
    const updateConfig: ConfigUpdater = (change) => {
      const operation = configTail.then(async () => {
        const latest = await loadConfig(configFile);
        await change(latest);
        await saveConfig(configFile, latest);
        config.ownerUser = latest.ownerUser;
        config.agents = latest.agents;
        config.groups = latest.groups;
        // 就地刷新每个 Agent 的视图，让已运行的 app 立刻看到新配置。
        for (const [agentId, view] of views) refreshAgentView(view, latest, agentId);
      });
      configTail = operation.then(() => undefined, () => undefined);
      return operation;
    };
    const views = new Map<string, AgentView>();
    const state = new ThreadFerryState(defaultStatePath());
    const updateGroupEnabled = (groupId: string, agentId: string, enabled: boolean) => updateConfig((latest) => {
      const access = latest.groups[groupId]?.agents[agentId];
      if (!access) throw new Error("该群没有这个机器人记录");
      if (enabled) {
        delete access.enabled;
        delete access.removed;
      } else {
        access.enabled = false;
      }
    });
    const removeGroup = async (groupId: string, agentId: string): Promise<void> => {
      const agent = config.agents[agentId];
      if (!config.groups[groupId]?.agents[agentId] || !agent) throw new Error("该群没有这个机器人记录");
      await state.clearSession(groupId, sessionScope(agentId, agent));
      await updateConfig((latest) => {
        const currentAgent = latest.agents[agentId];
        const access = latest.groups[groupId]?.agents[agentId];
        if (!access || !currentAgent) throw new Error("该群没有这个机器人记录");
        access.allowUsers = [currentAgent.ownerUser];
        delete access.allowAll;
        access.enabled = false;
        access.removed = true;
      });
      try {
        const reminders = (await state.listReminders(agentId)).filter((item) => item.chatType === "group" && item.chatId === groupId);
        const deliveries = (await state.pendingDeliveries()).filter((item) => item.agent === agentId && item.groupId === groupId);
        await Promise.all([
          ...reminders.map((item) => state.cancelReminder(item.id)),
          ...deliveries.map((item) => state.completeDelivery(item.id)),
        ]);
      } catch {
        throw new Error("群绑定已移除，但提醒或待发送消息清理失败；请检查 ThreadFerry 状态");
      }
    };

    // 各 Agent 的连接索引。连接在下面才建立，但 app 的依赖里要先捕获这个 Map：
    // 转交回复和动作回执都优先走机器人自己的 WS 连接。
    const clients = new Map<string, WSClient>();
    // 每个 Agent 一套：配置视图 + 绑定自己凭据目录的 runner + 独立 app 实例 + 独立连接。
    const createHost = async ({ agentId, botId, secret, configDir }: StartupAgent) => {
      const view = agentView(config, agentId);
      views.set(agentId, view);
      const runner = wecomRunner(configDir);
      const history = new WecomHistory(agentId, runner);
      const listGroups = async () => {
        const groups = await listWecomGroups(runner);
        const joined = groups.filter((group) => group.hasBotSession);
        if (joined.some((group) => !config.groups[group.id]?.agents[agentId])) {
          await updateConfig((latest) => { for (const group of joined) ensureGroupAccess(latest, group.id, agentId); });
        }
        return groups;
      };
      const app = createApp(view, {
      history: (chatId, options) => history.list(chatId, options),
      rememberHistory: (chatType, chatId, message) => history.remember(chatType, chatId, message),
      runtime: runAgentRuntime,
      // 写回只动「这个 host 的 Agent」那一份：同群的另一台机器人有它自己的名单和开关。
      updateAllowUsers: (groupId, users) => updateConfig((latest) => {
        const access = latest.groups[groupId]?.agents[agentId];
        if (!access) throw new Error("指定群未绑定给该 Agent");
        if (access.removed) throw new Error("机器人已从该群移除；重新接入后才能管理用户");
        access.allowUsers = users;
      }),
      updateGroupAccess: (groupId, allowAll) => updateConfig((latest) => {
        const access = latest.groups[groupId]?.agents[agentId];
        if (!access) throw new Error("指定群未绑定给该 Agent");
        if (access.removed) throw new Error("机器人已从该群移除；重新接入后才能修改访问开关");
        if (allowAll) access.allowAll = true;
        else delete access.allowAll;
      }),
      updateGroupEnabled: (groupId, enabled) => updateGroupEnabled(groupId, agentId, enabled),
      removeGroup: (groupId) => removeGroup(groupId, agentId),
      listGroups,
      searchUsers: (keywords) => searchWecomUsers(keywords, runner),
      agentIds: () => Object.keys(config.agents),
      agentOwners: () => Object.fromEntries(Object.entries(config.agents).map(([id, agent]) => [id, agent.ownerUser])),
      // 白名单动作由 ThreadFerry 用这个 Agent 自己的凭据执行；Runtime 沙箱不参与。
      runAction: async (command, write) => {
        try {
          return await runWecomAction(command, runner, write);
        } catch (error) {
          if (error instanceof WecomActionUnknownError) throw error;
          throw new Error(wecomFailureReason(error));
        }
      },
      notifyGroup: async (groupId, content) => {
        const client = clients.get(agentId);
        if (client) {
          try {
            return await pushWecomMessage(client, groupId, content);
          } catch {
            // 连接侧发不出去就退回 wecom-cli。
          }
        }
        await sendWecomReply(groupId, content, runner);
      },
      onError: ({ errorId, phase, reason }) => console.error(`[wecom] Agent ${agentId} 处理失败 error=${errorId} phase=${phase}${reason ? ` reason=${reason}` : ""}`),
      }, state);
      return { agentId, view, runner, listGroups, app, credentials: { botId, secret } };
    };
    const hosts: Array<Awaited<ReturnType<typeof createHost>>> = [];
    hosts.push(...await Promise.all(startup.map(async (agent) => {
      await confirmOwnerIdentity(config, agent.agentId, updateConfig);
      return createHost(agent);
    })));
    const connectionHealth = new Map<string, AgentConnectionHealth>();

    // 管理台看全量配置，但所有企业微信查询都按 Agent 走它自己的机器人。
    const runnerFor = (agentId: string) => hosts.find((host) => host.agentId === agentId)?.runner;
    // 归属信息（机器人名 / Owner 姓名 / Owner 顶层部门）在后台预热一次，管理台首次打开就能显示。
    // 没有通讯录权限的机器人只会少一个徽章，这里既不等它也不报错。
    const origins = new AgentOriginCache();
    for (const host of hosts) void origins.refresh(host.agentId, host.runner).catch(() => undefined);
    // 加密 userid → 姓名：通讯录不支持按 id 反查，只能从单聊会话和群历史里顺手收集（见 directory-names.ts）。
    // 同样是后台预热 + 只读缓存，没权限就一直显示 id。
    const names = new DirectoryNameCache();
    const groupsOf = (agentId: string) =>
      Object.entries(config.groups).filter(([, group]) => {
        const access = group.agents[agentId];
        return access && access.enabled !== false;
      }).map(([groupId]) => groupId);
    for (const host of hosts) void names.refresh(host.agentId, host.runner, groupsOf(host.agentId)).catch(() => undefined);

    const fanOut = async (receivedBy: string, message: IncomingMention) => {
      const peers = fanOutTargets(
        message.text,
        receivedBy,
        hosts.map((host) => ({ ...host, ...origins.read(host.agentId, host.runner) })),
        (agentId) => {
          const access = config.groups[message.groupId]?.agents[agentId];
          return Boolean(access && access.enabled !== false);
        },
      );
      await Promise.all(peers.map(async (peer) => {
        try {
          const status = await peer.app.handle(message, async (content) => {
            const body = quotedReply(message.text, content);
            const client = clients.get(peer.agentId);
            if (!client) return sendWecomReply(message.groupId, body, peer.runner);
            try {
              await pushWecomMessage(client, message.groupId, body);
            } catch {
              await sendWecomReply(message.groupId, body, peer.runner);
            }
          });
          console.log(status === "duplicate"
            ? `[wecom] Agent ${peer.agentId} 已自己收到同一条群 @ 消息，${receivedBy} 的转交被去重挡下（说明企业微信投给了所有被 @ 的机器人）`
            : `[wecom] Agent ${peer.agentId} 接手 ${receivedBy} 转交的同一条群 @ 消息（说明企业微信没给它投这次回调），处理状态: ${status}`);
        } catch (error) {
          const errorId = newErrorId();
          console.error(`[wecom] Agent ${peer.agentId} 接手同一条群 @ 消息失败 error=${errorId} reason=${wecomFailureReason(error)}`);
        }
      }));
    };
    const observeConnection = (agentId: string, event: "connected" | "authenticated" | "disconnected" | "reconnecting" | "activity", attempt?: number) => {
      const now = new Date().toISOString();
      const current = connectionHealth.get(agentId) ?? { state: "connecting", changedAt: now };
      if (event === "activity") {
        connectionHealth.set(agentId, { ...current, state: "connected", lastEventAt: now });
        return;
      }
      const connectionState = event === "authenticated" ? "connected" : event === "reconnecting" ? "reconnecting" : event === "disconnected" ? "disconnected" : "connecting";
      connectionHealth.set(agentId, {
        ...current,
        state: connectionState,
        changedAt: now,
        ...(event === "reconnecting" && attempt ? { reconnectAttempt: attempt } : { reconnectAttempt: undefined }),
      });
      if (event === "authenticated") {
        console.log(`[wecom] Agent ${agentId} 长连接已认证`);
        void state.recordActivity({ agent: agentId, type: "connection.connected", outcome: "success" }).catch(() => undefined);
      } else if (event === "disconnected") {
        console.error(`[wecom] Agent ${agentId} 长连接已断开，SDK 将自动重连`);
        void state.recordActivity({ agent: agentId, type: "connection.disconnected", outcome: "info" }).catch(() => undefined);
      }
    };
    const connections = new Map<string, WSClient>();
    const connectHost = (host: Awaited<ReturnType<typeof createHost>>) => {
      connectionHealth.set(host.agentId, { state: "connecting", changedAt: new Date().toISOString() });
      const connection = startWecomChannel(host.credentials, async (event, reply) => {
        if (event.chatType === "group" && !config.groups[event.message.groupId]?.agents[host.agentId]) {
          await updateConfig((latest) => { ensureGroupAccess(latest, event.message.groupId, host.agentId); });
        }
        const handling = event.chatType === "single"
          ? host.app.handleDirect(event.message, reply)
          : host.app.handle(event.message, reply);
        const [status] = await Promise.all([
          handling,
          ...(event.chatType === "group" ? [fanOut(host.agentId, event.message)] : []),
        ]);
        console.log(`[wecom] Agent ${host.agentId} 收到${event.chatType === "single" ? "单聊" : "群内 @"}消息，处理状态: ${status}`);
      }, (event, attempt) => observeConnection(host.agentId, event, attempt));
      connections.set(host.agentId, connection);
      clients.set(host.agentId, connection);
      console.log(`[bot] Agent ${host.agentId} 已启动连接，监听 ${Object.values(host.view.groups).filter((group) => group.enabled !== false).length} 个可用群`);
    };
    for (const host of hosts) connectHost(host);
    console.log(`ThreadFerry 已启动，${hosts.length} 个 Agent 各自一条企业微信机器人连接。`);

    const connectingAgents = new Map<string, Promise<boolean>>();
    const connectAuthorizedAgent = (agentId: string): Promise<boolean> => {
      if (hosts.some((host) => host.agentId === agentId)) return Promise.resolve(true);
      if (only && !only.has(agentId)) return Promise.resolve(false);
      const pending = connectingAgents.get(agentId);
      if (pending) return pending;
      const connecting = (async () => {
        const agent = config.agents[agentId];
        if (!agent) throw new Error("机器人不存在");
        const credentials = await loadBotCredentials(agentId, agent.configDir);
        if (!credentials) return false;
        const host = await createHost({ agentId, ...credentials });
        hosts.push(host);
        void origins.refresh(agentId, host.runner).catch(() => undefined);
        void names.refresh(agentId, host.runner, groupsOf(agentId)).catch(() => undefined);
        connectHost(host);
        return true;
      })().catch((error) => {
        connectionHealth.set(agentId, { state: "disconnected", changedAt: new Date().toISOString() });
        console.error(`[bot] Agent ${agentId} 动态接入失败 reason=${wecomFailureReason(error)}`);
        throw error;
      }).finally(() => connectingAgents.delete(agentId));
      connectingAgents.set(agentId, connecting);
      return connecting;
    };
    const admin = await startAdminServer(config, {
      updateConfig,
      listGroups: async (agentId) => {
        const host = hosts.find((item) => item.agentId === agentId);
        if (!host) return [];
        // 顺手安排一次姓名收集；schedule 自己不等待，页面渲染不受影响。
        names.schedule(agentId, host.runner, groupsOf(agentId));
        try {
          return await host.listGroups();
        } catch (error) {
          // 管理台只能显示 Error.message，所以在这里就把 wecom-cli 的真实原因和本项目的补救办法接上。
          const reason = wecomFailureReason(error);
          throw new Error(/授权|auth/i.test(reason) ? `${reason}（在终端执行 threadferry agent login ${agentId}）` : reason);
        }
      },
      searchUsers: async (agentId, keywords) => {
        const runner = runnerFor(agentId);
        if (!runner) throw new Error(`Agent ${agentId} 未启动`);
        return searchWecomUsers(keywords, runner);
      },
      userName: (userId) => names.name(userId),
      rememberUser: (userId, name) => names.remember(userId, name),
      botStatus: async (agentId) => {
        const status = await botStatus(agentId, config.agents[agentId]?.configDir);
        // 归属信息只读缓存：通讯录权限不是必须的，页面绝不等这两个调用（见 agent-origin.ts）。
        const runner = runnerFor(agentId);
        const origin = status.authorized && runner ? origins.read(agentId, runner) : {};
        return {
          authorized: status.authorized,
          ...(status.botId ? { botId: status.botId } : {}),
          ...origin,
          ...(connectionHealth.get(agentId) ? { connection: connectionHealth.get(agentId) } : {}),
          ...(status.authorized ? {} : { hint: authorizeHint(agentId, config.agents[agentId]?.configDir) }),
        };
      },
      connectBot: connectAuthorizedAgent,
      authorizeBot: (agentId, authorization) => {
        const agent = config.agents[agentId];
        if (!agent) throw new Error("机器人不存在");
        return authorizeBotFromAdmin(agentId, agent.configDir, authorization);
      },
      snapshot: () => state.snapshot(),
      checkUpdate: () => findUpdate(VERSION),
      resetSession: (groupId, agentId) => {
        const agent = config.agents[agentId];
        if (!config.groups[groupId]?.agents[agentId] || !agent) throw new Error("该群未绑定给这个 Agent");
        return state.clearSession(groupId, sessionScope(agentId, agent));
      },
      removeGroup,
    }, port);
    console.log(`ThreadFerry 管理台: ${admin.url}`);
    try {
      const workflowHosts = () => hosts.map((host) => ({
        agentId: host.agentId,
        ownerUser: host.view.ownerUser,
        runAutomation: host.app.runAutomation,
        canNotify: (chatId: string) => config.groups[chatId]?.agents[host.agentId]?.removed !== true,
        notify: async (chatId: string, content: string) => {
          const client = clients.get(host.agentId);
          if (client) {
            try {
              return await pushWecomMessage(client, chatId, content);
            } catch {
              // 长连接暂时不可用时退回该 Agent 自己的 wecom-cli 凭据。
            }
          }
          await sendWecomReply(chatId, content, host.runner);
        },
      }));

      // 一个群可能挂着多台机器人，所以恢复优先认状态记录里的 Agent；
      // 旧记录没有这个字段时，只有群里恰好只有一个 Agent 才敢兜底，否则宁可不发也不冒名。
      const hostForGroup = (groupId: string, agent?: string) => {
        if (agent) {
          if (config.groups[groupId]?.agents[agent]?.removed) return undefined;
          return hosts.find((host) => host.agentId === agent);
        }
        const candidates = Object.entries(config.groups[groupId]?.agents ?? {})
          .filter(([, access]) => access.enabled !== false).map(([agentId]) => agentId);
        return candidates.length === 1 ? hosts.find((host) => host.agentId === candidates[0]) : undefined;
      };
      const recovery = (async () => {
        for (const delivery of await state.pendingDeliveries()) {
          // 必须用该群所属 Agent 的机器人补发；用别的机器人会从错误身份发出去。
          const host = hostForGroup(delivery.groupId, delivery.agent);
          if (!host) {
            if (delivery.agent && config.groups[delivery.groupId]?.agents[delivery.agent]?.removed) {
              await state.completeDelivery(delivery.id);
              console.log(`[state] 已丢弃已移除群中 Agent ${delivery.agent} 的待发送回复`);
              continue;
            }
            if (delivery.agent) {
              console.error(`[state] 保留待发送回复：Agent ${delivery.agent} 未启动`);
              continue;
            }
            await state.completeDelivery(delivery.id);
            console.error("[state] 已丢弃旧版待发送回复：群未配置或无法确定该由哪台机器人补发");
            continue;
          }
          try {
            await sendWecomReply(delivery.groupId, delivery.content, host.runner);
            await state.completeDelivery(delivery.id);
            console.log(`[state] Agent ${host.agentId} 已补发 1 条上次未投递的回复`);
          } catch {
            const errorId = newErrorId();
            await state.deliveryFailed(delivery.id, errorId).catch(() => undefined);
            console.error(`[wecom] 补发失败 error=${errorId} phase=reply`);
          }
        }

        const pending = await state.recoverPending();
        if (pending.length > 0) console.log(`[state] 正在恢复 ${pending.length} 个上次中断的任务`);
        await Promise.all(pending.map(async ({ message, agent }) => {
          const host = hostForGroup(message.groupId, agent);
          if (!host) {
            console.error("[state] 跳过恢复：群未配置、对应 Agent 未启动，或无法确定该由哪台机器人接手");
            return;
          }
          const result = await host.app.replay(message, async (content, finish = true) => {
            if (finish) await sendWecomReply(message.groupId, content, host.runner);
          });
          console.log(`[state] Agent ${host.agentId} 恢复任务处理状态: ${result}`);
        }));
      })().catch(() => {
        const errorId = newErrorId();
        console.error(`[state] 恢复失败 error=${errorId} phase=host`);
      });

      await new Promise<void>((done) => {
        let stopping = false;
        let updateCheck: Promise<void> | undefined;
        let workflowCheck: Promise<void> | undefined;
        let updateTimer: NodeJS.Timeout;
        let workflowTimer: NodeJS.Timeout;
        const desktopPort = (process as NodeJS.Process & { parentPort?: DesktopParentPort }).parentPort;
        const stop = (cancel: boolean) => {
          if (stopping) return;
          stopping = true;
          desktopPort?.off("message", onParentMessage);
          clearInterval(updateTimer);
          clearInterval(workflowTimer);
          for (const connection of connections.values()) connection.disconnect();
          void admin.close();
          void Promise.all([...hosts.map(({ app }) => app.shutdown(cancel)), recovery, updateCheck, workflowCheck]).finally(done);
        };
        updateTimer = setInterval(() => {
          if (stopping || updateCheck) return;
          updateCheck = autoUpdate()
            .then((binary) => {
              if (!binary) return;
              restartBinary = binary;
              stop(false);
            })
            .finally(() => { updateCheck = undefined; });
        }, UPDATE_INTERVAL_MS);
        updateTimer.unref();
        const runWorkflows = () => {
          if (stopping || workflowCheck) return;
          workflowCheck = recovery.then(() => runWorkflowTick(state, workflowHosts()))
            .catch((error) => console.error(`[workflow] 调度失败 reason=${wecomFailureReason(error)}`))
            .finally(() => { workflowCheck = undefined; });
        };
        workflowTimer = setInterval(runWorkflows, WORKFLOW_INTERVAL_MS);
        workflowTimer.unref();
        runWorkflows();
        const onParentMessage = (event: { data: unknown }) => {
          const message = event.data as { type?: unknown; cancel?: unknown } | undefined;
          if (message?.type === "threadferry:stop") stop(message.cancel !== false);
        };
        desktopPort?.on("message", onParentMessage);
        desktopPort?.postMessage({ type: "threadferry:ready", url: admin.url });
        process.once("SIGINT", () => stop(true));
        process.once("SIGTERM", () => stop(true));
      });
    } finally {
      await admin.close();
    }
  } finally {
    await lock.release();
  }
  return restartBinary;
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  if (!command || command === "--help" || command === "-h") {
    console.log(USAGE);
    return;
  }
  if (command === "--version" || command === "-v") {
    console.log(VERSION);
    return;
  }
  if (command === "onboard") {
    await onboard(option(args, "--config"), pairTimeoutMs(option(args, "--timeout")));
    return;
  }
  if (command === "doctor") {
    if (!(await doctor(option(args, "--config")))) process.exitCode = 1;
    return;
  }
  if (command === "skills") {
    if (args[0] !== "install") throw new Error("threadferry skills 仅支持 install");
    await installOfficialWecomSkills();
    console.log("企业微信官方 Skill 已安装或更新到 ~/.agents/skills。");
    return;
  }
  if (command === "status") {
    await status(option(args, "--config"));
    return;
  }
  if (command === "update") {
    if (!(await applyUpdate())) console.log(`ThreadFerry ${VERSION} 已是最新版本。`);
    return;
  }
  if (command === "session") {
    if (args[0] !== "reset") throw new Error("threadferry session 仅支持 reset");
    const groupId = option(args, "--group");
    if (!groupId) throw new Error("threadferry session reset 必须提供 --group <group-id>");
    await resetSession(option(args, "--config"), groupId);
    return;
  }
  if (command === "setup") {
    const runtimeInput = option(args, "--runtime");
    await setup(option(args, "--config") ?? defaultConfigPath(), {
      agentId: option(args, "--agent") ?? "default",
      workspace: option(args, "--workspace"),
      runtime: runtimeInput === undefined ? undefined : runtimeName(runtimeInput),
      model: option(args, "--model"),
      timeoutMs: pairTimeoutMs(option(args, "--timeout")),
    });
    return;
  }
  if (command === "agent") {
    const action = args[0];
    const configPath = resolve(option(args, "--config") ?? defaultConfigPath());
    const config = await loadConfig(configPath);
    if (action === "list") {
      const pending: string[] = [];
      for (const [id, agent] of Object.entries(config.agents)) {
        const status = await botStatus(id, agent.configDir);
        console.log(`${id}\t${agent.runtime}\t${agent.model ?? "default"}\t${agent.workspace}\t${status.botId ?? "未授权"}`);
        if (!status.authorized) pending.push(id);
      }
      // 未授权的 Agent 不会启动入站，这里直接给出可执行的下一步。
      for (const id of pending) console.log(`\n${authorizeHint(id, config.agents[id]?.configDir)}`);
      return;
    }
    if (action === "login") {
      // args[1] 可能是紧跟的选项（threadferry agent login --config x），不能当成 Agent 名。
      const name = args[1]?.startsWith("-") ? undefined : args[1];
      if (!name) throw new Error("threadferry agent login 必须提供 Agent 名");
      if (!config.agents[name]) throw new Error(`Agent ${name} 未配置；先运行 threadferry agent add`);
      await loginAgentBot(name, config.agents[name]?.configDir);
      return;
    }
    if (action !== "add") throw new Error("threadferry agent 仅支持 add、list 或 login");
    const name = option(args, "--name");
    const workspaceInput = option(args, "--workspace");
    if (!name || !workspaceInput) throw new Error("threadferry agent add 必须提供 --name 和 --workspace");
    const workspace = await resolveWorkspace(workspaceInput);
    const next = addAgent(config, name, {
      workspace,
      runtime: runtimeName(option(args, "--runtime")),
      ...(option(args, "--model") ? { model: option(args, "--model") } : {}),
    });
    await saveConfig(configPath, next);
    console.log(`Agent ${name} 已添加。`);
    return;
  }
  if (command === "start") {
    const configPath = option(args, "--config") ?? defaultConfigPath();
    const mock = args.includes("--mock");
    const binary = mock ? undefined : await autoUpdate();
    if (binary) {
      await runUpdated(binary, [command, ...args]);
      return;
    }
    // 完全没初始化时，start 不该报错让用户自己去猜下一步——直接转入引导。
    if (!existsSync(resolve(configPath))) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error(
          `配置不存在: ${resolve(configPath)}\n`
          + "ThreadFerry 还没有初始化。请先在交互式终端运行 threadferry onboard 完成引导配置。",
        );
      }
      console.log(`未找到配置 ${resolve(configPath)}，ThreadFerry 还没有初始化。`);
      console.log("转入引导配置（完成后可以直接启动）。\n");
      await onboard(option(args, "--config"));
      return;
    }
    const restartBinary = await start(
      configPath,
      mock,
      adminPort(option(args, "--admin-port")),
      selectedAgents(option(args, "--agents")),
    );
    if (restartBinary) await runUpdated(restartBinary, [command, ...args]);
    return;
  }
  throw new Error(`未知命令: ${command}\n${USAGE}`);
}

void main().then(() => {
  if (process.env.THREADFERRY_DESKTOP === "1") process.exit(process.exitCode ?? 0);
}).catch((error) => {
  console.error(`ThreadFerry: ${error instanceof Error ? error.message : String(error)}`);
  if (process.env.THREADFERRY_DESKTOP === "1") process.exit(1);
  process.exitCode = 1;
});
