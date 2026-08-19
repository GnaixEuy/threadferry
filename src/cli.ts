#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { emitKeypressEvents, type Key } from "node:readline";
import { createInterface } from "node:readline/promises";
import { createApp } from "./app.js";
import { startAdminServer, type ConfigUpdater } from "./admin.js";
import { listWecomGroups, searchWecomUsers, sendWecomReply, startWecomChannel } from "./channels/wecom.js";
import { addAgent, loadConfig, onboardingDefaults, pairConfig, resolveWorkspace, saveConfig } from "./config.js";
import { fetchWecomHistory } from "./history/wecom-cli.js";
import { runCommand } from "./process.js";
import { runCodex } from "./runtimes/codex.js";
import { runPi } from "./runtimes/pi.js";
import { acquireHostLock, defaultStatePath, newErrorId, ThreadFerryState } from "./state.js";
import type { GroupMessage, IncomingMention, RuntimeName, ThreadFerryConfig } from "./types.js";
import { findUpdate, installUpdate } from "./update.js";
import { loadWecomCliCredentials } from "./wecom-credentials.js";

const VERSION = "0.13.0";
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const USAGE = `ThreadFerry ${VERSION}

Usage:
  threadferry onboard [--config <path>]
  threadferry setup --workspace <absolute-path> [--agent <name>] [--runtime codex|pi] [--model <id>] [--config <path>]
  threadferry agent add --name <name> --runtime codex|pi --workspace <absolute-path> [--model <id>] [--config <path>]
  threadferry agent list [--config <path>]
  threadferry doctor [--config <path>]
  threadferry status [--config <path>]
  threadferry update
  threadferry session reset --group <group-id> [--config <path>]
  threadferry start [--config <path>] [--admin-port <port>] [--mock]
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

function validateCredential(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1024 || /[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new Error(`${name} 无效`);
  }
  return normalized;
}

async function hiddenQuestion(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY || !process.stdin.setRawMode) {
    throw new Error("当前终端不支持安全隐藏输入");
  }
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  const wasPaused = process.stdin.isPaused();
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let answer = "";
  return new Promise<string>((resolveAnswer, reject) => {
    const finish = (error?: Error) => {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(Boolean(wasRaw));
      if (wasPaused) process.stdin.pause();
      process.stdout.write("\n");
      if (error) reject(error);
      else resolveAnswer(answer);
    };
    const onKeypress = (text: string, key: Key) => {
      if (key.ctrl && key.name === "c") {
        finish(new Error("凭据输入已取消"));
      } else if (key.name === "return" || key.name === "enter") {
        finish();
      } else if (key.name === "backspace" || key.name === "delete") {
        if (answer.length > 0) {
          answer = answer.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (!key.ctrl && !key.meta && text && !/[\r\n]/.test(text) && answer.length < 1024) {
        answer += text;
        process.stdout.write("*");
      }
    };
    process.stdin.on("keypress", onKeypress);
  });
}

async function botCredentials(): Promise<{ botId: string; secret: string }> {
  let botId = process.env.THREADFERRY_WECOM_BOT_ID;
  let secret = process.env.THREADFERRY_WECOM_BOT_SECRET;
  if (botId && secret) return { botId, secret };
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("缺少 THREADFERRY_WECOM_BOT_ID 或 THREADFERRY_WECOM_BOT_SECRET；交互式终端可安全输入，非交互启动必须设置环境变量");
  }
  console.log("机器人凭据仅用于当前进程，不写入配置或日志。");
  if (!botId && !secret) {
    let configuredBotId: string | undefined;
    try {
      const { stdout } = await runCommand("wecom-cli", ["auth", "show"], { timeoutMs: 10_000 });
      const value = stdout.match(/^Bot ID:\s*(.+)$/m)?.[1];
      if (value) configuredBotId = validateCredential(value, "Bot ID");
    } catch {
      // Missing or unauthorized wecom-cli falls through to manual entry.
    }
    if (configuredBotId) {
      const prompt = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (await prompt.question(`检测到 wecom-cli 已配置 Bot ID ${configuredBotId}，是否直接读取并使用？[Y/n]: `)).trim().toLowerCase();
        if (answer === "" || answer === "y" || answer === "yes") {
          const saved = await loadWecomCliCredentials();
          if (saved?.botId === configuredBotId) {
            botId = saved.botId;
            secret = saved.secret;
            console.log("已复用 wecom-cli 凭据。");
          } else {
            console.log("无法读取 wecom-cli 保存的 Secret，请手动输入。");
          }
        }
      } finally {
        prompt.close();
      }
    }
  }
  if (!botId) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      botId = validateCredential(await prompt.question("企业微信 Bot ID: "), "Bot ID");
    } finally {
      prompt.close();
    }
  }
  if (!secret) secret = validateCredential(await hiddenQuestion("企业微信 Bot Secret: "), "Bot Secret");
  process.env.THREADFERRY_WECOM_BOT_ID = botId;
  process.env.THREADFERRY_WECOM_BOT_SECRET = secret;
  return { botId, secret };
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

async function preflightReal(config: ThreadFerryConfig): Promise<{ botId: string; secret: string }> {
  const credentials = await botCredentials();
  await preflightDependencies(new Set(Object.values(config.agents).map((agent) => agent.runtime)));
  return credentials;
}

async function setup(configPath: string, workspaceInput: string, agentId: string, runtime: RuntimeName, model?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("threadferry setup 需要交互式终端确认私聊身份");
  const target = resolve(configPath);
  const workspace = await resolveWorkspace(workspaceInput);
  if (existsSync(target)) await loadConfig(target);
  const credentials = await botCredentials();
  await preflightDependencies(new Set([runtime]));
  const code = randomBytes(8).toString("hex");
  console.log(`请私聊机器人发送：threadferry pair ${code}`);
  console.log("等待私聊配对消息；收到后还需要在本机终端确认。配置不会保存机器人凭据。");

  await new Promise<void>((done, reject) => {
    let client: ReturnType<typeof startWecomChannel> | undefined;
    let claimed = false;
    const stop = () => {
      client?.disconnect();
      reject(new Error("setup 已取消"));
    };
    const finish = () => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      client?.disconnect();
      done();
    };
    client = startWecomChannel(credentials, async (event, reply) => {
      if (event.chatType !== "single") {
        await reply("请私聊机器人完成 ThreadFerry Owner 配对。", true).catch(() => undefined);
        return;
      }
      const message = event.message;
      if (!message.text.includes(`threadferry pair ${code}`)) {
        console.log("[setup] 收到私聊消息，但配对码不匹配");
        return;
      }
      if (claimed) return;
      claimed = true;
      try {
        const confirmation = createInterface({ input: process.stdin, output: process.stdout });
        let approved: boolean;
        try {
          const answer = (await confirmation.question(`收到 userid ${message.senderId} 的私聊配对请求，确认为 ThreadFerry Owner？[y/N]: `)).trim().toLowerCase();
          approved = answer === "y" || answer === "yes";
        } finally {
          confirmation.close();
        }
        if (!approved) {
          claimed = false;
          await reply("本机终端未确认本次配对。", true).catch(() => undefined);
          return;
        }
        const current = existsSync(target) ? await loadConfig(target) : undefined;
        const content = pairConfig(agentId, { workspace, runtime, ...(model ? { model } : {}) }, message.senderId, current);
        const directory = dirname(target);
        await mkdir(directory, { recursive: true });
        const temporary = join(directory, `.${basename(target)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
        try {
          await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
          await rename(temporary, target);
        } finally {
          await rm(temporary, { force: true });
        }
        await reply("配对完成。请回到电脑终端继续启动 ThreadFerry。\n\n启动后：\n- 直接在这里发消息，即可私聊 Agent\n- 发送 `threadferry help`，查看群聊接入和管理方法").catch(() => undefined);
        console.log(`配置已更新: ${target}`);
        finish();
      } catch (error) {
        client?.disconnect();
        reject(error);
      }
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function onboard(configOption?: string): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("threadferry onboard 需要交互式终端；无人值守环境请使用 setup/start 参数和环境变量");
  }
  const configPath = resolve(configOption ?? defaultConfigPath());
  const current = existsSync(configPath) ? await loadConfig(configPath) : undefined;
  const defaults = onboardingDefaults(current, process.cwd());
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  let agentId: string;
  let runtime: RuntimeName;
  let workspace: string;
  let model: string | undefined;
  console.log(`ThreadFerry 引导配置（配置文件: ${configPath}）`);
  console.log("[1/4] 选择 Agent 和 Workspace");
  try {
    const ask = async (label: string, fallback: string) => {
      const answer = (await prompt.question(`${label} [${fallback}]: `)).trim();
      return answer || fallback;
    };
    agentId = await ask("Agent 名", defaults.agentId);
    runtime = runtimeName((await ask("Runtime (codex/pi)", defaults.runtime)).toLowerCase());
    workspace = await ask("Workspace 绝对路径", defaults.workspace);
    const modelAnswer = (await prompt.question(`模型 ID（留空使用 Runtime 默认）${defaults.model ? ` [${defaults.model}]` : ""}: `)).trim();
    model = modelAnswer || defaults.model;
  } finally {
    prompt.close();
  }

  console.log("[2/4] 检查依赖并通过私聊配对 Owner");
  await setup(configPath, workspace, agentId, runtime, model);
  console.log("[3/4] 运行环境诊断");
  if (!(await doctor(configPath))) {
    throw new Error(`环境诊断未通过；修复后运行 threadferry doctor --config ${configPath}`);
  }

  console.log("[4/4] 启动 ThreadFerry");
  const confirmation = createInterface({ input: process.stdin, output: process.stdout });
  let shouldStart: boolean;
  try {
    const answer = (await confirmation.question("现在启动并保持当前终端运行？[Y/n]: ")).trim().toLowerCase();
    shouldStart = answer === "" || answer === "y" || answer === "yes";
  } finally {
    confirmation.close();
  }
  if (shouldStart) {
    const updatedBinary = await start(configPath, false, 17_638);
    if (updatedBinary) await runUpdated(updatedBinary, ["start", "--config", configPath]);
  }
  else console.log(`配置完成。稍后运行: threadferry start --config ${configPath}`);
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

  const environmentCredentials = Boolean(process.env.THREADFERRY_WECOM_BOT_ID && process.env.THREADFERRY_WECOM_BOT_SECRET);
  const savedCredentials = environmentCredentials ? undefined : await loadWecomCliCredentials();
  checks.push({
    ok: environmentCredentials || Boolean(savedCredentials),
    message: environmentCredentials
      ? "企业微信机器人凭据可用（环境变量，值未显示）"
      : savedCredentials
        ? "企业微信机器人凭据可用（wecom-cli 加密存储，值未显示）"
        : "缺少企业微信机器人凭据；请运行 threadferry onboard 或设置 THREADFERRY_WECOM_BOT_ID/THREADFERRY_WECOM_BOT_SECRET",
  });

  let wecomAuthorized = false;
  try {
    const { stdout } = await runCommand("wecom-cli", ["--version"], { timeoutMs: 10_000 });
    const supported = atLeast(stdout, [1, 1, 0]);
    checks.push({ ok: supported, message: supported ? stdout.trim() : `${stdout.trim()}；ThreadFerry 要求 1.1.0+` });
    try {
      await runCommand("wecom-cli", ["identity", "whoami", "--json", "{}"], { timeoutMs: 30_000 });
      wecomAuthorized = true;
      checks.push({ ok: true, message: "wecom-cli 身份授权有效（详情未显示）" });
    } catch {
      checks.push({ ok: false, message: "wecom-cli 未授权或身份检查失败；请先执行 wecom-cli auth init" });
    }
  } catch {
    checks.push({ ok: false, message: "找不到 wecom-cli；请安装企业微信官方 wecom-cli 1.1.0+ 并加入 PATH" });
  }

  const firstGroupId = loadedConfig && Object.keys(loadedConfig.groups)[0];
  if (wecomAuthorized && firstGroupId) {
    try {
      await fetchWecomHistory(firstGroupId, { lookbackHours: 1 / 60, maxMessages: 1, endTime: new Date() });
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
    if (!config.groups[groupId]) throw new Error("指定群未配置");
    const removed = await new ThreadFerryState(defaultStatePath()).clearSession(groupId);
    console.log(removed ? "该群 Runtime Session 已重置。" : "该群当前没有已保存的 Runtime Session。");
  } finally {
    await lock.release();
  }
}

async function start(configPath: string, mock: boolean, port: number): Promise<string | undefined> {
  const configFile = resolve(configPath);
  const config = await loadConfig(configFile);
  if (mock) {
    await runMock(config);
    return undefined;
  }
  const credentials = await preflightReal(config);
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
      });
      configTail = operation.then(() => undefined, () => undefined);
      return operation;
    };
    const state = new ThreadFerryState(defaultStatePath());
    const app = createApp(config, {
      history: (groupId, options) => fetchWecomHistory(groupId, options),
      runtime: (request) => request.runtime === "codex" ? runCodex(request) : runPi(request),
      updateAllowUsers: (groupId, users) => updateConfig((latest) => {
        const group = latest.groups[groupId];
        if (!group) throw new Error("指定群未配置");
        group.allowUsers = users;
      }),
      updateGroupAgent: (groupId, agentId) => updateConfig((latest) => {
        const group = latest.groups[groupId];
        if (!group || !latest.agents[agentId]) throw new Error("指定群或 Agent 未配置");
        group.agent = agentId;
      }),
      bindGroup: (groupId, agentId) => updateConfig((latest) => {
        if (latest.groups[groupId] || !latest.agents[agentId]) throw new Error("指定群已配置或 Agent 不存在");
        latest.groups[groupId] = { agent: agentId, allowUsers: [latest.ownerUser], context: { lookbackHours: 6, maxMessages: 80 } };
      }),
      listGroups: () => listWecomGroups(),
      searchUsers: (keywords) => searchWecomUsers(keywords),
      onError: ({ errorId, phase }) => console.error(`[wecom] 处理失败 error=${errorId} phase=${phase}`),
    }, state);
    const admin = await startAdminServer(config, {
      updateConfig,
      listGroups: () => listWecomGroups(),
      searchUsers: (keywords) => searchWecomUsers(keywords),
      snapshot: () => state.snapshot(),
      resetSession: (groupId) => state.clearSession(groupId),
    }, port);
    console.log(`ThreadFerry 管理台: ${admin.url}`);
    try {
      const client = startWecomChannel(credentials, async (event, reply) => {
        const status = event.chatType === "single"
          ? await app.handleDirect(event.message, reply)
          : await app.handle(event.message, reply);
        console.log(`[wecom] 收到${event.chatType === "single" ? "单聊" : "群内 @"}消息，处理状态: ${status}`);
      });
      console.log(`ThreadFerry 已启动，监听 ${Object.keys(config.groups).length} 个已配置企业微信群。`);

      const recovery = (async () => {
        const deliveries = await state.pendingDeliveries();
        for (const delivery of deliveries) {
          if (!config.groups[delivery.groupId]) {
            await state.completeDelivery(delivery.id);
            console.error("[state] 已丢弃未配置群的待发送回复");
            continue;
          }
          try {
            await sendWecomReply(delivery.groupId, delivery.content);
            await state.completeDelivery(delivery.id);
            console.log("[state] 已补发 1 条上次未投递的回复");
          } catch {
            const errorId = newErrorId();
            await state.deliveryFailed(delivery.id, errorId).catch(() => undefined);
            console.error(`[wecom] 补发失败 error=${errorId} phase=reply`);
          }
        }

        const pending = await state.recoverPending();
        if (pending.length > 0) console.log(`[state] 正在恢复 ${pending.length} 个上次中断的任务`);
        await Promise.all(pending.map(async (message) => {
          const result = await app.replay(message, async (content, finish = true) => {
            if (finish) await sendWecomReply(message.groupId, content);
          });
          console.log(`[state] 恢复任务处理状态: ${result}`);
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
          client.disconnect();
          void admin.close();
          void Promise.all([app.shutdown(cancel), recovery, updateCheck]).finally(done);
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
    await onboard(option(args, "--config"));
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
    const workspace = option(args, "--workspace");
    if (!workspace) throw new Error("threadferry setup 必须提供 --workspace <absolute-path>");
    await setup(
      option(args, "--config") ?? defaultConfigPath(),
      workspace,
      option(args, "--agent") ?? "default",
      runtimeName(option(args, "--runtime")),
      option(args, "--model"),
    );
    return;
  }
  if (command === "agent") {
    const action = args[0];
    const configPath = resolve(option(args, "--config") ?? defaultConfigPath());
    const config = await loadConfig(configPath);
    if (action === "list") {
      for (const [id, agent] of Object.entries(config.agents)) {
        console.log(`${id}\t${agent.runtime}\t${agent.model ?? "default"}\t${agent.workspace}`);
      }
      return;
    }
    if (action !== "add") throw new Error("threadferry agent 仅支持 add 或 list");
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
    const restartBinary = await start(configPath, mock, adminPort(option(args, "--admin-port")));
    if (restartBinary) await runUpdated(restartBinary, [command, ...args]);
    return;
  }
  throw new Error(`未知命令: ${command}\n${USAGE}`);
}

void main().catch((error) => {
  console.error(`ThreadFerry: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
