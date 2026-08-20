import { listWecomSessions } from "./channels/wecom.js";
import { fetchWecomHistory } from "./history/wecom-cli.js";
import type { CommandRunner } from "./types.js";

const TTL_MS = 10 * 60 * 1000;
// 姓名只是显示用的装饰，绝不该让页面等它。给远小于默认 30s 的上限。
const LOOKUP_TIMEOUT_MS = 8_000;
const HISTORY_HOURS = 24 * 7;
const MAX_NAMES = 2_000;

/**
 * 加密 userid → 姓名。
 *
 * **企业微信通讯录不支持按 userid 反查**（`contact users search` 只认姓名/别名关键词，
 * 拿 userid 当关键词一律返回空），所以没法在渲染时按需查名字。能拿到映射的地方只有三处，
 * 这里把它们顺手收集起来：
 *
 * 1. `message aibot sessions list` 的单聊会话：`chat_id` 就是对方 userid，`chat_name` 就是姓名。
 *    这个调用群发现时本来就要发，等于免费。
 * 2. 群历史消息：每条都带 `userid` + `user_name`，覆盖群里说过话的人。
 * 3. 按姓名添加用户时顺手记下——那一刻我们本来就知道姓名和 id 的对应。
 *
 * 和归属信息一样：读取只看缓存、立刻返回，缺失或过期时后台补；任何一步失败都只是继续显示
 * 加密 id，不报错、不阻塞。没有通讯录/会话权限的机器人就一直显示 id。
 */
export class DirectoryNameCache {
  private readonly names = new Map<string, string>();
  private readonly refreshedAt = new Map<string, number>();
  private readonly inflight = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 查名字。永不发起 I/O，拿不到就返回 undefined，调用方照常显示 id。 */
  name(userId: string): string | undefined {
    return this.names.get(userId);
  }

  /** 记下一条已知映射（例如按姓名添加用户成功的那一刻）。 */
  remember(userId: string, name: string): void {
    if (!userId || !name || this.names.size >= MAX_NAMES) return;
    this.names.set(userId, name);
  }

  /** 该 Agent 的映射过期了就在后台补一次。用于页面渲染前顺手调用，本身不等待。 */
  schedule(agentId: string, runner: CommandRunner, groupIds: string[]): void {
    const at = this.refreshedAt.get(agentId);
    if (at !== undefined && this.now() - at < TTL_MS) return;
    if (this.inflight.has(agentId)) return;
    this.inflight.add(agentId);
    void this.refresh(agentId, runner, groupIds)
      .catch(() => undefined)
      .finally(() => this.inflight.delete(agentId));
  }

  /** 主动收集一次（启动预热用）。失败只是少几个名字，不抛错。 */
  async refresh(agentId: string, runner: CommandRunner, groupIds: string[]): Promise<void> {
    const bounded: CommandRunner = (command, args, options) =>
      runner(command, args, { ...options, timeoutMs: LOOKUP_TIMEOUT_MS });
    // 先记时间戳：即便下面全失败，也不要每次渲染都重试一串注定被拒的调用。
    this.refreshedAt.set(agentId, this.now());
    try {
      for (const person of (await listWecomSessions(bounded)).people) this.remember(person.id, person.name);
    } catch {
      // 会话列表不可用（没权限/机器人未授权）就跳过这个来源。
    }
    const endTime = new Date(this.now());
    for (const groupId of groupIds) {
      try {
        const history = await fetchWecomHistory(groupId, { lookbackHours: HISTORY_HOURS, maxMessages: 400, endTime }, bounded);
        for (const message of history) if (message.senderName) this.remember(message.senderId, message.senderName);
      } catch {
        // 某个群读不到历史就跳过它，别影响其他群。
      }
    }
  }
}
