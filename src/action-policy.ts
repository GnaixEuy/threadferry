import type { PreparedAction } from "./actions.js";

export type ActionDecision = "execute" | "confirm" | "deny_private";

/** 单一动作授权边界。凭据和 Agent 隔离由各自 host 保证，这里只决定当前资源动作是否可执行。 */
export function decideAction(input: {
  mode: PreparedAction["mode"];
  private: boolean;
  channel: "group" | "direct";
  owner: boolean;
  agentExplicit: boolean;
}): ActionDecision {
  if (input.channel === "group" && (input.mode === "read" || input.private)) return "deny_private";
  if (input.mode === "read") return "execute";
  if (input.mode === "destructive") return "confirm";
  return input.owner && input.agentExplicit ? "execute" : "confirm";
}
