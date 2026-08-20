import type { AgentView, GroupConfig, IncomingMention } from "./types.js";

export type Authorization =
  | { allowed: true; group: GroupConfig }
  | { allowed: false; reason: "group" | "mention" | "user" };

export function authorize(config: AgentView, message: IncomingMention): Authorization {
  const group = config.groups[message.groupId];
  if (!group) return { allowed: false, reason: "group" };
  if (!message.mentioned) return { allowed: false, reason: "mention" };
  if (!group.allowAll && !group.allowUsers.includes(message.senderId)) return { allowed: false, reason: "user" };
  return { allowed: true, group };
}
