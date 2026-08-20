import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireHostLock, sessionScope, ThreadFerryState } from "../src/state.js";
import type { IncomingMention } from "../src/types.js";

const message: IncomingMention = {
  msgId: "msg-1",
  groupId: "group-1",
  senderId: "user-1",
  senderName: "用户",
  time: new Date("2026-08-18T10:05:00+08:00"),
  text: "@ThreadFerry 分析",
  mentioned: true,
};

test("state durably recovers inbox and outbox without retaining completed content", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-state-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "private", "state-v3.json");
  const first = new ThreadFerryState(path);

  assert.equal(await first.enqueue(message), true);
  await first.markRunning(message.msgId);
  await first.setSession(message.groupId, "/workspace", "session-1");

  const restarted = new ThreadFerryState(path);
  const recovered = await restarted.recoverPending();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0]?.message.text, message.text);
  assert.equal(recovered[0]?.message.time.toISOString(), message.time.toISOString());
  assert.equal(await restarted.enqueue(message), false);
  assert.equal(await restarted.session(message.groupId, "/workspace"), "session-1");

  const deliveryId = await restarted.finishWithDelivery(message.msgId, message.groupId, "handled", "分析结果");
  let snapshot = await new ThreadFerryState(path).snapshot();
  assert.equal(snapshot.inbox.length, 0);
  assert.equal(snapshot.outbox[0]?.content, "分析结果");
  assert.equal(snapshot.turns[0]?.status, "handled");

  await restarted.deliveryFailed(deliveryId, "TF-1234ABCD");
  assert.equal((await restarted.pendingDeliveries())[0]?.attempts, 1);
  await restarted.completeDelivery(deliveryId);
  snapshot = await new ThreadFerryState(path).snapshot();
  assert.equal(snapshot.outbox.length, 0);

  const proactiveId = await restarted.queueDelivery("reminder:R-1:2026-08-21", "owner", "主动汇报", "default");
  assert.match(proactiveId, /^[a-f0-9]{64}$/);
  assert.equal((await restarted.pendingDeliveries())[0]?.agent, "default");
  assert.equal((await restarted.pendingDeliveries())[0]?.proactive, true);
  assert.equal(await restarted.queueDelivery("reminder:R-1:2026-08-21", "owner", "主动汇报", "default"), proactiveId);
  assert.equal((await restarted.pendingDeliveries()).length, 1);
  await restarted.completeDelivery(proactiveId);
  assert.doesNotMatch(JSON.stringify(snapshot), /@ThreadFerry|分析结果/);
  assert.equal(await restarted.clearSession(message.groupId), true);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  assert.equal((await stat(path)).mode & 0o777, 0o600);

  const invalid = join(root, "invalid.json");
  await writeFile(invalid, '{"version":3,"turns":[],"sessions":[],"inbox":[],"outbox":[],"unexpected":true}');
  await assert.rejects(new ThreadFerryState(invalid).snapshot(), /版本或结构无效/);
});

test("host lock rejects a second process owner and replaces a stale lock", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "private", "host.lock");

  const first = await acquireHostLock(path);
  await assert.rejects(acquireHostLock(path), /已在运行/);
  await first.release();

  await writeFile(path, JSON.stringify({ pid: 2_147_483_647, token: "stale" }), { mode: 0o600 });
  const recovered = await acquireHostLock(path);
  await recovered.release();
});

test("resetting a session only clears the requested agent's session for that group", async () => {
  const state = new ThreadFerryState();
  const front = sessionScope("frontend", { runtime: "codex", workspace: "/ws-a" });
  const back = sessionScope("backend", { runtime: "pi", workspace: "/ws-b" });
  // 两个机器人同在一个群：各自有独立 Session。
  await state.setSession("shared-group", front, "front-session");
  await state.setSession("shared-group", back, "back-session");

  assert.equal(await state.clearSession("shared-group", front), true);
  assert.equal(await state.session("shared-group", front), undefined);
  // 对方的 Session 必须还在。
  assert.equal(await state.session("shared-group", back), "back-session");

  assert.equal(await state.clearSession("shared-group", front), false);
  assert.equal(await state.clearSession("shared-group", back), true);
  assert.equal(await state.session("shared-group", back), undefined);

  // 不传 scope 时清掉该群所有 Agent 的 Session。
  await state.setSession("shared-group", front, "front-again");
  await state.setSession("shared-group", back, "back-again");
  assert.equal(await state.clearSession("shared-group"), true);
  assert.equal(await state.session("shared-group", front), undefined);
  assert.equal(await state.session("shared-group", back), undefined);
});

test("reminders survive restart, retry failures and reschedule recurring work", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "threadferry-reminder-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "state.json");
  const state = new ThreadFerryState(path);
  const reminder = await state.createReminder({
    agent: "default",
    chatId: "owner",
    chatType: "single",
    createdBy: "owner",
    instruction: "检查未完成待办并汇报",
    runAt: "2026-08-21T01:00:00.000Z",
    repeatMinutes: 60,
  });

  const restarted = new ThreadFerryState(path);
  assert.equal((await restarted.listReminders("default"))[0]?.instruction, "检查未完成待办并汇报");
  let claimed = await restarted.claimDueReminders(new Date("2026-08-21T01:00:01.000Z"));
  assert.equal(claimed[0]?.id, reminder.id);
  await restarted.finishReminder(reminder.id, false, new Date("2026-08-21T01:01:00.000Z"));
  assert.equal((await restarted.listReminders("default"))[0]?.failures, 1);
  assert.equal((await restarted.claimDueReminders(new Date("2026-08-21T01:05:59.000Z"))).length, 0);
  claimed = await restarted.claimDueReminders(new Date("2026-08-21T01:06:01.000Z"));
  assert.equal(claimed.length, 1);
  await restarted.finishReminder(reminder.id, true, new Date("2026-08-21T01:06:02.000Z"));
  const scheduled = (await restarted.listReminders("default"))[0]!;
  assert.equal(scheduled.status, "scheduled");
  assert.equal(scheduled.nextRunAt, "2026-08-21T02:06:02.000Z");
});

test("work items hand off between isolated agents and require reviewer completion", async () => {
  const state = new ThreadFerryState();
  const task = await state.createWorkItem({
    title: "核对季度复盘",
    description: "读取文档并列出未完成事项",
    createdBy: "owner",
    createdAgent: "planner",
    assignedAgent: "researcher",
    reviewerAgent: "reviewer",
    sourceChatId: "owner",
    sourceChatType: "single",
  });

  assert.equal((await state.claimWorkItems("planner")).length, 0);
  const execution = await state.claimWorkItems("researcher");
  assert.equal(execution[0]?.id, task.id);
  assert.equal(execution[0]?.status, "running");
  assert.equal((await state.claimWorkItems("researcher", new Date(Date.now() + 59 * 60_000))).length, 0);
  assert.equal((await state.claimWorkItems("researcher", new Date(Date.now() + 61 * 60_000)))[0]?.id, task.id);
  await state.completeWorkItem(task.id, "张三的上线复核未完成");
  assert.equal((await state.getWorkItem(task.id))?.status, "review");

  const review = await state.claimWorkItems("reviewer");
  assert.equal(review[0]?.status, "reviewing");
  await state.completeWorkItem(task.id, "结论准确，可以发送");
  const completed = await state.getWorkItem(task.id);
  assert.equal(completed?.status, "completed");
  assert.equal(completed?.result, "张三的上线复核未完成");
  assert.equal(completed?.review, "结论准确，可以发送");
});

test("activity records are durable, bounded and agent-scoped", async () => {
  const state = new ThreadFerryState();
  await state.recordActivity({ agent: "a", type: "action.read", outcome: "success", resource: "doc:doc-1" });
  await state.recordActivity({ agent: "b", type: "runtime.completed", outcome: "success" });
  assert.deepEqual((await state.recentActivities(10, "a")).map(({ type, resource }) => ({ type, resource })), [
    { type: "action.read", resource: "doc:doc-1" },
  ]);
});
