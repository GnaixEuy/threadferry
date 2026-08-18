import assert from "node:assert/strict";
import test from "node:test";
import { authorize } from "../src/authorization.js";
import type { IncomingMention, WardenConfig } from "../src/types.js";

const config: WardenConfig = {
  version: 5,
  ownerUser: "user_allowed",
  agents: { default: { workspace: process.cwd(), runtime: "codex" } },
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
  text: "@Warden 分析",
  mentioned: true,
};

test("authorization requires configured group, mention, and allowlisted user", () => {
  assert.equal(authorize(config, message).allowed, true);
  assert.deepEqual(authorize(config, { ...message, groupId: "group_other" }), { allowed: false, reason: "group" });
  assert.deepEqual(authorize(config, { ...message, mentioned: false }), { allowed: false, reason: "mention" });
  assert.deepEqual(authorize(config, { ...message, senderId: "user_other" }), { allowed: false, reason: "user" });
});
