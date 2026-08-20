import assert from "node:assert/strict";
import test from "node:test";
import { actionCatalog, extractAction, isKnownAction, prepareAction } from "../src/actions.js";

const fence = (body: string) => "```threadferry-action\n" + body + "\n```";

test("an action proposal is lifted out of the reply so the group never sees raw JSON", () => {
  const reply = `好的，我建议这样安排。\n\n${fence('{"action":"schedule.create","subject":"回归测试","begin_time":"2026-08-21 10:00:00","end_time":"2026-08-21 10:30:00"}')}`;
  const result = extractAction(reply);
  assert.equal(result.reply, "好的，我建议这样安排。");
  assert.deepEqual(result.action, {
    name: "schedule.create",
    arguments: {
      subject: "回归测试",
      begin_time: "2026-08-21 10:00:00",
      end_time: "2026-08-21 10:30:00",
    },
  });
});

test("anything that is not a known action is ignored, and the block still never reaches the group", () => {
  // 白名单之外的动作名一律不认——提示词注入最多让它提议，提议不了就什么都不会发生。
  const unknown = extractAction(`看看这个\n${fence('{"action":"shell.exec","command":"rm -rf /"}')}`);
  assert.equal(unknown.action, undefined);
  assert.equal(unknown.reply, "看看这个");
  assert.ok(!unknown.reply.includes("rm -rf"));

  // 半截 JSON 同样按「没有提议」处理，绝不猜。
  const broken = extractAction(`结论如下\n${fence('{"action":"schedule.create"')}`);
  assert.equal(broken.action, undefined);
  assert.equal(broken.reply, "结论如下");

  // 没有围栏就原样返回。
  assert.deepEqual(extractAction("就是一句普通回复"), { reply: "就是一句普通回复" });
  assert.ok(!isKnownAction("shell.exec"));
  assert.ok(isKnownAction("schedule.create"));
  assert.match(actionCatalog(), /schedule\.create/);
});

test("preparing a schedule validates every field and renders a summary for the owner", async () => {
  const prepared = await prepareAction({
    name: "schedule.create",
    arguments: {
      subject: "回归测试复盘",
      begin_time: "2026-08-21 10:00:00",
      end_time: "2026-08-21 11:00:00",
      location: "线上",
      description: "关于刚才的测试",
    },
  });
  assert.match(prepared.summary, /创建日程/);
  assert.match(prepared.summary, /回归测试复盘/);
  assert.match(prepared.summary, /2026-08-21 10:00:00 → 2026-08-21 11:00:00/);
  assert.deepEqual(prepared.command.slice(0, 4), ["calendar", "schedules", "create", "--json"]);
  assert.deepEqual(JSON.parse(prepared.command[4]!), {
    subject: "回归测试复盘",
    begin_time: "2026-08-21 10:00:00",
    end_time: "2026-08-21 11:00:00",
    location: "线上",
    description: "关于刚才的测试",
  });
});

test("bad arguments are rejected instead of guessed", async () => {
  const base = { subject: "会", begin_time: "2026-08-21 10:00:00", end_time: "2026-08-21 11:00:00" };
  await assert.rejects(prepareAction({ name: "schedule.create", arguments: { ...base, subject: "" } }), /标题不能为空/);
  await assert.rejects(prepareAction({ name: "schedule.create", arguments: { ...base, begin_time: "明天十点" } }), /2026-08-21 10:00:00/);
  await assert.rejects(prepareAction({ name: "schedule.create", arguments: { ...base, end_time: "2026-08-21 09:00:00" } }), /结束时间必须晚于开始时间/);
  await assert.rejects(prepareAction({ name: "schedule.create", arguments: { ...base, subject: "长".repeat(200) } }), /过长/);
  await assert.rejects(prepareAction({ name: "shell.exec", arguments: {} }), /不支持的动作/);
});

test("attendees are resolved through the directory, never taken as raw ids", async () => {
  const asked: string[] = [];
  const prepared = await prepareAction({
    name: "schedule.create",
    arguments: {
      subject: "评审",
      begin_time: "2026-08-21 10:00:00",
      end_time: "2026-08-21 11:00:00",
      attendees: ["张三", "id:lisi", "张三"],
    },
  }, async (reference) => {
    asked.push(reference);
    return reference === "id:lisi" ? { id: "lisi", name: "李四" } : { id: "zhangsan", name: "张三" };
  });
  assert.deepEqual(asked, ["张三", "id:lisi", "张三"]);
  // 重复的人只留一份。
  assert.deepEqual(JSON.parse(prepared.command[4]!).attendees, [{ userid: "zhangsan" }, { userid: "lisi" }]);

  // 没有通讯录能力时宁可报错，也不把用户输入当 userid 直接塞进去。
  await assert.rejects(prepareAction({
    name: "schedule.create",
    arguments: { subject: "评审", begin_time: "2026-08-21 10:00:00", end_time: "2026-08-21 11:00:00", attendees: ["张三"] },
  }), /不支持解析参与人/);
});
