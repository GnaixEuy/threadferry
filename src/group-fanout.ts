/**
 * 企业微信只把一条群消息投给**第一个被 @ 的机器人**。
 *
 * 实测（同一个群、两台机器人都已绑定、去重修复已生效）：
 * - `@叶翔 @悦翔 你们好` → 只有 叶翔 回，状态里只有一条 turn
 * - `@悦翔 @叶翔 你们好` → 只有 悦翔 回，状态里同样只有一条 turn
 *
 * 也就是说第二台机器人**根本收不到回调**，不是 ThreadFerry 把它丢了。但用户 @ 了两台就期望
 * 两台都回，而 ThreadFerry 的多个 Agent 本来就跑在同一个进程里，所以由收到回调的那台把同一条
 * 消息在进程内转交给其他被 @ 到的 Agent，各自用自己的机器人凭据回复。
 */

export interface FanOutCandidate {
  agentId: string;
  /** 机器人自己的名字（可能和 Agent 名不同）。 */
  botName?: string;
}

// 名字后面必须是这些才算一次完整的 @，否则 `@叶翔2` / `@叶翔的助手` 会被误判成 @ 了「叶翔」。
// 企业微信的 @ 后面通常跟一个空格（有时是 U+2005 之类的窄空格），连续 @ 时直接跟下一个 @。
const MENTION_BOUNDARY = /[\s@,，、。：:；;!！?？…"'）)\]】]/u;

/**
 * 群消息里的 @ 是纯文本（`@叶翔 你们好`）：企业微信的回调帧里**没有结构化的被 @ 列表**
 * （`BaseMessage` 只给 `text.content`），所以只能按名字匹配。Agent 名和机器人名都算，命中任一即可。
 *
 * 名字后面要求是空白、标点或另一个 `@`，避免前缀误命中。
 */
export function mentionsAgent(text: string, candidate: FanOutCandidate): boolean {
  return [candidate.agentId, candidate.botName].some((name) => {
    if (!name) return false;
    let from = 0;
    for (;;) {
      const at = text.indexOf(`@${name}`, from);
      if (at === -1) return false;
      const next = text[at + name.length + 1];
      if (next === undefined || MENTION_BOUNDARY.test(next)) return true;
      from = at + 1;
    }
  });
}

/** 挑出该由谁接手：被 @ 到、绑了这个群、且不是已经收到回调的那台。 */
export function fanOutTargets<T extends FanOutCandidate>(
  text: string,
  receivedBy: string,
  candidates: T[],
  boundToGroup: (agentId: string) => boolean,
): T[] {
  return candidates.filter((candidate) => candidate.agentId !== receivedBy
    && boundToGroup(candidate.agentId)
    && mentionsAgent(text, candidate));
}

// 引用的那个气泡来自 SDK 的 replyStream，它绑定在「收到的那一帧」上。转交的 Agent 没有这一帧，
// 只能走 message.aibot.send，而这个接口没有引用字段（只有 chat_id + 正文）。
// 所以把原消息用 markdown 引用块放在正文开头，让它在群里仍然看得出是在回哪条。
const QUOTE_LIMIT = 80;

export function quotedReply(askedText: string, content: string): string {
  const asked = askedText.replace(/\s+/g, " ").trim();
  if (!asked) return content;
  const shown = asked.length > QUOTE_LIMIT ? `${asked.slice(0, QUOTE_LIMIT)}…` : asked;
  return `> ${shown}\n\n${content}`;
}
