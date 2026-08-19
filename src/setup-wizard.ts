import { validateAgentId } from "./bots.js";
import type { IncomingWecomEvent, Reply, RuntimeName, ThreadFerryConfig } from "./types.js";

// 私聊配对的默认等待上限。太久说明机器人没收到消息或发错了账号，与其无限挂住不如明确失败。
export const DEFAULT_PAIR_TIMEOUT_MS = 5 * 60_000;
// 等待期间的心跳间隔：周期提示仍在等待，让用户知道程序没卡死。
export const DEFAULT_PAIR_HEARTBEAT_MS = 30_000;

// 1:1 架构下 Agent 名直接取自机器人名，避免用户手敲出和机器人对不上的名字。
// 撞名时自动追加序号；机器人名不合法（目录不安全）时返回 undefined，由调用方兜底询问。
export function agentNameFromBot(botName: string | undefined, existingNames: readonly string[]): string | undefined {
  if (!botName) return undefined;
  try {
    const name = validateAgentId(botName);
    if (existingNames.includes(name)) {
      let i = 2;
      while (existingNames.includes(`${name}${i}`)) i++;
      return `${name}${i}`;
    }
    return name;
  } catch {
    return undefined;
  }
}

export interface PairChannel {
  disconnect(): void;
}

export type StartPairChannel = (
  handler: (event: IncomingWecomEvent, reply: Reply) => Promise<void>,
) => PairChannel;

// 引导开场：先讲清 1:1 心智模型，这是新架构唯一的教育时机。
export function onboardIntro(hasExistingConfig: boolean): string {
  const lines = [
    "ThreadFerry 引导",
    "一个 Agent 对应一个企业微信机器人（严格 1:1），多个 Agent 并发跑在本机，彼此完全独立。",
    "想用哪个 Workspace，就和那个机器人私聊；以后要加第二个 Workspace，就再加一个 Agent + 一个机器人。",
  ];
  if (hasExistingConfig) {
    lines.push("检测到已有配置：本次可以新增一个 Agent，或为已有 Agent 重新配对 Owner。");
  }
  return lines.join("\n");
}

// 扫码授权前的预告：用户刚回答完表单，屏幕下一秒就被 wecom-cli 接管，必须先说明。
export function authAnnouncement(agentId: string, configDir: string): string {
  return [
    `Agent ${agentId} 还没有机器人凭据，接下来会打开浏览器显示二维码，为它授权企业微信机器人。`,
    `凭据目录: ${configDir}`,
    "请用企业微信 App 扫码完成授权；ThreadFerry 不经手 Bot Secret，凭据由 wecom-cli 自己加密保存。",
  ].join("\n");
}

// 配对码提示：告诉用户去哪找机器人、必须用 Owner 的账号发、发完要回终端确认。
export function pairInstructions(agentId: string, code: string): string {
  return [
    `请完成 Agent ${agentId} 的 Owner 配对（一次性配对码：${code}）：`,
    "1. 打开企业微信，找到你刚扫码授权的那个机器人（即本 Agent 对应的机器人）。",
    "2. 用你希望成为 Owner 的那个人的账号，私聊这个机器人，发送：",
    `   threadferry pair ${code}`,
    "3. 发送后回到电脑终端，确认收到的 userid。",
    "",
    "配对码只在本机终端显示，不要发给别人。",
  ].join("\n");
}

// 配对码不匹配时回复给用户。绝不能回显正确的配对码。
export function pairMismatchReply(): string {
  return "配对码不正确。请回到电脑终端，重新查看 threadferry setup 输出的配对命令后再发送。";
}

// 收到正确配对码后立即回给用户：告诉他消息已到，接下来要去电脑终端确认。
export function pairReceivedReply(): string {
  return "已收到配对请求，请在电脑终端确认是否同意本次配对。";
}

// 授权后直接认领授权用户为 Owner 的确认提示。默认同意——扫码的人就在电脑前，
// 信任根仍是本机终端（按 Enter 就是点头）。
export function ownerAdoptPrompt(agentId: string, user: { name?: string; id?: string }): string {
  const name = user.name ?? user.id ?? "未知用户";
  return `检测到授权用户 ${name}（${user.id ?? "无 ID"}）。将其设为 Agent ${agentId} 的 Owner？[Y/n]: `;
}

// 配对成功后的机器人回复：说明当前私聊的机器人对应哪个 Agent 和 Workspace。
export function pairSuccessReply(agentId: string, workspace: string): string {
  return [
    `配对完成。你现在私聊的这个机器人对应 Agent：${agentId}`,
    `Workspace：${workspace}`,
    "",
    "回到电脑终端继续启动 ThreadFerry 后，可以直接在这里发消息私聊 Agent；",
    "发送 `threadferry help` 查看群聊接入和管理方法。",
  ].join("\n");
}

export function pairTimeoutMessage(agentId: string): string {
  return `等待超时：没有收到 Agent ${agentId} 的私聊配对。请确认机器人已授权并重新执行。`;
}

export function heartbeatMessage(agentId: string, remainingSeconds: number): string {
  const remaining = remainingSeconds >= 60
    ? `约 ${Math.ceil(remainingSeconds / 60)} 分钟`
    : "不到 1 分钟";
  return `[setup] 仍在等待 Agent ${agentId} 的私聊配对…剩余 ${remaining}（Ctrl+C 可取消）`;
}

export interface SetupPlan {
  workspace: string;
  runtime: RuntimeName;
  model?: string;
  // 是否直接沿用了配置里该 Agent 已有的 Workspace/Runtime/Model。
  reused: boolean;
}

// 配对时写给 pairConfig 的 Agent 定义：沿用已有 Agent 的 config_dir，
// 避免重新配对 Owner 时丢掉自定义凭据目录。
export function agentDefinitionForPairing(
  plan: { workspace: string; runtime: RuntimeName; model?: string },
  configured?: ThreadFerryConfig["agents"][string],
): { workspace: string; runtime: RuntimeName; model?: string; configDir?: string } {
  return {
    workspace: plan.workspace,
    runtime: plan.runtime,
    ...(plan.model ? { model: plan.model } : {}),
    ...(configured?.configDir ? { configDir: configured.configDir } : {}),
  };
}

export interface SetupPlanRequest {
  workspace?: string;
  runtime?: RuntimeName;
  model?: string;
}

// 决定这次配对用什么 Workspace/Runtime：显式传参优先，否则沿用配置里该 Agent 已有的值。
// 这样换企业后重新配对 Owner 时不必再传一遍 --workspace（配置里本来就有）。
export function resolveSetupPlan(
  existing: ThreadFerryConfig | undefined,
  agentId: string,
  requested: SetupPlanRequest = {},
): SetupPlan {
  const configured = existing?.agents[agentId];
  const workspace = requested.workspace ?? configured?.workspace;
  const runtime = requested.runtime ?? configured?.runtime;
  const model = requested.model !== undefined ? requested.model : configured?.model;

  if (workspace && runtime) {
    return {
      workspace,
      runtime,
      ...(model !== undefined ? { model } : {}),
      reused: Boolean(configured) && requested.workspace === undefined,
    };
  }
  if (!workspace) {
    if (existing && !configured) {
      const names = Object.keys(existing.agents);
      throw new Error(
        `Agent ${agentId} 未配置且未提供 --workspace。` +
        (names.length > 0
          ? `已配置的 Agent：${names.join(", ")}；请用 --agent 指定已有 Agent，或用 --workspace 新增。`
          : "当前配置文件为空，请提供 --workspace 新增。"),
      );
    }
    throw new Error("threadferry setup 需要 --workspace <absolute-path>（当前没有已有配置可沿用）");
  }
  throw new Error(`Agent ${agentId} 未配置，需要 --runtime codex|pi`);
}

export type WaitForPairResult = "paired" | "timeout" | "cancelled";

export interface WaitForPairOptions {
  code: string;
  agentId: string;
  workspace: string;
  onLog: (message: string) => void;
  // 本机终端确认：信任根是本机，远端身份必须由终端点头。
  confirm: (senderId: string) => Promise<boolean>;
  onApproved: (senderId: string) => Promise<void>;
  startChannel: StartPairChannel;
  timeoutMs?: number;
  heartbeatMs?: number;
}

// 等待私聊配对：带超时、等待中的心跳提示，配对码错误会回复用户而不是只写本机终端。
export async function waitForPair(options: WaitForPairOptions): Promise<WaitForPairResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_PAIR_TIMEOUT_MS;
  const heartbeatMs = options.heartbeatMs ?? DEFAULT_PAIR_HEARTBEAT_MS;
  const startedAt = Date.now();

  return await new Promise<WaitForPairResult>((resolve) => {
    let heartbeat: NodeJS.Timeout;
    let timeout: NodeJS.Timeout;
    let client: PairChannel | undefined;
    let settled = false;
    let cancelled = false;
    let claimed = false;

    const cleanup = () => {
      if (heartbeat) clearInterval(heartbeat);
      if (timeout) clearTimeout(timeout);
      client?.disconnect();
    };
    const onInterrupt = () => {
      if (settled) return;
      cancelled = true;
      cleanup();
      resolve("cancelled");
    };
    const settle = (result: WaitForPairResult) => {
      if (settled) return;
      settled = true;
      cleanup();
      process.off("SIGINT", onInterrupt);
      process.off("SIGTERM", onInterrupt);
      resolve(result);
    };

    process.once("SIGINT", onInterrupt);
    process.once("SIGTERM", onInterrupt);

    heartbeat = setInterval(() => {
      if (settled || cancelled) return;
      const remaining = Math.max(0, timeoutMs - (Date.now() - startedAt));
      options.onLog(heartbeatMessage(options.agentId, Math.ceil(remaining / 1000)));
    }, heartbeatMs);
    timeout = setTimeout(() => {
      if (settled || cancelled) return;
      options.onLog(pairTimeoutMessage(options.agentId));
      settle("timeout");
    }, timeoutMs);
    heartbeat.unref?.();
    timeout.unref?.();

    try {
      client = options.startChannel(async (event, reply) => {
        if (settled) return;
        if (event.chatType !== "single") {
          await reply("请私聊机器人完成 ThreadFerry Owner 配对。").catch(() => undefined);
          return;
        }
        const text = event.message.text;
        if (!text.includes(`threadferry pair ${options.code}`)) {
          // 用户正看着手机，终端打印看不到；必须回给用户，但绝不能回显正确的配对码。
          await reply(pairMismatchReply()).catch(() => undefined);
          return;
        }
        if (claimed) return;
        claimed = true;
        try {
          // 先回一条确认已收到，让手机端立刻知道消息到了，并引导回到电脑终端。
          await reply(pairReceivedReply()).catch(() => undefined);
          const approved = await options.confirm(event.message.senderId);
          if (!approved) {
            claimed = false;
            await reply("本机终端未确认本次配对。").catch(() => undefined);
            return;
          }
          await options.onApproved(event.message.senderId);
          options.onLog("配对完成，配置已写入。");
          await reply(pairSuccessReply(options.agentId, options.workspace)).catch(() => undefined);
          settle("paired");
        } catch (error) {
          settle("cancelled");
        }
      });
    } catch (error) {
      settle("cancelled");
    }
  });
}