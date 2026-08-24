import assert from "node:assert/strict";
import test from "node:test";
import { authorize } from "../src/authorization.js";
import type { AgentView, IncomingMention } from "../src/types.js";

const config: AgentView = {
  version: 6,
  ownerUser: "user_allowed",
  agents: { default: { workspace: process.cwd(), runtime: "codex", ownerUser: "user_allowed" } },
  groups: {
    group_allowed: {
      agent: "default",
      allowUsers: ["user_allowed"],
      context: { lookbackHours: 6, maxMessages: 80 },
    },
  },
  security: { requireMention: true, readOnly: true },
};

const message: IncomingMention = {
  msgId: "msg-1",
  groupId: "group_allowed",
  senderId: "user_allowed",
  time: new Date(),
  text: "@ThreadFerry 分析",
  mentioned: true,
};

test("authorization requires configured group, mention, and allowlisted user", () => {
  assert.equal(authorize(config, message).allowed, true);
  assert.deepEqual(authorize(config, { ...message, groupId: "group_other" }), { allowed: false, reason: "group" });
  assert.deepEqual(authorize({
    ...config,
    groups: { group_allowed: { ...config.groups.group_allowed!, enabled: false } },
  }, message), { allowed: false, reason: "group" });
  assert.deepEqual(authorize(config, { ...message, mentioned: false }), { allowed: false, reason: "mention" });
  assert.deepEqual(authorize(config, { ...message, senderId: "user_other" }), { allowed: false, reason: "user" });
});

test("authorization allows any mentioned group member when allowAll is enabled", () => {
  const openConfig: AgentView = {
    ...config,
    groups: { group_allowed: { ...config.groups.group_allowed!, allowAll: true } },
  };
  assert.equal(authorize(openConfig, { ...message, senderId: "user_other" }).allowed, true);
  assert.deepEqual(authorize(openConfig, { ...message, senderId: "user_other", mentioned: false }), { allowed: false, reason: "mention" });
  assert.deepEqual(authorize(openConfig, { ...message, groupId: "group_other", senderId: "user_other" }), { allowed: false, reason: "group" });
});
