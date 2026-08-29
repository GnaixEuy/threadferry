import { newErrorId, ThreadFerryState, type ReminderRecord, type WorkItemRecord } from "./state.js";

export interface WorkflowHost {
  agentId: string;
  ownerUser: string;
  runAutomation: (id: string, instruction: string, createdBy: string, untrustedContext?: string) => Promise<string>;
  canNotify?: (chatId: string) => boolean;
  notify: (chatId: string, content: string) => Promise<void>;
}

const MAX_NOTIFICATION_BYTES = 12_000;

function notificationContent(content: string): string {
  if (Buffer.byteLength(content) <= MAX_NOTIFICATION_BYTES) return content;
  const suffix = "\n\n[通知已截断]";
  const bytes = Buffer.from(content).subarray(0, MAX_NOTIFICATION_BYTES - Buffer.byteLength(suffix));
  return bytes.toString("utf8").replace(/\uFFFD$/, "") + suffix;
}

async function notifyDurably(
  state: ThreadFerryState,
  hosts: WorkflowHost[],
  agent: string,
  identity: string,
  chatId: string,
  content: string,
): Promise<void> {
  const host = hosts.find((item) => item.agentId === agent);
  if (host?.canNotify?.(chatId) === false) return;
  let deliveryId: string;
  try {
    deliveryId = await state.queueDelivery(identity, chatId, notificationContent(content), agent);
  } catch {
    await state.recordActivity({ agent, type: "notification.send", outcome: "failure", resource: identity }).catch(() => undefined);
    return;
  }
  if (!host) return;
  try {
    const delivery = (await state.pendingDeliveries()).find((item) => item.id === deliveryId);
    if (!delivery) return;
    await host.notify(delivery.groupId, delivery.content);
    await state.completeDelivery(deliveryId);
    await state.recordActivity({ agent, type: "notification.send", outcome: "success", resource: identity }).catch(() => undefined);
  } catch {
    await state.deliveryFailed(deliveryId, newErrorId()).catch(() => undefined);
    await state.recordActivity({ agent, type: "notification.send", outcome: "failure", resource: identity }).catch(() => undefined);
  }
}

async function flushNotifications(state: ThreadFerryState, hosts: WorkflowHost[]): Promise<void> {
  const deliveries = (await state.pendingDeliveries()).filter((delivery) => delivery.proactive && delivery.agent
    && hosts.some((host) => host.agentId === delivery.agent));
  await Promise.all(deliveries.map(async (delivery) => {
    const host = hosts.find((item) => item.agentId === delivery.agent)!;
    if (host.canNotify?.(delivery.groupId) === false) {
      await state.completeDelivery(delivery.id);
      await state.recordActivity({ agent: host.agentId, type: "notification.cancelled", outcome: "info", resource: delivery.id }).catch(() => undefined);
      return;
    }
    try {
      await host.notify(delivery.groupId, delivery.content);
      await state.completeDelivery(delivery.id);
      await state.recordActivity({ agent: host.agentId, type: "notification.retry", outcome: "success", resource: delivery.id }).catch(() => undefined);
    } catch {
      await state.deliveryFailed(delivery.id, newErrorId()).catch(() => undefined);
      await state.recordActivity({ agent: host.agentId, type: "notification.retry", outcome: "failure", resource: delivery.id }).catch(() => undefined);
    }
  }));
}

async function runReminder(state: ThreadFerryState, reminder: ReminderRecord, hosts: WorkflowHost[], now: Date): Promise<void> {
  const host = hosts.find((item) => item.agentId === reminder.agent);
  if (!host) {
    await state.finishReminder(reminder.id, false, now);
    await state.recordActivity({ agent: reminder.agent, type: "reminder.fired", outcome: "failure", resource: reminder.id }).catch(() => undefined);
    return;
  }
  if (reminder.chatType === "group" && host.canNotify?.(reminder.chatId) === false) {
    await state.cancelReminder(reminder.id);
    await state.recordActivity({ agent: reminder.agent, type: "reminder.cancelled", outcome: "info", resource: reminder.id }).catch(() => undefined);
    return;
  }
  let content: string;
  try {
    content = await host.runAutomation(`reminder:${reminder.id}`, reminder.instruction, reminder.createdBy);
  } catch {
    await state.finishReminder(reminder.id, false, now);
    await state.recordActivity({ agent: reminder.agent, type: "reminder.fired", outcome: "failure", resource: reminder.id }).catch(() => undefined);
    return;
  }
  await state.finishReminder(reminder.id, true, now);
  await state.recordActivity({ agent: reminder.agent, type: "reminder.fired", outcome: "success", resource: reminder.id }).catch(() => undefined);
  await notifyDurably(state, hosts, reminder.agent, `reminder:${reminder.id}:${reminder.nextRunAt}`, reminder.chatId, `定时任务已完成：\n\n${content}`);
}

function taskInstruction(task: WorkItemRecord): { instruction: string; context?: string } {
  if (task.status === "reviewing") {
    return {
      instruction: `复核协作任务“${task.title}”的执行结果。指出错误或遗漏，并给出是否可以交付的明确结论。`,
      context: `任务说明：${task.description}\n\n执行结果：${task.result ?? "没有执行结果"}`,
    };
  }
  return { instruction: `执行协作任务“${task.title}”：${task.description}` };
}

async function notifyTask(state: ThreadFerryState, task: WorkItemRecord, hosts: WorkflowHost[]): Promise<void> {
  const current = await state.getWorkItem(task.id);
  if (!current) return;
  const content = current.status === "review"
    ? `协作任务 ${current.id} 已由 ${current.assignedAgent} 执行，正在等待 ${current.reviewerAgent} 复核。\n\n${current.result ?? ""}`
    : current.status === "completed"
      ? `协作任务 ${current.id} 已完成。\n\n${current.result ?? ""}${current.review ? `\n\n复核意见：\n${current.review}` : ""}`
      : `协作任务 ${current.id} 执行失败。`;
  await notifyDurably(state, hosts, current.createdAgent, `work:${current.id}:${current.status}`, current.sourceChatId, content);
}

async function runTask(state: ThreadFerryState, task: WorkItemRecord, host: WorkflowHost, hosts: WorkflowHost[]): Promise<void> {
  const source = hosts.find((item) => item.agentId === task.createdAgent);
  if (!source || source.ownerUser !== host.ownerUser) {
    await state.failWorkItem(task.id, "协作任务跨越了 Owner 边界，已拒绝执行。");
    await state.recordActivity({ agent: host.agentId, type: "work.denied", outcome: "failure", resource: task.id }).catch(() => undefined);
    await notifyTask(state, task, hosts).catch(() => undefined);
    return;
  }
  if (task.sourceChatType === "group" && source.canNotify?.(task.sourceChatId) === false) {
    await state.failWorkItem(task.id, "来源群的机器人绑定已移除，协作任务已取消。");
    await state.recordActivity({ agent: host.agentId, type: "work.cancelled", outcome: "info", resource: task.id }).catch(() => undefined);
    return;
  }
  const { instruction, context } = taskInstruction(task);
  try {
    const result = await host.runAutomation(`work:${task.id}:${task.status}`, instruction, task.createdBy, context);
    await state.completeWorkItem(task.id, result);
    await state.recordActivity({ agent: host.agentId, type: task.status === "reviewing" ? "work.review" : "work.execute", outcome: "success", resource: task.id }).catch(() => undefined);
    await notifyTask(state, task, hosts).catch(() => undefined);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      await state.releaseWorkItem(task.id);
      await state.recordActivity({ agent: host.agentId, type: "work.interrupted", outcome: "info", resource: task.id }).catch(() => undefined);
      return;
    }
    await state.failWorkItem(task.id, "Agent 执行失败，请检查 Activity 后重新转交任务。");
    await state.recordActivity({ agent: host.agentId, type: task.status === "reviewing" ? "work.review" : "work.execute", outcome: "failure", resource: task.id }).catch(() => undefined);
    await notifyTask(state, task, hosts).catch(() => undefined);
  }
}

/** 执行一次到期提醒和 Agent 协作任务调度。并发由各 Agent 自己的 Runtime 队列隔离。 */
export async function runWorkflowTick(state: ThreadFerryState, hosts: WorkflowHost[], now = new Date()): Promise<void> {
  await flushNotifications(state, hosts);
  const reminders = await state.claimDueReminders(now);
  await Promise.all(reminders.map((reminder) => runReminder(state, reminder, hosts, now)));

  const claimed = await Promise.all(hosts.map(async (host) => ({ host, tasks: await state.claimWorkItems(host.agentId, now) })));
  await Promise.all(claimed.flatMap(({ host, tasks }) => tasks.map((task) => runTask(state, task, host, hosts))));
}
