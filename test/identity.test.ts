import assert from "node:assert/strict";
import test from "node:test";
import { adoptOwner } from "../src/config.js";
import { describeIdentity, fetchWecomIdentity, parseWecomIdentity } from "../src/identity.js";
import type { CommandRunner, ThreadFerryConfig } from "../src/types.js";

// wecom-cli identity.whoami 的真实返回结构。
const CONTEXT = [
  "<extra_identity_context>",
  "机器人身份：",
  "名字：叶翔",
  "ID：aibS5gFrdrjbT-Fluj16LwTkz9q49rDIoGL",
  "授权真人用户身份：",
  "名字：苏粤翔",
  "ID：wowBknbgAAEjKsK21Vxzm9XydTQ8NcIw",
  "CLI 调用一定由你的机器人身份代用户执行。",
  "</extra_identity_context>",
].join("\n");

test("identity parsing separates the bot from the authorized human", () => {
  const identity = parseWecomIdentity(CONTEXT);
  assert.deepEqual(identity.bot, { name: "叶翔", id: "aibS5gFrdrjbT-Fluj16LwTkz9q49rDIoGL" });
  assert.deepEqual(identity.user, { name: "苏粤翔", id: "wowBknbgAAEjKsK21Vxzm9XydTQ8NcIw" });
  assert.equal(describeIdentity(identity.user), "苏粤翔（wowBknbgAAEjKsK21Vxzm9XydTQ8NcIw）");
  assert.equal(describeIdentity({ id: "only-id" }), "only-id");
  assert.equal(describeIdentity(undefined), undefined);
});

test("identity parsing degrades instead of throwing on unexpected text", async () => {
  assert.deepEqual(parseWecomIdentity(""), {});
  assert.deepEqual(parseWecomIdentity("上游换了文案，没有任何身份段落"), {});
  // 只有机器人段落时，不能把后面的说明文字误当成授权用户。
  const botOnly = parseWecomIdentity("机器人身份：\n名字：叶翔\nID：aib-1\n");
  assert.deepEqual(botOnly.bot, { name: "叶翔", id: "aib-1" });
  assert.equal(botOnly.user, undefined);

  const broken: CommandRunner = async () => ({ stdout: "not json", stderr: "" });
  assert.deepEqual(await fetchWecomIdentity(broken), {});
  const failing: CommandRunner = async () => { throw new Error("wecom-cli 未授权"); };
  assert.deepEqual(await fetchWecomIdentity(failing), {});
  const empty: CommandRunner = async () => ({ stdout: JSON.stringify({ extra_identity_context: null }), stderr: "" });
  assert.deepEqual(await fetchWecomIdentity(empty), {});
});

test("fetchWecomIdentity uses the official identity command", async () => {
  let received: string[] | undefined;
  const runner: CommandRunner = async (command, args) => {
    assert.equal(command, "wecom-cli");
    received = args;
    return { stdout: JSON.stringify({ extra_identity_context: CONTEXT }), stderr: "" };
  };
  const identity = await fetchWecomIdentity(runner);
  assert.deepEqual(received, ["identity", "whoami", "--json", "{}"]);
  assert.equal(identity.user?.id, "wowBknbgAAEjKsK21Vxzm9XydTQ8NcIw");
});

test("adopting a new owner migrates the old owner inside every group allowlist", () => {
  const config: ThreadFerryConfig = {
    version: 6,
    ownerUser: "old-owner",
    agents: { default: { runtime: "codex", workspace: "/workspace", ownerUser: "old-owner" } },
    groups: {
      a: { agent: "default", allowUsers: ["old-owner", "teammate"], context: { lookbackHours: 6, maxMessages: 80 } },
      b: { agent: "default", allowUsers: ["teammate"], allowAll: true, context: { lookbackHours: 6, maxMessages: 80 } },
    },
    security: { requireMention: true, readOnly: true },
  };
  const migrated = adoptOwner(config, "default", "new-owner");

  assert.equal(migrated.ownerUser, "new-owner");
  assert.deepEqual(migrated.groups.a?.allowUsers, ["new-owner", "teammate"]);
  // 原先没有 Owner 的群也要补上，否则迁移后 Owner 反而进不了自己的群。
  assert.deepEqual(migrated.groups.b?.allowUsers, ["teammate", "new-owner"]);
  assert.equal(migrated.groups.b?.allowAll, true);
  // 原配置不被就地修改。
  assert.equal(config.ownerUser, "old-owner");
  assert.deepEqual(config.groups.a?.allowUsers, ["old-owner", "teammate"]);
  assert.throws(() => adoptOwner(config, "default", "bad userid!"), /userid 无效/);
  assert.throws(() => adoptOwner(config, "missing", "new-owner"), /Agent missing 未配置/);
});
