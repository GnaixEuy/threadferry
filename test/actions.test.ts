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
  assert.ok(isKnownAction("meeting.create"));
  assert.ok(isKnownAction("mail.search"));
  assert.ok(isKnownAction("doc.create"));
  assert.ok(isKnownAction("disk.search"));
  assert.match(actionCatalog(), /schedule\.create/);
  assert.match(actionCatalog(), /meeting\.create[\s\S]*attendees/);
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
  await assert.rejects(prepareAction({ name: "schedule.create", arguments: { ...base, begin_time: "2026-02-30 10:00:00" } }), /不是有效时间/);
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

test("meeting creation converts local time and invites resolved directory users", async () => {
  const prepared = await prepareAction({
    name: "meeting.create",
    arguments: {
      subject: "刚才的测试复盘",
      begin_time: "2026-08-20 17:00:00",
      end_time: "2026-08-20 17:30:00",
      attendees: ["平平无奇小天才"],
    },
  }, async (reference) => ({ id: "encrypted-user-id", name: reference }));

  assert.match(prepared.summary, /创建会议/);
  assert.match(prepared.summary, /参与人：平平无奇小天才/);
  assert.deepEqual(prepared.command.slice(0, 3), ["meeting", "create", "--json"]);
  assert.deepEqual(JSON.parse(prepared.command[3]!), {
    subject: "刚才的测试复盘",
    begin_time: String(Date.parse("2026-08-20T17:00:00+08:00") / 1000),
    end_time: String(Date.parse("2026-08-20T17:30:00+08:00") / 1000),
    attendees: [{ userid: "encrypted-user-id" }],
  });
});

test("read actions prepare official meeting, schedule-free and todo commands", async () => {
  const meeting = await prepareAction({
    name: "meeting.search",
    arguments: { keywords: ["测试复盘"], begin_time: "2026-08-20 00:00:00", end_time: "2026-08-21 23:59:59" },
  });
  assert.equal(meeting.mode, "read");
  assert.deepEqual(meeting.command.slice(0, 3), ["meeting", "search", "--json"]);
  assert.deepEqual(JSON.parse(meeting.command[3]!), {
    keywords: ["测试复盘"],
    begin_time: "2026-08-20 00:00:00",
    end_time: "2026-08-21 23:59:59",
    limit: 10,
  });

  const free = await prepareAction({
    name: "schedule.free",
    arguments: {
      attendees: ["张三", "李四"],
      begin_time: "2026-08-21 09:00:00",
      end_time: "2026-08-21 18:00:00",
      min_duration_minutes: 45,
    },
  }, async (reference) => ({ id: `${reference}-id`, name: reference }));
  assert.equal(free.mode, "read");
  assert.deepEqual(free.command.slice(0, 5), ["calendar", "schedules", "free", "list", "--json"]);
  assert.deepEqual(JSON.parse(free.command[5]!).userids, [{ userid: "张三-id" }, { userid: "李四-id" }]);

  const todos = await prepareAction({ name: "todo.list", arguments: { keywords: "上线", status: "all" } });
  assert.equal(todos.mode, "read");
  assert.deepEqual(JSON.parse(todos.command[3]!), {
    keywords: ["上线"],
    status_filter: ["proceed", "finished"],
    limit: 10,
  });
});

test("todo creation and lifecycle actions validate ids, deadlines and people", async () => {
  const todo = await prepareAction({
    name: "todo.create",
    arguments: {
      title: "完成上线复盘",
      description: "整理结论",
      deadline: "2026-08-21 18:00:00",
      attendees: ["张三"],
    },
  }, async (reference) => ({ id: "zhangsan-id", name: reference }));
  assert.equal(todo.mode, "write");
  assert.deepEqual(todo.command.slice(0, 3), ["todo", "create", "--json"]);
  assert.deepEqual(JSON.parse(todo.command[3]!), {
    items: [{
      title: "完成上线复盘",
      description: "整理结论",
      deadline: { type: "datetime", value: "2026-08-21 18:00:00" },
      follower_ids: ["zhangsan-id"],
    }],
  });

  const cancel = await prepareAction({ name: "meeting.cancel", arguments: { meeting_id: "meeting-id" } });
  assert.equal(cancel.mode, "destructive");
  assert.deepEqual(JSON.parse(cancel.command[3]!), { meeting_id: "meeting-id" });

  const finish = await prepareAction({ name: "todo.finish", arguments: { todo_id: "todo-id" } });
  assert.equal(finish.mode, "destructive");
  assert.deepEqual(JSON.parse(finish.command[3]!), { items: [{ todo_id: "todo-id", finished_all: true }] });

  const update = await prepareAction({
    name: "todo.update",
    arguments: { todo_id: "todo-id", title: "新的标题", description: "", deadline: "2026-08-22" },
  });
  assert.equal(update.mode, "write");
  assert.deepEqual(JSON.parse(update.command[3]!), {
    items: [{ todo_id: "todo-id", title: "新的标题", description: "", deadline: { type: "date", value: "2026-08-22" } }],
  });
});

test("mail, document and disk actions use official commands and keep private data in owner chat", async () => {
  const resolve = async (reference: string) => ({ id: `${reference}-id`, name: reference });
  const mailSearch = await prepareAction({
    name: "mail.search",
    arguments: { keywords: ["上线"], sender: "张三", only_unread: true },
  });
  assert.equal(mailSearch.mode, "read");
  assert.equal(mailSearch.private, true);
  assert.deepEqual(mailSearch.command.slice(0, 3), ["mail", "search", "--json"]);
  assert.deepEqual(JSON.parse(mailSearch.command[3]!), {
    keywords: ["上线"], sender: "张三", only_unread: true, limit: 10,
  });

  const mailSend = await prepareAction({
    name: "mail.send",
    arguments: {
      to: ["external@example.com", "李四"],
      cc: ["王五"],
      subject: "上线通知",
      content: "今天完成上线。",
    },
  }, resolve);
  assert.equal(mailSend.mode, "destructive");
  assert.equal(mailSend.private, true);
  assert.deepEqual(JSON.parse(mailSend.command[3]!), {
    to: { emails: ["external@example.com"], userids: ["李四-id"] },
    cc: { userids: ["王五-id"] },
    subject: "上线通知",
    content: "今天完成上线。",
    content_type: "markdown",
  });
  const externalMail = await prepareAction({
    name: "mail.send",
    arguments: { to: ["external@example.com"], subject: "通知", content: "正文" },
  });
  assert.deepEqual(JSON.parse(externalMail.command[3]!).to, { emails: ["external@example.com"] });

  const doc = await prepareAction({
    name: "doc.create",
    arguments: { doc_name: "上线复盘", content: "# 结论" },
  });
  assert.equal(doc.mode, "write");
  assert.equal(doc.private, true);
  assert.deepEqual(JSON.parse(doc.command[3]!), {
    doc_name: "上线复盘", doc_type: "doc", content: "# 结论", content_type: "markdown",
  });

  const disk = await prepareAction({
    name: "disk.search",
    arguments: { keywords: "复盘", file_types: ["doc", "pdf"], space_keywords: ["项目"] },
  });
  assert.equal(disk.mode, "read");
  assert.equal(disk.private, true);
  assert.deepEqual(disk.command.slice(0, 4), ["disk", "files", "search", "--json"]);
  assert.deepEqual(JSON.parse(disk.command[4]!), {
    keywords: ["复盘"], file_types: ["doc", "pdf"], space_keywords: ["项目"], search_type: "all", limit: 10,
  });
});
