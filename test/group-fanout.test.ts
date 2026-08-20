import assert from "node:assert/strict";
import test from "node:test";
import { fanOutTargets, mentionsAgent, quotedReply } from "../src/group-fanout.js";

const bots = [
  { agentId: "叶翔", botName: "叶翔" },
  { agentId: "悦翔", botName: "悦翔" },
  { agentId: "reviewer", botName: "代码审查助手" },
];
const allBound = () => true;

test("a message mentioning two bots is handed to the one WeCom skipped", () => {
  // 企业微信只把消息投给第一个被 @ 的机器人，所以收到回调的那台要把它转交给另一台。
  assert.deepEqual(
    fanOutTargets("@悦翔 @叶翔 你们好", "悦翔", bots, allBound).map((bot) => bot.agentId),
    ["叶翔"],
  );
  assert.deepEqual(
    fanOutTargets("@叶翔 @悦翔 你们好", "叶翔", bots, allBound).map((bot) => bot.agentId),
    ["悦翔"],
  );
});

test("only mentioned bots that are bound to the group get the message", () => {
  // 没被 @ 的不转交。
  assert.deepEqual(fanOutTargets("@叶翔 分析一下", "叶翔", bots, allBound), []);
  // 被 @ 了但没绑这个群的也不转交——它的 app 只会回一句「这个群没配置」。
  assert.deepEqual(
    fanOutTargets("@叶翔 @悦翔 你们好", "叶翔", bots, (agentId) => agentId !== "悦翔"),
    [],
  );
  // 收到回调的那台自己不重复处理。
  assert.deepEqual(
    fanOutTargets("@叶翔 @悦翔 你们好", "悦翔", bots, allBound).map((bot) => bot.agentId),
    ["叶翔"],
  );
});

test("a mention must end at a boundary so a name that is a prefix of another does not match", () => {
  const ye = { agentId: "叶翔" };
  assert.ok(mentionsAgent("@叶翔 你们好", ye));
  assert.ok(mentionsAgent("@叶翔", ye));                    // 结尾
  assert.ok(mentionsAgent("@叶翔@悦翔 都来", ye));            // 连续 @
  assert.ok(mentionsAgent("@叶翔，帮我看看", ye));            // 中文标点
  assert.ok(mentionsAgent("@叶翔\u2005 窄空格也算", ye));     // 企业微信有时用窄空格
  // 前缀误命中要挡住：这两条都不是在 @ 叶翔。
  assert.ok(!mentionsAgent("@叶翔2 你好", ye));
  assert.ok(!mentionsAgent("@叶翔的助手 你好", ye));
  // 同一条消息里既有误命中又有真命中时，仍要认出来。
  assert.ok(mentionsAgent("@叶翔2 和 @叶翔 一起", ye));
});

test("mentions match the bot's own name as well as the agent name", () => {
  // Agent 名和机器人名可能不同（改过名、或引导时取的名字不一样），两者都算。
  assert.deepEqual(
    fanOutTargets("@叶翔 @代码审查助手 一起看看", "叶翔", bots, allBound).map((bot) => bot.agentId),
    ["reviewer"],
  );
  assert.ok(mentionsAgent("@reviewer 看看", { agentId: "reviewer" }));
  assert.ok(!mentionsAgent("reviewer 看看", { agentId: "reviewer" }));
  // 没有机器人名时只按 Agent 名匹配，不能因为缺字段就漏掉。
  assert.ok(mentionsAgent("@叶翔 在吗", { agentId: "叶翔" }));
});

test("three bots mentioned together reach both peers", () => {
  assert.deepEqual(
    fanOutTargets("@叶翔 @悦翔 @代码审查助手 都来", "叶翔", bots, allBound).map((bot) => bot.agentId),
    ["悦翔", "reviewer"],
  );
});

test("a handed-over reply carries the original message so it reads as a reply", () => {
  // SDK 的引用气泡绑定在收到的那一帧上，转交的机器人没有；message.aibot.send 也没有引用字段。
  // 只能把原消息放进 markdown 引用块。
  assert.equal(
    quotedReply("@叶翔 @悦翔 现在可以听到我的召唤了吗", "可以，已收到。"),
    "> @叶翔 @悦翔 现在可以听到我的召唤了吗\n\n可以，已收到。",
  );
  // 多行和多余空白压成一行，否则 markdown 引用块会断掉。
  assert.equal(quotedReply("第一行\n\n  第二行  ", "好"), "> 第一行 第二行\n\n好");
  // 过长的原文截断，别把引用块撑爆。
  const long = "问".repeat(200);
  const quoted = quotedReply(long, "答");
  assert.ok(quoted.startsWith(`> ${"问".repeat(80)}…`));
  assert.ok(quoted.endsWith("\n\n答"));
  // 原文为空时不加引用块。
  assert.equal(quotedReply("   ", "答"), "答");
});
