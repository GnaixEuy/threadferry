import { searchWecomUsers } from "./channels/wecom.js";
import { fetchWecomIdentity } from "./identity.js";
import type { CommandRunner } from "./types.js";

export interface AgentOrigin {
  /** 机器人自己的名字（identity whoami）。 */
  botName?: string;
  /** Owner 在通讯录里的姓名，比加密 userid 好认。 */
  ownerName?: string;
  /** Owner 的顶层部门。企业微信不提供「机器人属于哪个企业」的查询，这是最接近的可得信息。 */
  org?: string;
}

const TTL_MS = 5 * 60 * 1000;
// 这两个调用只为「好分辨」服务，绝不该让页面等它们。给一个远小于默认 30s 的上限。
const LOOKUP_TIMEOUT_MS = 5_000;

/**
 * Agent 归属信息的缓存。这些信息纯粹是装饰：**部分机器人根本没有企业通讯录权限**，
 * 拿不到就少显示一个徽章，绝不能因此报错、更不能卡住流程。
 *
 * 所以读取永远只看缓存、立刻返回；缺失或过期时在后台补一次。失败也记时间戳，
 * 避免每次渲染都去重试一个注定被拒的调用；下一个 TTL 到了会自己再试，
 * 权限后来被授予时不需要重启。
 */
export class AgentOriginCache {
  private readonly entries = new Map<string, { at: number; value: AgentOrigin }>();
  private readonly inflight = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 只读缓存，不等任何 I/O。缓存缺失或过期时顺手安排一次后台刷新。 */
  read(agentId: string, runner: CommandRunner): AgentOrigin {
    const entry = this.entries.get(agentId);
    if (!entry || this.now() - entry.at >= TTL_MS) this.schedule(agentId, runner);
    return entry?.value ?? {};
  }

  /** 主动取一次（启动时预热用）。任何一步失败都只是少字段，不抛错。 */
  async refresh(agentId: string, runner: CommandRunner): Promise<AgentOrigin> {
    const bounded: CommandRunner = (command, args, options) =>
      runner(command, args, { ...options, timeoutMs: LOOKUP_TIMEOUT_MS });
    const identity = await fetchWecomIdentity(bounded);
    const value: AgentOrigin = {
      ...(identity.bot?.name ? { botName: identity.bot.name } : {}),
      ...(identity.user?.name ? { ownerName: identity.user.name } : {}),
    };
    // 先把身份信息落进缓存：通讯录只是可选增强，它慢、被拒或干脆挂住都不该连带
    // 把已经拿到的机器人名和 Owner 姓名一起丢掉。
    this.entries.set(agentId, { at: this.now(), value });
    if (!identity.user?.name) return value;
    try {
      const [match] = await searchWecomUsers([identity.user.name], bounded);
      const org = match?.departments?.[0];
      if (!org) return value;
      const enriched = { ...value, org };
      this.entries.set(agentId, { at: this.now(), value: enriched });
      return enriched;
    } catch {
      // 没有通讯录权限（或查询失败）时就少一个徽章，其余信息照常显示。
      return value;
    }
  }

  private schedule(agentId: string, runner: CommandRunner): void {
    if (this.inflight.has(agentId)) return;
    this.inflight.add(agentId);
    void this.refresh(agentId, runner)
      // 连 whoami 都挂了：记下时间戳按住重试，保留上一次拿到的值。
      .catch(() => this.entries.set(agentId, { at: this.now(), value: this.entries.get(agentId)?.value ?? {} }))
      .finally(() => this.inflight.delete(agentId));
  }
}
