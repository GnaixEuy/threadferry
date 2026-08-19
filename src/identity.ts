import { runCommand } from "./process.js";
import type { CommandRunner } from "./types.js";

export interface WecomIdentity {
  bot?: { name?: string; id?: string };
  user?: { name?: string; id?: string };
}

const SECTIONS: Array<[keyof WecomIdentity, RegExp]> = [
  ["bot", /机器人身份[:：]([\s\S]*?)(?=授权真人用户身份[:：]|$)/],
  ["user", /授权真人用户身份[:：]([\s\S]*?)(?=机器人身份[:：]|CLI 调用|<\/extra_identity_context>|$)/],
];

// wecom-cli identity.whoami 只返回一段散文（extra_identity_context），没有结构化字段。
// 这里做容错解析：任何一段解析不出来就留空，绝不抛错——身份信息只用于本机提示，
// 不能因为上游文案调整就挡住 ThreadFerry 启动。
export function parseWecomIdentity(context: string): WecomIdentity {
  const identity: WecomIdentity = {};
  for (const [key, pattern] of SECTIONS) {
    const block = context.match(pattern)?.[1];
    if (!block) continue;
    const name = block.match(/名字[:：]\s*(.+)/)?.[1]?.trim();
    const id = block.match(/\bID[:：]\s*(.+)/i)?.[1]?.trim();
    if (!name && !id) continue;
    identity[key] = { ...(name ? { name } : {}), ...(id ? { id } : {}) };
  }
  return identity;
}

export function describeIdentity(party: { name?: string; id?: string } | undefined): string | undefined {
  if (!party?.name && !party?.id) return undefined;
  if (party.name && party.id) return `${party.name}（${party.id}）`;
  return party.name ?? party.id;
}

export async function fetchWecomIdentity(runner: CommandRunner = runCommand): Promise<WecomIdentity> {
  let context: unknown;
  try {
    const { stdout } = await runner("wecom-cli", ["identity", "whoami", "--json", "{}"], { timeoutMs: 30_000 });
    const response: unknown = JSON.parse(stdout.trim());
    if (!response || typeof response !== "object") return {};
    context = (response as Record<string, unknown>).extra_identity_context;
  } catch {
    return {};
  }
  return typeof context === "string" ? parseWecomIdentity(context) : {};
}
