#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { createApp } from "./app.js";
import { startAdminServer, type ConfigUpdater } from "./admin.js";
import { authorizeHint, botConfigDir, botStatus, loadBotCredentials, validateAgentId, wecomEnv, type BotCredentials } from "./bots.js";
import { listWecomGroups, searchWecomUsers, sendWecomReply, startWecomChannel } from "./channels/wecom.js";
import {
  addAgent,
  adoptOwner,
  agentView,
  loadConfig,
  pairConfig,
  refreshAgentView,
  resolveWorkspace,
  saveConfig,
} from "./config.js";
import { fetchWecomHistory } from "./history/wecom-cli.js";
import { describeIdentity, fetchWecomIdentity } from "./identity.js";
import { runCommand } from "./process.js";
import { runCodex } from "./runtimes/codex.js";
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
import type { CommandRunner, GroupMessage, IncomingMention, RuntimeName, ThreadFerryConfig } from "./types.js";
import { findUpdate, installUpdate } from "./update.js";

const VERSION = "0.16.0";
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const USAGE = `ThreadFerry ${VERSION}

Usage:
  threadferry onboard [--config <path>] [--timeout <seconds>]
  threadferry setup [--workspace <absolute-path>] [--agent <name>] [--runtime codex|pi] [--model <id>] [--config <path>] [--timeout <seconds>]
  threadferry agent add --name <name> --runtime codex|pi --workspace <absolute-path> [--model <id>] [--config <path>]
  threadferry agent list [--config <path>]
  threadferry agent login <name> [--config <path>]
  threadferry doctor [--config <path>]
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
  try {
    return await applyUpdate();
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
  if (input === undefined || input === "codex") return "codex";
  if (input === "pi") return "pi";
  throw new Error("--runtime 仅支持 codex 或 pi");
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
    throw new Error("找不到企业微信官方 wecom-cli 1.1.0+；请安装并加入 PATH");
  }
  if (!atLeast(wecomVersion, [1, 1, 0])) throw new Error("ThreadFerry 要求 wecom-cli 1.1.0+");
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
      const runtime = runtimeName((await ask("Runtime (codex/pi)", existing?.agents[agentId]?.runtime ?? "codex")).toLowerCase());
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
        console.log("\n[2/5] 授权企业微信机器人（已有凭据则跳过）");
        const credentials = await authorizeBot(agentId, existing.agents[agentId].configDir);
        const plan = resolveSetupPlan(existing, agentId);
        await claimOwner(configPath, agentId, credentials, plan, existing, timeoutMs);
      } else if (choice === "3" || choice.toLowerCase() === "q" || choice.toLowerCase() === "cancel") {
        console.log("已取消。");
        return;
      } else {
        // 新增 Agent：先授权机器人，再用机器人名作 Agent 名（自动，无需输入）。
        console.log("\n[2/5] 授权企业微信机器人（扫码）");
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
      console.log("\n[2/5] 授权企业微信机器人（扫码）");
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

  console.log("\n[4/5] 运行环境诊断");
  if (!(await doctor(configPath))) {
    console.error(
      "\n[error] 环境诊断未通过。请根据上面的 [error] 条目修复问题。\n" +
      "修复后重新运行 threadferry onboard 即可（它会复用已有配置和配对），也可以直接运行 threadferry start。",
    );
    throw new Error(`环境诊断未通过；修复后运行 threadferry doctor --config ${configPath} 复查。`);
  }

  console.log("\n[5/5] 启动 ThreadFerry");
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
  console.log("\n[3/5] 认领 Owner（默认使用授权用户，也可手机配对指定）");
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
    const supported = atLeast(stdout, [1, 1, 0]);
    checks.push({ ok: supported, message: supported ? stdout.trim() : `${stdout.trim()}；ThreadFerry 要求 1.1.0+` });
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
    checks.push({ ok: false, message: "找不到 wecom-cli；请安装企业微信官方 wecom-cli 1.1.0+ 并加入 PATH" });
  }

  const probeGroup = probeAgent
    && Object.entries(loadedConfig?.groups ?? {}).find(([, group]) => group.agent === probeAgent)?.[0];
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

  for (const check of checks) console.log(`${check.ok ? "[ok]" : "[error]"} ${check.message}`);
  return checks.every((check) => check.ok);
}

async function runMock(config: ThreadFerryConfig): Promise<void> {
  const [groupId, group] = Object.entries(config.groups)[0]!;
  const agent = config.agents[group.agent]!;
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
  const app = createApp(config, {
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
  const lastFailure = snapshot.turns.slice().reverse().find((turn) => turn.status === "failed");
  console.log(`ThreadFerry: ${active > 0 ? `${active} 个任务处理中或排队` : "空闲"}`);
  console.log(`配置 Agent: ${Object.keys(config.agents).length}；群: ${Object.keys(config.groups).length}；Session: ${snapshot.sessions.length}；执行记录: ${snapshot.turns.length}`);
  console.log(`可靠性队列: inbox=${snapshot.inbox.length}, outbox=${snapshot.outbox.length}`);
  console.log(`结果: handled=${counts.get("handled") ?? 0}, stale=${counts.get("stale") ?? 0}, failed=${counts.get("failed") ?? 0}`);
  if (lastFailure) console.log(`最近失败: ${lastFailure.errorId ?? "无错误编号"} phase=${lastFailure.failurePhase ?? "unknown"} time=${lastFailure.updatedAt}`);
}

async function resetSession(configPath: string | undefined, groupId: string): Promise<void> {
  const lock = await acquireHostLock();
  try {
    const config = await loadConfig(resolve(configPath ?? defaultConfigPath()));
    const group = config.groups[groupId];
    if (!group) throw new Error("指定群未配置");
    // 只重置该群所属 Agent 的 Session：两个机器人同在一个群时不能清掉对方的。
    const agent = config.agents[group.agent]!;
    const removed = await new ThreadFerryState(defaultStatePath())
      .clearSession(groupId, sessionScope(group.agent, agent));
    console.log(removed ? "该群 Runtime Session 已重置。" : "该群当前没有已保存的 Runtime Session。");
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
    const views = new Map<string, ThreadFerryConfig>();
    const state = new ThreadFerryState(defaultStatePath());

    // 每个 Agent 一套：配置视图 + 绑定自己凭据目录的 runner + 独立 app 实例 + 独立连接。
    const hosts = await Promise.all(startup.map(async ({ agentId, botId, secret, configDir }) => {
      const view = agentView(config, agentId);
      views.set(agentId, view);
      const runner = wecomRunner(configDir);
      await confirmOwnerIdentity(config, agentId, updateConfig);
      const app = createApp(view, {
      history: (groupId, options) => fetchWecomHistory(groupId, options, runner),
      runtime: (request) => request.runtime === "codex" ? runCodex(request) : runPi(request),
      updateAllowUsers: (groupId, users) => updateConfig((latest) => {
        const group = latest.groups[groupId];
        if (!group) throw new Error("指定群未配置");
        group.allowUsers = users;
      }),
      updateGroupAccess: (groupId, allowAll) => updateConfig((latest) => {
        const group = latest.groups[groupId];
        if (!group) throw new Error("指定群未配置");
        if (allowAll) group.allowAll = true;
        else delete group.allowAll;
      }),
      // 绑定到「这个 host 的 Agent」，Agent 由闭包捕获，不从用户输入来。
      bindGroup: (groupId) => updateConfig((latest) => {
        const owner = latest.agents[agentId]?.ownerUser;
        if (!owner) throw new Error(`Agent ${agentId} 未配置`);
        if (latest.groups[groupId]) throw new Error("指定群已配置");
        latest.groups[groupId] = { agent: agentId, allowUsers: [owner], context: { lookbackHours: 6, maxMessages: 80 } };
      }),
      listGroups: () => listWecomGroups(runner),
      searchUsers: (keywords) => searchWecomUsers(keywords, runner),
      onError: ({ errorId, phase, reason }) => console.error(`[wecom] Agent ${agentId} 处理失败 error=${errorId} phase=${phase}${reason ? ` reason=${reason}` : ""}`),
      }, state);
      return { agentId, view, runner, app, credentials: { botId, secret } };
    }));

    // 管理台看全量配置，但所有企业微信查询都按 Agent 走它自己的机器人。
    const runnerFor = (agentId: string) => hosts.find((host) => host.agentId === agentId)?.runner;
    const admin = await startAdminServer(config, {
      updateConfig,
      listGroups: async (agentId) => {
        const runner = runnerFor(agentId);
        return runner ? listWecomGroups(runner) : [];
      },
      searchUsers: (keywords) => searchWecomUsers(keywords, hosts[0]!.runner),
      botStatus: async (agentId) => {
        const status = await botStatus(agentId, config.agents[agentId]?.configDir);
        return {
          authorized: status.authorized,
          ...(status.botId ? { botId: status.botId } : {}),
          ...(status.authorized ? {} : { hint: authorizeHint(agentId, config.agents[agentId]?.configDir) }),
        };
      },
      snapshot: () => state.snapshot(),
      resetSession: (groupId) => {
        const group = config.groups[groupId];
        if (!group) throw new Error("指定群未配置");
        return state.clearSession(groupId, sessionScope(group.agent, config.agents[group.agent]!));
      },
    }, port);
    console.log(`ThreadFerry 管理台: ${admin.url}`);
    try {
      const clients = hosts.map(({ agentId, app, credentials }) => startWecomChannel(credentials, async (event, reply) => {
        const status = event.chatType === "single"
          ? await app.handleDirect(event.message, reply)
          : await app.handle(event.message, reply);
        console.log(`[wecom] Agent ${agentId} 收到${event.chatType === "single" ? "单聊" : "群内 @"}消息，处理状态: ${status}`);
      }));
      for (const { agentId, view } of hosts) {
        console.log(`[bot] Agent ${agentId} 已连接，监听 ${Object.keys(view.groups).length} 个已配置群`);
      }
      console.log(`ThreadFerry 已启动，${hosts.length} 个 Agent 各自一条企业微信机器人连接。`);

      const hostForGroup = (groupId: string) => {
        const agentId = config.groups[groupId]?.agent;
        return agentId ? hosts.find((host) => host.agentId === agentId) : undefined;
      };
      const recovery = (async () => {
        for (const delivery of await state.pendingDeliveries()) {
          // 必须用该群所属 Agent 的机器人补发；用别的机器人会从错误身份发出去。
          const host = hostForGroup(delivery.groupId);
          if (!host) {
            await state.completeDelivery(delivery.id);
            console.error("[state] 已丢弃未配置群或所属 Agent 未启动的待发送回复");
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
        await Promise.all(pending.map(async (message) => {
          const host = hostForGroup(message.groupId);
          if (!host) {
            console.error("[state] 跳过恢复：该群未配置或所属 Agent 未启动");
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
        let updateTimer: NodeJS.Timeout;
        const stop = (cancel: boolean) => {
          if (stopping) return;
          stopping = true;
          clearInterval(updateTimer);
          for (const client of clients) client.disconnect();
          void admin.close();
          void Promise.all([...hosts.map(({ app }) => app.shutdown(cancel)), recovery, updateCheck]).finally(done);
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
    const binary = mock ? undefined : await autoUpdate();
    if (binary) {
      await runUpdated(binary, [command, ...args]);
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

void main().catch((error) => {
  console.error(`ThreadFerry: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
