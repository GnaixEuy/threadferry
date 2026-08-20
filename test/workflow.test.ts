import assert from "node:assert/strict";
import test from "node:test";
import { ThreadFerryState } from "../src/state.js";
import { runWorkflowTick, type WorkflowHost } from "../src/workflow.js";

test("a due reminder wakes its agent and proactively sends the result", async () => {
  const state = new ThreadFerryState();
  const reminder = await state.createReminder({
    agent: "assistant",
    chatId: "owner",
    chatType: "single",
    createdBy: "owner",
    instruction: "检查未完成待办并汇报",
    runAt: "2026-08-21T01:00:00.000Z",
  });
  const calls: string[] = [];
  const notices: string[] = [];
  const host: WorkflowHost = {
    agentId: "assistant",
    ownerUser: "owner",
    runAutomation: async (_id, instruction) => { calls.push(instruction); return "还有 2 个待办未完成。"; },
    notify: async (_chatId, content) => { notices.push(content); },
  };

  await runWorkflowTick(state, [host], new Date("2026-08-21T01:00:01.000Z"));
  assert.deepEqual(calls, ["检查未完成待办并汇报"]);
  assert.match(notices[0] ?? "", /定时任务已完成[\s\S]*2 个待办/);
  assert.equal((await state.listReminders())[0]?.status, "completed");
  const fired = (await state.recentActivities(10)).find((item) => item.type === "reminder.fired");
  assert.equal(fired?.resource, reminder.id);
});

test("a failed proactive delivery retries the outbox without running the reminder twice", async () => {
  const state = new ThreadFerryState();
  await state.createReminder({
    agent: "assistant",
    chatId: "owner",
    chatType: "single",
    createdBy: "owner",
    instruction: "生成日报",
    runAt: "2026-08-21T01:00:00.000Z",
  });
  let runs = 0;
  let sends = 0;
  const host: WorkflowHost = {
    agentId: "assistant",
    ownerUser: "owner",
    runAutomation: async () => { runs += 1; return "日报完成"; },
    notify: async () => {
      sends += 1;
      if (sends === 1) throw new Error("temporary failure");
    },
  };

  await runWorkflowTick(state, [host], new Date("2026-08-21T01:00:01.000Z"));
  assert.equal(runs, 1);
  assert.equal((await state.listReminders())[0]?.status, "completed");
  assert.equal((await state.pendingDeliveries()).length, 1);

  await runWorkflowTick(state, [host], new Date("2026-08-21T01:00:31.000Z"));
  assert.equal(runs, 1);
  assert.equal(sends, 2);
  assert.equal((await state.pendingDeliveries()).length, 0);
});

test("a work item executes on one agent and is reviewed by another without sharing sessions", async () => {
  const state = new ThreadFerryState();
  const task = await state.createWorkItem({
    title: "核对季度复盘",
    description: "读取复盘并列出未完成事项",
    createdBy: "owner",
    createdAgent: "planner",
    assignedAgent: "researcher",
    reviewerAgent: "reviewer",
    sourceChatId: "owner",
    sourceChatType: "single",
  });
  const calls: Array<{ agent: string; id: string; instruction: string; context?: string }> = [];
  const notices: string[] = [];
  const host = (agentId: string, output: string): WorkflowHost => ({
    agentId,
    ownerUser: "owner",
    runAutomation: async (id, instruction, _createdBy, context) => {
      calls.push({ agent: agentId, id, instruction, ...(context ? { context } : {}) });
      return output;
    },
    notify: async (_chatId, content) => { notices.push(content); },
  });
  const hosts = [
    host("planner", "unused"),
    host("researcher", "张三的上线复核未完成"),
    host("reviewer", "结论准确，可以交付"),
  ];

  await runWorkflowTick(state, hosts);
  assert.equal((await state.getWorkItem(task.id))?.status, "review");
  assert.equal(calls[0]?.agent, "researcher");
  assert.equal(calls[0]?.context, undefined);

  await runWorkflowTick(state, hosts);
  const completed = await state.getWorkItem(task.id);
  assert.equal(completed?.status, "completed");
  assert.equal(calls[1]?.agent, "reviewer");
  assert.match(calls[1]?.context ?? "", /任务说明[\s\S]*张三的上线复核未完成/);
  assert.match(notices.at(-1) ?? "", /协作任务[\s\S]*已完成[\s\S]*复核意见[\s\S]*可以交付/);
});

test("a persisted cross-owner work item is rejected before a runtime starts", async () => {
  const state = new ThreadFerryState();
  const task = await state.createWorkItem({
    title: "越权任务",
    description: "读取另一企业的数据",
    createdBy: "owner-a",
    createdAgent: "planner",
    assignedAgent: "outsider",
    sourceChatId: "owner-a",
    sourceChatType: "single",
  });
  let runs = 0;
  const hosts: WorkflowHost[] = [
    { agentId: "planner", ownerUser: "owner-a", runAutomation: async () => "", notify: async () => undefined },
    { agentId: "outsider", ownerUser: "owner-b", runAutomation: async () => { runs += 1; return "不应执行"; }, notify: async () => undefined },
  ];

  await runWorkflowTick(state, hosts);
  assert.equal(runs, 0);
  assert.equal((await state.getWorkItem(task.id))?.status, "failed");
  assert.equal((await state.recentActivities()).find((item) => item.resource === task.id)?.type, "work.denied");
});

test("an interrupted work item returns to the inbox instead of becoming a permanent failure", async () => {
  const state = new ThreadFerryState();
  const task = await state.createWorkItem({
    title: "长任务",
    description: "继续分析",
    createdBy: "owner",
    createdAgent: "assistant",
    assignedAgent: "assistant",
    sourceChatId: "owner",
    sourceChatType: "single",
  });
  const host: WorkflowHost = {
    agentId: "assistant",
    ownerUser: "owner",
    runAutomation: async () => {
      const error = new Error("shutdown");
      error.name = "AbortError";
      throw error;
    },
    notify: async () => undefined,
  };

  await runWorkflowTick(state, [host]);
  assert.equal((await state.getWorkItem(task.id))?.status, "queued");
  assert.equal((await state.recentActivities()).find((item) => item.resource === task.id)?.type, "work.interrupted");
});
