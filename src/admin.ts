import { createHash, randomBytes } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { CLIENT_SCRIPT, STYLESHEET } from "./admin-assets.js";
import type { WecomCapabilitySnapshot } from "./channels/wecom.js";
import { addAgent, ensureGroupAccess, resolveWorkspace } from "./config.js";
import { resolveDirectoryUser } from "./directory.js";
import { sessionScope, type StateSnapshot } from "./state.js";
import { isRuntimeName } from "./types.js";
import type { AgentConnectionHealth, DirectoryUser, GroupAccess, GroupBinding, RuntimeName, ThreadFerryConfig } from "./types.js";

export type ConfigUpdater = (change: (latest: ThreadFerryConfig) => void | Promise<void>) => Promise<void>;

export type BotAuthorization =
  | { mode: "qr" }
  | { mode: "manual"; botId: string; secret: string };

export interface AgentBotStatus {
  authorized: boolean;
  botId?: string;
  hint?: string;
  /** 机器人自己的名字（来自 identity whoami），Agent 改过名时用来对照。 */
  botName?: string;
  /** Owner 在通讯录里的姓名。比加密 userid 好认。 */
  ownerName?: string;
  /** Owner 的顶层部门。企业微信不提供「机器人属于哪个企业」的查询，这是最接近的可得信息。 */
  org?: string;
  connection?: AgentConnectionHealth;
  capabilities?: WecomCapabilitySnapshot;
}

export interface AdminDependencies {
  updateConfig: ConfigUpdater;
  /**
   * 按 Agent 查询它能看到哪些群。`hasBotSession` 为真表示已确认机器人在群里；
   * 为假只代表未确认（群里还没人 @ 过机器人），不代表机器人不在。
   */
  listGroups: (agentId: string) => Promise<Array<{ id: string; name?: string; hasBotSession?: boolean }>>;
  /** 通讯录可见范围跟机器人身份绑定，必须使用目标 Agent 自己的凭据查询。 */
  searchUsers: (agentId: string, keywords: string[]) => Promise<DirectoryUser[]>;
  /**
   * 查加密 userid 对应的姓名。**同步、只读缓存**：企业微信不支持按 userid 反查通讯录，
   * 名字是从别处顺手收集的（见 src/directory-names.ts），拿不到就显示 id。
   */
  userName?: (userId: string) => string | undefined;
  /** 按姓名添加成功时把映射记下来，之后就能显示名字。 */
  rememberUser?: (userId: string, name: string) => void;
  botStatus?: (agentId: string) => Promise<AgentBotStatus>;
  /** 配对完成时立即探测；运行期间由 Host 定期重试并自动恢复完整模式。 */
  probeCapabilities?: (agentId: string) => Promise<WecomCapabilitySnapshot | undefined>;
  /** 已有凭据时把 Agent 接入当前 Host；重复调用必须安全。 */
  connectBot?: (agentId: string) => Promise<boolean>;
  /** 凭据只交给该 Agent 的 wecom-cli 加密存储，不写入 ThreadFerry 配置或日志。 */
  authorizeBot?: (agentId: string, authorization: BotAuthorization) => Promise<void>;
  snapshot?: () => Promise<StateSnapshot>;
  /** 清理日志追踪数据，不删除任务状态、Session、队列、提醒或配置。 */
  clearLogs?: () => Promise<number>;
  /** 只用于问题报告中的本机运行版本。 */
  version?: string;
  checkUpdate?: () => Promise<{ version: string } | undefined>;
  /** 按「群 + Agent」重置：同一个群里每台机器人各有自己的 Session。 */
  resetSession?: (groupId: string, agentId: string) => Promise<boolean>;
  /** 移除该 Agent 的 ThreadFerry 群绑定并清理 Session；不代表企业微信机器人主动退群。 */
  removeGroup?: (groupId: string, agentId: string) => Promise<void>;
}

const GROUP_ID = /^[^\s\u0000-\u001f]{1,512}$/;
const USER_ID = /^[A-Za-z0-9_@.-]{1,512}$/;
const BOT_ID = /^[A-Za-z0-9_-]{1,256}$/;
const MAX_DIRECTORY_ENTRIES = 500;
const MAX_USER_RESULTS = 20;

function html(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]!);
}

function identity(name: string, id: string, kind: string, focusable = true): string {
  if (!id) return `<b>${html(name)}</b>`;
  return `<span class="identity"${focusable ? ` tabindex="0"` : ""} aria-label="${html(`${name}，${kind} ${id}`)}"><b>${html(name)}</b><span class="identity-id" aria-hidden="true">${html(kind)} <code>${html(id)}</code></span></span>`;
}

function localHost(host: string | undefined): boolean {
  return host === "127.0.0.1" || host?.startsWith("127.0.0.1:") === true
    || host === "localhost" || host?.startsWith("localhost:") === true;
}

function securityHeaders(response: ServerResponse, contentType = "text/html; charset=utf-8"): void {
  response.setHeader("Content-Type", contentType);
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  // 样式和脚本都由本进程同源提供（/admin.css、/admin.js），因此不需要 unsafe-inline；
  // connect-src 只为选择菜单读 /api/* 开放，仍然限制在 'self'。
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function send(response: ServerResponse, status: number, content: string): void {
  securityHeaders(response);
  response.writeHead(status);
  response.end(content);
}

function sendAsset(response: ServerResponse, contentType: string, content: string): void {
  securityHeaders(response, contentType);
  response.writeHead(200);
  response.end(content);
}

function sendJson(response: ServerResponse, status: number, payload: unknown): void {
  securityHeaders(response, "application/json; charset=utf-8");
  response.writeHead(status);
  response.end(JSON.stringify(payload));
}

function redirect(response: ServerResponse, kind: "ok" | "error", message: string, target = "/"): void {
  securityHeaders(response);
  response.statusCode = 303;
  const [route, fragment] = target.split("#", 2);
  const [path, query] = (route ?? "/").split("?", 2);
  // 目标自带的查询参数要留住：表单出错时靠它把用户填过的值带回对话框，不用重填一遍。
  const params = new URLSearchParams(query ?? "");
  params.set(kind, message);
  response.setHeader("Location", `${path}?${params.toString()}${fragment ? `#${fragment}` : ""}`);
  response.end();
}

async function form(request: IncomingMessage): Promise<URLSearchParams> {
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) {
    throw new Error("请求格式无效");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk as Uint8Array);
    bytes += buffer.length;
    if (bytes > 16 * 1024) throw new Error("请求内容过大");
    chunks.push(buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function required(input: URLSearchParams, name: string): string {
  const value = input.get(name)?.trim();
  if (!value) throw new Error(`${name} 不能为空`);
  return value;
}

function activeGroupAccess(config: ThreadFerryConfig, groupId: string, agentId: string): GroupAccess {
  const access = config.groups[groupId]?.agents[agentId];
  if (!access) throw new Error("该群没有这个机器人记录");
  if (access.removed) throw new Error("机器人已从该群移除；重新接入后才能修改群配置");
  return access;
}

function botAuthorization(input: URLSearchParams): BotAuthorization | undefined {
  const mode = input.get("authMode")?.trim() || "later";
  if (mode === "later") return undefined;
  if (mode === "qr") return { mode };
  if (mode !== "manual") throw new Error("机器人授权方式无效");
  const botId = input.get("botId")?.trim() ?? "";
  const secret = input.get("secret") ?? "";
  input.delete("secret");
  if (!BOT_ID.test(botId)) throw new Error("Bot ID 无效");
  if (!secret.trim() || secret.length > 1024 || /[\r\n\u0000]/.test(secret)) throw new Error("Bot Secret 无效");
  return { mode, botId, secret };
}


function field(token: string): string {
  return `<input type="hidden" name="csrf" value="${token}">`;
}

const STATUS_LABELS: Record<string, string> = {
  scheduled: "已计划",
  queued: "排队中",
  running: "进行中",
  review: "待复核",
  reviewing: "复核中",
  completed: "已完成",
  cancelled: "已取消",
  failed: "失败",
  success: "成功",
  failure: "失败",
  info: "信息",
};

function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

function groupAnchor(groupId: string): string {
  return `/groups/detail?id=${encodeURIComponent(groupId)}`;
}

// 添加用户失败时回到「这个群这台机器人的对话框还开着」的状态，报错就显示在对话框上方。
// 一个群可能挂多台机器人，所以定位键是 Agent + 群。
function groupUserAnchor(groupId: string, agentId: string): string {
  return `${groupAnchor(groupId)}&user=${encodeURIComponent(`${agentId}\n${groupId}`)}`;
}

function carryParams(url: URL, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const key of ["name", "runtime", "model", "workspace", "configDir", "authMode", "new"]) {
    const value = url.searchParams.get(key)?.trim();
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
  return params.toString();
}

interface DirectoryListing {
  current: string;
  parent?: string;
  filter: string;
  entries: Array<{ name: string; path: string }>;
  truncated: boolean;
  note?: string;
}

async function directoryAt(path: string): Promise<{ path?: string; reason?: "missing" | "notDirectory" }> {
  let canonical: string;
  try {
    canonical = await realpath(path);
    if (!(await stat(canonical)).isDirectory()) return { reason: "notDirectory" };
  } catch {
    return { reason: "missing" };
  }
  return { path: canonical };
}

function matchNames(names: string[], filter: string): string[] {
  const needle = filter.toLocaleLowerCase();
  const prefixed = names.filter((name) => name.toLocaleLowerCase().startsWith(needle));
  return prefixed.length > 0 ? prefixed : names.filter((name) => name.toLocaleLowerCase().includes(needle));
}

// 目录列表同时服务两个入口：输入框上的选择菜单（/api/dirs）和无脚本回退的整页浏览（/agents/browse）。
// `partial` 打开「把最后一段当筛选词」——菜单是边打字边看的，此时路径通常还不是一个真实目录。
async function listDirectories(requested: string | undefined, partial: boolean): Promise<DirectoryListing> {
  const home = homedir();
  const input = requested?.trim() ?? "";
  let current: string | undefined;
  let filter = "";
  let note: string | undefined;
  if (!input) {
    current = (await directoryAt(home)).path;
  } else if (!isAbsolute(input)) {
    note = `“${input}”不是绝对路径，已回到用户主目录。`;
  } else {
    const resolved = await directoryAt(input);
    current = resolved.path;
    if (!current && partial) {
      const parent = dirname(input);
      const fallback = parent === input ? {} : await directoryAt(parent);
      if (fallback.path) {
        current = fallback.path;
        filter = basename(input);
      }
    }
    if (!current) {
      note = resolved.reason === "notDirectory"
        ? `“${input}”不是目录，已回到用户主目录。`
        : `无法读取“${input}”，已回到用户主目录。`;
    }
  }
  const root = current ?? (await directoryAt(home)).path ?? home;
  let names: string[] = [];
  let truncated = false;
  try {
    const all = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    const matched = filter ? matchNames(all, filter) : all;
    truncated = matched.length > MAX_DIRECTORY_ENTRIES;
    names = matched.slice(0, MAX_DIRECTORY_ENTRIES);
  } catch {
    note = note ?? "此目录无法读取。";
  }
  const parent = dirname(root);
  return {
    current: root,
    ...(parent === root ? {} : { parent }),
    filter,
    entries: names.map((name) => ({ name, path: join(root, name) })),
    truncated,
    ...(note ? { note } : {}),
  };
}

async function searchDirectoryUsers(
  dependencies: AdminDependencies,
  agentId: string,
  query: string,
): Promise<{ users: DirectoryUser[]; note?: string }> {
  if (!query) return { users: [] };
  let users: DirectoryUser[];
  try {
    users = await dependencies.searchUsers(agentId, [query]);
  } catch {
    return { users: [], note: "当前企业未开放通讯录搜索；ThreadFerry 已使用兼容模式，可改用邀请码或开启全员可用。" };
  }
  return {
    users: users.slice(0, MAX_USER_RESULTS),
    ...(users.length > MAX_USER_RESULTS ? { note: `匹配较多，只显示前 ${MAX_USER_RESULTS} 人。` } : {}),
  };
}

interface GroupDiscovery {
  sessions: Array<{ id: string; name?: string }>;
  /** 群 → 能看到它的 Agent。 */
  visibleTo: Map<string, Set<string>>;
  /** 群 → 已确认机器人在群里的 Agent（有会话记录）。 */
  confirmedBy: Map<string, Set<string>>;
  /** 查询失败的 Agent 及原因：失败必须说出来，不能和「没有群」长得一样。 */
  failures: Array<{ agentId: string; reason: string }>;
}

// 每个 Agent 的机器人可见群不同。这里按 Agent 分别查，并记录每个群能被哪些 Agent 看到。
async function fetchSessions(
  config: ThreadFerryConfig,
  dependencies: AdminDependencies,
): Promise<GroupDiscovery> {
  const sessions = new Map<string, { id: string; name?: string }>();
  const visibleTo = new Map<string, Set<string>>();
  const confirmedBy = new Map<string, Set<string>>();
  const failures: Array<{ agentId: string; reason: string }> = [];
  await Promise.all(Object.keys(config.agents).map(async (agentId) => {
    let visible: Array<{ id: string; name?: string; hasBotSession?: boolean }> = [];
    try {
      visible = await dependencies.listGroups(agentId);
    } catch (error) {
      // 单个 Agent 的机器人不可用时不拖垮整页，但要把原因带到页面上。
      failures.push({ agentId, reason: error instanceof Error ? error.message : "群查询失败" });
      return;
    }
    const joined = visible.filter((session) => session.hasBotSession);
    if (joined.some((session) => !config.groups[session.id]?.agents[agentId])) {
      try {
        await dependencies.updateConfig((latest) => { for (const session of joined) ensureGroupAccess(latest, session.id, agentId); });
      } catch (error) {
        failures.push({ agentId, reason: `自动启用群聊失败：${error instanceof Error ? error.message : "配置更新失败"}` });
      }
    }
    for (const session of visible) {
      if (!sessions.has(session.id)) sessions.set(session.id, session);
      const holders = visibleTo.get(session.id) ?? new Set<string>();
      holders.add(agentId);
      visibleTo.set(session.id, holders);
      if (session.hasBotSession) {
        const confirmed = confirmedBy.get(session.id) ?? new Set<string>();
        confirmed.add(agentId);
        confirmedBy.set(session.id, confirmed);
      }
    }
  }));
  return { sessions: [...sessions.values()], visibleTo, confirmedBy, failures };
}

async function fetchSnapshot(dependencies: AdminDependencies): Promise<StateSnapshot | undefined> {
  try {
    return await dependencies.snapshot?.();
  } catch {
    // 状态存储不可用时只隐藏运行状态，不阻断配置管理。
    return undefined;
  }
}

async function fetchBotStatuses(config: ThreadFerryConfig, dependencies: AdminDependencies): Promise<Map<string, AgentBotStatus>> {
  const statuses = new Map<string, AgentBotStatus>();
  await Promise.all(Object.keys(config.agents).map(async (agentId) => {
    try {
      let status = await dependencies.botStatus?.(agentId);
      if (status?.authorized && await dependencies.connectBot?.(agentId)) {
        status = await dependencies.botStatus?.(agentId) ?? status;
      }
      if (status) statuses.set(agentId, status);
    } catch {
      // 单个 Agent 查询失败不影响其他状态和页面。
    }
  }));
  return statuses;
}

// 企业微信没有「机器人在哪些群」这个查询，只能列出最近 7 天有消息的群，所以空列表要讲清规则。
const DISCOVERY_HINT = "企业微信只提供最近 7 天有消息的群；把机器人拉进群并 @它一次，ThreadFerry 收到后会自动启用。";

function errorBar(message: string): string {
  return `<div class="notice error">${html(message)}</div>`;
}

function capabilityLine(snapshot: WecomCapabilitySnapshot | undefined): string {
  if (!snapshot) return `<p class="muted">企业能力正在后台探测；基础对话不等待探测结果。</p>`;
  const unavailable = [
    snapshot.contact === "unavailable" ? "通讯录" : undefined,
    snapshot.groupHistory === "unavailable" ? "完整群上下文" : undefined,
    snapshot.recentSessions === "unavailable" ? "最近会话" : undefined,
  ].filter(Boolean);
  const unknown = [snapshot.contact, snapshot.groupHistory, snapshot.recentSessions].filter((state) => state === "unknown").length;
  const details = unavailable.length
    ? `${unavailable.join("、")}不可用；对应功能会给出提示，普通 Agent 对话不受影响。`
    : unknown > 0 ? "部分企业能力暂时无法确认；正在后台重试。" : "通讯录、完整群上下文和最近会话均可用。";
  const label = snapshot.mode === "full" ? "完整模式" : snapshot.mode === "compatible" ? "兼容模式" : "检测中";
  return `<p>运行模式 <span class="badge ${snapshot.mode === "full" ? "ok" : snapshot.mode === "compatible" ? "warning" : ""}">${label}</span> <small class="muted">${html(details)}</small></p>`;
}

function capabilityResultDialog(agentId: string, authorized: boolean, snapshot: WecomCapabilitySnapshot | undefined): string {
  const pending = !authorized || !snapshot || snapshot.mode === "detecting";
  const unavailable = snapshot ? [
    snapshot.contact === "unavailable" ? "通讯录" : undefined,
    snapshot.groupHistory === "unavailable" ? "完整群上下文" : undefined,
    snapshot.recentSessions === "unavailable" ? "最近会话" : undefined,
  ].filter(Boolean) : [];
  const title = !authorized ? "等待机器人授权"
    : snapshot?.mode === "full" ? "已进入完整模式"
      : snapshot?.mode === "compatible" ? "已进入兼容模式" : "正在检测企业能力";
  const description = !authorized
    ? "请在企业微信完成授权。本页面会自动检测授权结果。"
    : snapshot?.mode === "full"
      ? "通讯录、完整群上下文和最近会话均可用。"
      : snapshot?.mode === "compatible"
        ? `${unavailable.join("、")}不可用；普通 Agent 对话仍可使用。权限恢复后会在后台自动切回完整模式。`
        : "尚未检测到明确的权限缺失，ThreadFerry 会继续探测，不会提前进入兼容模式。";
  return `<dialog class="modal" aria-labelledby="capability-result-title" open${pending ? " data-capability-pending" : ""}>
    <div class="modal-body"><h3 id="capability-result-title">${html(title)}</h3><p class="lede">机器人 ${html(agentId)}</p><p>${html(description)}</p>
      <div class="modal-actions"><a class="button" href="/agents">知道了</a></div></div>
  </dialog>`;
}

// 查询失败必须说出来：静默返回空列表会把「查不到」显示成「已经查完了」。
function failureCard(failures: Array<{ agentId: string; reason: string }>): string {
  if (failures.length === 0) return "";
  return `
    <article class="card">
      <div class="row"><h3>群查询失败</h3><span class="badge warning">${failures.length} 个 Agent</span></div>
      <ul>${failures.map((failure) => `<li><span><code>${html(failure.agentId)}</code> ${html(failure.reason)}</span></li>`).join("")}</ul>
      <p class="muted">这些 Agent 的群列表本次没取到，下面的列表并不完整。</p>
    </article>`;
}

function waitingCard(
  id: string,
  label: string,
  visible: Set<string>,
): string {
  return `
    <article class="card">
      <div class="row"><h3>${identity(label, id, "群 ID")}</h3><span class="badge warning">等待首次 @</span></div>
      <p class="muted">${visible.size > 0
        ? "在群里 @需要使用的机器人发送第一条消息，ThreadFerry 收到后会自动启用，不需要手动绑定。"
        : "把机器人加入该群并 @它发送第一条消息，ThreadFerry 收到后会自动启用。"}</p>
    </article>`;
}

function shell(
  active: "overview" | "agents" | "groups" | "logs" | "settings",
  config: ThreadFerryConfig,
  url: URL,
  content: string,
  options: { errorInDialog?: boolean } = {},
): string {
  const notice = url.searchParams.get("ok");
  const error = options.errorInDialog ? null : url.searchParams.get("error");
  const tabs: Array<[string, typeof active, string]> = [
    ["/", "overview", "概览"],
    ["/agents", "agents", "机器人管理"],
    ["/groups", "groups", "群聊管理"],
    ["/logs", "logs", "日志追踪"],
    ["/settings", "settings", "偏好设置"],
  ];
  const current = tabs.find(([, key]) => key === active)!;
  const nav = tabs.slice(0, 3).map(([href, key, label]) => `<a href="${href}" data-tour-target="${key}"${key === active ? ` class="active" aria-current="page"` : ""}>${label}</a>`).join("");
  const utilities = tabs.slice(3).map(([href, key, label]) => `<a href="${href}"${key === "logs" ? " data-log-nav" : ""}${key === active ? ` class="active" aria-current="page"` : ""}>${label}</a>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ThreadFerry 管理台</title><script src="/admin.js"></script><link rel="stylesheet" href="/admin.css"></head>
  <body><div class="app-shell">
    <aside class="sidebar"><a class="brand" href="/"><span class="brand-mark">TF</span><span><b>ThreadFerry</b><small>本机管理台</small></span></a>
      <nav class="side-nav" aria-label="管理台导航">${nav}</nav>
      <div class="sidebar-bottom"><nav class="side-nav utility-nav" aria-label="工具与设置">${utilities}</nav><div class="sidebar-foot" role="status"><span class="status-dot"></span><span>服务运行中</span></div></div>
    </aside>
    <main><header class="top"><h1>${current[2]}</h1><div class="instance"><b>${html(Object.keys(config.agents).length)}</b><span>个机器人</span><small>1 个机器人对应 1 个 Agent</small></div></header>
      ${notice ? `<div class="notice">${html(notice)}</div>` : ""}${error ? errorBar(error) : ""}
      <div class="page-content">${content}</div>
    </main>
  </div></body></html>`;
}

function settingsPage(config: ThreadFerryConfig, url: URL, token: string): string {
  return shell("settings", config, url, `<div class="settings-stack">
    <article class="card settings-card">
      <div class="section-head"><div><h2>外观</h2><p class="sub">只影响当前浏览器或桌面管理窗口。</p></div></div>
      <label class="setting-row"><span><b>界面主题</b><small>可以跟随系统，也可以固定使用亮色或暗色。</small></span>
        <select data-theme-preference aria-label="界面主题"><option value="system">跟随系统</option><option value="light">亮色</option><option value="dark">暗色</option></select>
      </label>
      <label class="setting-row"><span><b>显示日志追踪</b><small>在侧栏左下角显示运行记录定位入口。</small></span><input type="checkbox" data-interface-preference="showLogTracking"></label>
      <div class="setting-row"><span><b>开始使用引导</b><small>重新查看机器人、私聊和可选群聊的使用说明。</small></span><a class="button ghost" href="/?tour=1">重新查看</a></div>
      <div class="setting-row"><span><b>问题反馈</b><small>在 GitHub Issue 中提交问题、建议与复现信息。</small></span><a class="button ghost" href="https://github.com/GnaixEuy/threadferry/issues/new" target="_blank" rel="noreferrer">前往反馈 ↗</a></div>
    </article>
    <article class="card settings-card" data-desktop-settings>
      <div class="section-head"><div><h2>桌面应用</h2><p class="sub">这些选项保存在本机，只控制 ThreadFerry 桌面入口。</p></div><span class="badge" data-desktop-platform>正在识别</span></div>
      <fieldset class="setting-list" data-desktop-fields disabled>
        <label class="setting-row" data-capability="launchAtLogin"><span><b>登录时启动</b><small>登录系统后自动启动 ThreadFerry 桌面应用。</small></span><input type="checkbox" data-desktop-preference="launchAtLogin"></label>
        <label class="setting-row"><span><b>自动启动服务</b><small>打开桌面应用时自动连接已配置机器人。</small></span><input type="checkbox" data-desktop-preference="autoStartService"></label>
        <label class="setting-row"><span><b>启动后打开管理台</b><small>服务就绪后自动显示概览页面。</small></span><input type="checkbox" data-desktop-preference="openManagementOnLaunch"></label>
        <label class="setting-row" data-capability="dockIcon"><span><b>在 Dock 中显示</b><small>菜单栏空间不足时，可保留一个 Dock 入口。</small></span><input type="checkbox" data-desktop-preference="showDockIcon"></label>
      </fieldset>
      <p class="settings-status" data-desktop-status>正在读取桌面偏好…</p>
    </article>
    <article class="card settings-card">
      <div class="section-head"><div><h2>软件更新</h2><p class="sub">桌面应用会自动下载、安装新版本并重新启动。</p></div></div>
      <form class="setting-list" method="post" action="/settings/update" data-update-check>${field(token)}
        <div class="setting-row"><span><b>ThreadFerry 自动更新</b><small>启动后自动检查；更新完成前会等待正在执行的任务安全结束。</small></span><button class="ghost" type="submit">立即检查更新</button></div>
      </form>
      <p class="settings-status" data-update-status aria-live="polite">桌面应用会在后台自动检查更新；浏览器模式只检查版本。</p>
    </article>
  </div>`);
}

async function logsPage(config: ThreadFerryConfig, dependencies: AdminDependencies, token: string, url: URL): Promise<string> {
  const snapshot = await fetchSnapshot(dependencies);
  const query = (url.searchParams.get("q")?.trim() ?? "").slice(0, 128);
  const requestedOutcome = url.searchParams.get("outcome")?.trim() ?? "";
  const outcome = ["success", "failure", "info"].includes(requestedOutcome) ? requestedOutcome : "";
  const needle = query.toLocaleLowerCase();
  const matches = (...values: Array<string | undefined>): boolean => !needle
    || values.some((value) => value?.toLocaleLowerCase().includes(needle));
  const failures = (snapshot?.turns ?? [])
    .filter((turn) => (!outcome || outcome === "failure")
      && turn.status === "failed" && (turn.errorId !== undefined || turn.failurePhase !== undefined)
      && matches(turn.errorId, turn.failurePhase, turn.updatedAt))
    .slice(-100).reverse();
  const activities = (snapshot?.activities ?? [])
    .filter((item) => (!outcome || item.outcome === outcome)
      && matches(item.id, item.agent, item.type, item.outcome, item.resource, item.at))
    .slice(-200).reverse();
  const reportLines = [
    ...failures.slice(0, 10).map((turn) => JSON.stringify({ kind: "failure", errorId: turn.errorId, phase: turn.failurePhase, at: turn.updatedAt })),
    ...activities.slice(0, 10).map((item) => JSON.stringify({ kind: "activity", id: item.id, agent: item.agent, type: item.type, outcome: item.outcome, resource: item.resource, at: item.at })),
  ].join("\n").replaceAll("`", "'");
  // ponytail: query string只带最近记录；需要更长日志时再改为用户主动上传附件。
  const reportLogs = reportLines.slice(0, 6_000) || "暂无匹配的脱敏日志";
  const issue = new URL("https://github.com/GnaixEuy/threadferry/issues/new");
  issue.searchParams.set("title", "[问题反馈] ThreadFerry 运行异常");
  issue.searchParams.set("body", [
    "## 问题描述", "", "请描述遇到的问题。", "", "## 复现步骤", "", "1. ", "", "## 预期结果", "", "请描述预期行为。", "",
    "## 运行环境", "", `- ThreadFerry: ${dependencies.version ?? "未知"}`, `- Platform: ${process.platform} ${process.arch}`, `- Node: ${process.version}`, "",
    "## 脱敏日志", "", "<!-- 以下内容由 ThreadFerry 自动附带，提交前可以检查或删除。 -->", "```json", reportLogs, "```",
  ].join("\n"));
  const filters = `<form class="trace-filter" method="get" action="/logs">
    <input name="q" value="${html(query)}" maxlength="128" placeholder="错误编号、Agent、动作或资源" aria-label="搜索日志追踪">
    <select name="outcome" aria-label="结果"><option value=""${outcome ? "" : " selected"}>全部结果</option><option value="success"${outcome === "success" ? " selected" : ""}>成功</option><option value="failure"${outcome === "failure" ? " selected" : ""}>失败</option><option value="info"${outcome === "info" ? " selected" : ""}>信息</option></select>
    <button type="submit">定位</button>${query || outcome ? `<a class="ghost clear-filter" href="/logs">清除</a>` : ""}
  </form>`;
  const failureList = failures.length
    ? `<div class="list-panel trace-list">${failures.map((turn) => `<div class="trace-row"><span><code>${html(turn.errorId ?? "无错误编号")}</code><small>${html(turn.updatedAt)}</small></span><span><b>处理失败</b><small>阶段 ${html(turn.failurePhase ?? "unknown")}</small></span><span class="badge warning">失败</span></div>`).join("")}</div>`
    : `<p class="sub">没有匹配的失败记录。</p>`;
  const activityList = activities.length
    ? `<div class="list-panel trace-list">${activities.map((item) => `<div class="trace-row"><span><code>${html(item.id)}</code><small>${html(item.at)}</small></span><span><b>${html(item.type)}</b><small>Agent ${html(item.agent)}${item.resource ? ` · ${html(item.resource)}` : ""}</small></span><span class="badge ${item.outcome === "success" ? "ok" : item.outcome === "failure" ? "warning" : ""}">${statusLabel(item.outcome)}</span></div>`).join("")}</div>`
    : `<p class="sub">没有匹配的 Activity。</p>`;
  return shell("logs", config, url, `<div class="toolbar"><p class="sub">按错误编号、Agent、动作或资源定位最近记录；这里只展示脱敏状态，不展示消息正文。</p>
      <div class="toolbar-actions"><a class="button ghost" href="${html(issue)}" target="_blank" rel="noreferrer">上报问题 ↗</a>
      ${dependencies.clearLogs ? `<form method="post" action="/logs/clear" data-confirm="确定清理失败诊断记录和 Activity 吗？任务状态、Session、待补发、提醒和配置都会保留。">${field(token)}<button class="danger" type="submit">清理日志</button></form>` : ""}</div></div>
    <p class="sub">上报问题会在 GitHub Issue 中预填当前筛选后的脱敏日志，提交前可以检查和修改。</p>
    ${filters}${snapshot ? "" : `<div class="notice error">运行状态暂不可用，请稍后重试。</div>`}
    <h2>失败记录</h2>${failureList}<h2>Activity</h2>${activityList}`);
}

function overviewCharts(snapshot: StateSnapshot, counts: Map<string, number>, now = new Date()): string {
  const key = (date: Date): string => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - 6 + index);
    return { key: key(date), label: `${date.getMonth() + 1}/${date.getDate()}`, handled: 0, failed: 0, stale: 0 };
  });
  const byDay = new Map(days.map((day) => [day.key, day]));
  for (const turn of snapshot.turns) {
    const date = new Date(turn.receivedAt);
    if (Number.isNaN(date.getTime())) continue;
    const day = byDay.get(key(date));
    if (!day) continue;
    if (turn.status === "handled") day.handled += 1;
    else if (turn.status === "failed") day.failed += 1;
    else if (turn.status === "stale") day.stale += 1;
  }

  const completed = counts.get("handled") ?? 0;
  const active = (counts.get("queued") ?? 0) + (counts.get("running") ?? 0);
  const failed = counts.get("failed") ?? 0;
  const stale = counts.get("stale") ?? 0;
  const statuses = [
    { label: "已完成", value: completed, className: "handled" },
    { label: "进行中", value: active, className: "active" },
    { label: "失败", value: failed, className: "failed" },
    { label: "已过期", value: stale, className: "stale" },
  ];
  const total = statuses.reduce((sum, status) => sum + status.value, 0);
  const terminalTotal = days.reduce((sum, day) => sum + day.handled + day.failed + day.stale, 0);
  const trend = terminalTotal > 0
    ? (() => {
        const maximum = Math.max(...days.map((day) => day.handled + day.failed + day.stale));
        const bars = days.map((day, index) => {
          const x = 34 + index * 94;
          const parts = [
            { value: day.handled, className: "handled", label: "完成" },
            { value: day.failed, className: "failed", label: "失败" },
            { value: day.stale, className: "stale", label: "过期" },
          ];
          let y = 165;
          const rectangles = parts.map((part) => {
            const height = part.value / maximum * 120;
            y -= height;
            return height > 0
              ? `<rect class="chart-bar ${part.className}" x="${x}" y="${y.toFixed(1)}" width="48" height="${height.toFixed(1)}"><title>${day.label} ${part.label} ${part.value}</title></rect>`
              : "";
          }).join("");
          const count = day.handled + day.failed + day.stale;
          return `${rectangles}${count ? `<text class="chart-value" x="${x + 24}" y="${Math.max(22, y - 7).toFixed(1)}">${count}</text>` : ""}<text class="chart-label" x="${x + 24}" y="190">${day.label}</text>`;
        }).join("");
        return `<svg class="trend-chart" viewBox="0 0 700 210" role="img" aria-labelledby="turn-trend-title turn-trend-description">
          <desc id="turn-trend-description">最近七天已完成、失败和过期任务的每日数量</desc>
          <line class="chart-grid" x1="20" y1="45" x2="680" y2="45"></line><line class="chart-grid" x1="20" y1="165" x2="680" y2="165"></line>${bars}
        </svg>`;
      })()
    : `<div class="chart-empty">近 7 天还没有已结束的任务。</div>`;

  let offset = 0;
  const segments = statuses.map((status) => {
    if (!status.value) return "";
    const percentage = status.value / total * 100;
    const segment = `<circle class="chart-segment ${status.className}" cx="60" cy="60" r="48" pathLength="100" stroke-dasharray="${percentage} ${100 - percentage}" stroke-dashoffset="-${offset}"><title>${status.label} ${status.value}</title></circle>`;
    offset += percentage;
    return segment;
  }).join("");
  const distribution = total > 0
    ? `<div class="status-chart"><svg class="donut-chart" viewBox="0 0 120 120" role="img" aria-labelledby="turn-status-title turn-status-description">
        <desc id="turn-status-description">当前保留任务记录的状态分布</desc><circle class="donut-base" cx="60" cy="60" r="48"></circle>${segments}
        <text class="donut-value" x="60" y="57">${total}</text><text class="donut-label" x="60" y="75">条任务</text>
      </svg><ul class="chart-legend">${statuses.map((status) => `<li><span><i class="legend-dot ${status.className}"></i>${status.label}</span><b>${status.value}</b></li>`).join("")}</ul></div>`
    : `<div class="chart-empty">暂无任务状态数据。</div>`;

  return `<section class="overview-charts" aria-label="运行概览图表">
    <article class="card chart-card"><div class="chart-heading"><div><h3 id="turn-trend-title">近 7 天处理趋势</h3><p class="sub">按任务接收日期统计已结束记录</p></div><div class="chart-key"><span><i class="legend-dot handled"></i>完成</span><span><i class="legend-dot failed"></i>失败</span><span><i class="legend-dot stale"></i>过期</span></div></div>${trend}</article>
    <article class="card chart-card"><div class="chart-heading"><div><h3 id="turn-status-title">任务状态分布</h3><p class="sub">当前保留的任务记录</p></div></div>${distribution}</article>
  </section>`;
}

async function overviewPage(config: ThreadFerryConfig, dependencies: AdminDependencies, url: URL): Promise<string> {
  const [{ sessions, visibleTo, failures }, snapshot, botStatuses] = await Promise.all([
    fetchSessions(config, dependencies),
    fetchSnapshot(dependencies),
    fetchBotStatuses(config, dependencies),
  ]);
  const activeGroups = Object.values(config.groups).filter((group) => Object.values(group.agents).some((access) => access.enabled !== false)).length;
  const disabledGroups = Object.values(config.groups).filter((group) => Object.values(group.agents).every((access) => access.enabled === false)).length;
  const waiting = sessions.filter((session) => !config.groups[session.id]);
  const counts = new Map<string, number>();
  for (const turn of snapshot?.turns ?? []) counts.set(turn.status, (counts.get(turn.status) ?? 0) + 1);
  const active = (counts.get("queued") ?? 0) + (counts.get("running") ?? 0);
  const lastFailure = snapshot?.turns.slice().reverse().find((turn) => turn.status === "failed" && turn.errorId !== undefined);
  const reminders = (snapshot?.reminders ?? []).filter((item) => item.status === "scheduled" || item.status === "running");
  const workItems = (snapshot?.workItems ?? []).filter((item) => item.status !== "completed" && item.status !== "failed");
  const activities = (snapshot?.activities ?? []).slice(-20).reverse();
  const authorized = [...botStatuses.values()].filter((status) => status.authorized).length;
  const connected = [...botStatuses.values()].filter((status) => status.connection?.state === "connected").length;
  const directSession = snapshot?.sessions.some((session) => Object.entries(config.agents).some(([agentId, agent]) =>
    session.group === createHash("sha256").update(`direct:${agent.ownerUser}`).digest("hex")
      && session.workspace === createHash("sha256").update(sessionScope(agentId, agent)).digest("hex"))) ?? false;
  const coreCompleted = Number(authorized > 0) + Number(directSession);
  const onboarding = `<details class="onboarding card" data-onboarding${coreCompleted < 2 ? " open" : ""}>
    <summary><span><b>开始使用</b><small>${coreCompleted} / 2 个核心步骤已完成${activeGroups > 0 ? " · 群聊已接入" : ""}</small></span><span class="onboarding-toggle">${coreCompleted === 2 ? "已完成" : "继续设置"}</span></summary>
    <ol class="onboarding-list">
      <li class="${authorized > 0 ? "done" : "current"}"><span class="onboarding-mark" aria-hidden="true">${authorized > 0 ? "✓" : "1"}</span><span><b>${authorized > 0 ? "机器人已授权" : "授权企业微信机器人"}</b><small>${authorized > 0 ? `已有 ${authorized} 台机器人可用。` : "前往机器人管理完成扫码或手工授权。"}</small></span><a href="/agents">机器人管理</a></li>
      <li class="${directSession ? "done" : authorized > 0 ? "current" : ""}"><span class="onboarding-mark" aria-hidden="true">${directSession ? "✓" : "2"}</span><span><b>${directSession ? "已完成第一次私聊" : "完成第一次私聊"}</b><small>${directSession ? "Owner 私聊 Session 已建立。" : "在企业微信找到已授权机器人，直接发送一句普通消息。"}</small></span></li>
      <li class="${activeGroups > 0 ? "done" : ""}"><span class="onboarding-mark" aria-hidden="true">${activeGroups > 0 ? "✓" : "＋"}</span><span><b>接入群聊（可选）</b><small>${activeGroups > 0 ? `已有 ${activeGroups} 个群可用。` : "把机器人加入群聊并 @它一次，收到后自动启用。"}</small></span><a href="/groups">群聊管理</a></li>
    </ol>
  </details>`;
  const stats: Array<[string, string, string]> = [
    [String(Object.keys(config.agents).length), "机器人", "/agents"],
    [String(connected), "长连接在线", "/agents"],
    [String(activeGroups), "可用群", "/groups"],
    [String(disabledGroups), "停用 / 已移除群", "/groups"],
    [String(waiting.length), "等待首次 @", "/groups"],
  ];
  if (snapshot) {
    stats.push(
      [String(active), "排队 / 运行中", ""],
      [String(snapshot.sessions.length), "运行会话", ""],
      [String(snapshot.outbox.length), "待补发回复", ""],
      [String(reminders.length), "主动提醒", ""],
      [String(workItems.length), "协作任务", ""],
    );
  }
  const todos: string[] = waiting.map((session) =>
    waitingCard(session.id, session.name ?? "未获取群名", visibleTo.get(session.id) ?? new Set()));
  if (failures.length > 0) todos.unshift(failureCard(failures));
  if (lastFailure) {
    todos.push(`<article class="card"><h3>最近一次失败</h3><p class="muted">错误编号 <code>${html(lastFailure.errorId ?? "无")}</code> · 阶段 ${html(lastFailure.failurePhase ?? "unknown")} · ${html(lastFailure.updatedAt)}</p><p class="muted">请在终端运行 <code>threadferry status</code> 和 <code>threadferry doctor</code> 排查。</p></article>`);
  }
  const proactive = [
    ...reminders.map((item) => `<article class="card"><div class="row"><h3>提醒 <code>${html(item.id)}</code></h3><span class="badge ${item.status === "running" ? "warning" : "ok"}">${statusLabel(item.status)}</span></div><p class="muted">Agent <code>${html(item.agent)}</code> · 下次运行 ${html(item.nextRunAt)}${item.repeatMinutes ? ` · 每 ${item.repeatMinutes} 分钟` : ""}</p></article>`),
    ...workItems.map((item) => `<article class="card"><div class="row"><h3>${html(item.title)}</h3><span class="badge warning">${statusLabel(item.status)}</span></div><p class="muted">任务 <code>${html(item.id)}</code> · ${html(item.assignedAgent)}${item.reviewerAgent ? ` → ${html(item.reviewerAgent)} 复核` : ""}</p></article>`),
  ];
  const activityList = activities.length
    ? `<article class="card"><ul>${activities.map((item) => `<li><span><code>${html(item.agent)}</code> ${html(item.type)}${item.resource ? ` · ${html(item.resource)}` : ""}</span><span class="badge ${item.outcome === "success" ? "ok" : item.outcome === "failure" ? "warning" : ""}">${statusLabel(item.outcome)}</span></li>`).join("")}</ul></article>`
    : `<p class="sub">还没有 Activity。</p>`;
  return shell("overview", config, url, `
    ${onboarding}
    <div class="stats">${stats.map(([value, label, href]) => href
      ? `<a class="stat" href="${href}"><b>${value}</b><span>${label}</span></a>`
      : `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join("")}</div>
    ${snapshot ? "" : `<p class="sub mt">运行状态暂不可用；机器人和群配置管理不受影响。</p>`}
    ${snapshot ? overviewCharts(snapshot, counts) : ""}
    <h2>待处理</h2>${todos.length ? `<div class="grid">${todos.join("")}</div>` : `<p class="sub">没有待处理事项。</p>`}
    <h2>主动工作</h2>${proactive.length ? `<div class="grid">${proactive.join("")}</div>` : `<p class="sub">没有运行中的提醒或协作任务。</p>`}
    <h2>最近 Activity</h2>${activityList}`);
}

// 添加表单放进对话框，页面上只留一个按钮。开着的状态由 ?new=1 决定：没有脚本时点按钮就是
// 跳这个链接，表单校验失败时也带着填过的值回到这里，两种情况都不会让人重填。
function botAuthFields(selected: string, allowLater: boolean): string {
  return `
    <fieldset class="auth-options" data-auth-form>
      <legend>企业微信授权</legend>
      <label><input type="radio" name="authMode" value="qr"${selected === "qr" ? " checked" : ""}> 扫码授权（推荐）</label>
      <label><input type="radio" name="authMode" value="manual"${selected === "manual" ? " checked" : ""}> 输入 Bot ID / Secret</label>
      ${allowLater ? `<label><input type="radio" name="authMode" value="later"${selected === "later" ? " checked" : ""}> 稍后授权</label>` : ""}
      <div class="manual-auth-fields" data-manual-fields>
        <label class="field"><span>Bot ID</span><input name="botId" autocomplete="off" maxlength="256" placeholder="aib..."></label>
        <label class="field"><span>Bot Secret</span><input name="secret" type="password" autocomplete="new-password" maxlength="1024"></label>
      </div>
      <p class="hint">扫码会直接打开企业微信授权页。手工填写的 Secret 只转交给该机器人的 wecom-cli 加密存储，不写入 ThreadFerry 配置或日志。</p>
    </fieldset>`;
}

function addAgentDialog(
  token: string,
  prefill: { name: string; runtime: string; model: string; workspace: string; configDir: string; authMode: string },
  browseLink: string,
  open: boolean,
  error?: string,
): string {
  return `
    <dialog id="add-agent" class="modal" aria-labelledby="add-agent-title"${open ? " open" : ""}>
      <form method="post" action="/agents/add">${field(token)}
        <h3 id="add-agent-title">添加机器人</h3>
        <p class="lede">一个机器人对应一个独立 Agent；凭据、Owner、群、Workspace 和 Session 互相隔离。</p>
        ${error ? errorBar(error) : ""}
        <div class="fields">
          <label class="field"><span>机器人名称</span><input name="agentId" value="${html(prefill.name)}" maxlength="128" placeholder="1-128 个字符，支持中文和空格" required autofocus></label>
          <label class="field"><span>Runtime</span><select name="runtime">
            <option value="codex"${prefill.runtime === "codex" ? " selected" : ""}>Codex</option><option value="pi"${prefill.runtime === "pi" ? " selected" : ""}>Pi</option><option value="claude"${prefill.runtime === "claude" ? " selected" : ""}>Claude Code</option><option value="grok"${prefill.runtime === "grok" ? " selected" : ""}>Grok Build</option>
          </select></label>
          <div class="field">
            <label for="add-agent-workspace">Workspace</label>
            <div class="picker" data-picker-root>
              <input id="add-agent-workspace" name="workspace" data-picker="dirs" value="${html(prefill.workspace)}" placeholder="点这里从本机目录里选" required>
            </div>
            <p class="hint">点输入框选目录，也可以直接输入绝对路径；必须是已存在的目录。<a class="no-js" href="${html(browseLink)}">整页浏览目录</a></p>
          </div>
          <label class="field"><span>模型（可选）</span><input name="model" value="${html(prefill.model)}" placeholder="provider/model"></label>
          <label class="field"><span>wecom-cli 配置目录（可选）</span><input name="configDir" value="${html(prefill.configDir)}" placeholder="留空则使用 ~/.threadferry/wecom/机器人名称"></label>
          ${botAuthFields(prefill.authMode, true)}
        </div>
        <div class="modal-actions"><a class="button ghost" href="/agents" data-close-dialog>取消</a><button>添加机器人</button></div>
      </form>
    </dialog>`;
}

function botAuthDialog(token: string, dialogId: string, agentId: string, selected: string, open: boolean, error?: string): string {
  return `
    <dialog id="${html(dialogId)}" class="modal" aria-labelledby="${html(dialogId)}-title"${open ? " open" : ""}>
      <form method="post" action="/agents/auth">${field(token)}<input type="hidden" name="agentId" value="${html(agentId)}">
        <h3 id="${html(dialogId)}-title">授权机器人 ${html(agentId)}</h3>
        <p class="lede">凭据只写入这台机器人的独立 wecom-cli 配置目录。授权完成后，ThreadFerry 会直接读取凭据并建立它自己的企业微信连接。</p>
        ${error ? errorBar(error) : ""}
        ${botAuthFields(selected, false)}
        <div class="modal-actions"><a class="button ghost" href="/agents" data-close-dialog>取消</a><button>开始授权</button></div>
      </form>
    </dialog>`;
}

function editWorkspaceDialog(
  token: string,
  dialogId: string,
  agentId: string,
  workspace: string,
  browseLink: string,
  open: boolean,
  error?: string,
): string {
  return `
    <dialog id="${html(dialogId)}" class="modal" aria-labelledby="${html(dialogId)}-title"${open ? " open" : ""}>
      <form method="post" action="/agents/workspace">${field(token)}<input type="hidden" name="agentId" value="${html(agentId)}">
        <h3 id="${html(dialogId)}-title">修改 ${html(agentId)} 的工作区</h3>
        <p class="lede">后续任务会在新工作区建立独立 Session，不会续接旧工作区的会话。</p>
        ${error ? errorBar(error) : ""}
        <div class="field">
          <label for="${html(dialogId)}-path">Workspace</label>
          <div class="picker" data-picker-root>
            <input id="${html(dialogId)}-path" name="workspace" data-picker="dirs" value="${html(workspace)}" placeholder="点这里从本机目录里选" required autofocus>
          </div>
          <p class="hint">点输入框选目录，也可以直接输入绝对路径；必须是已存在的目录。<a class="no-js" href="${html(browseLink)}">整页浏览目录</a></p>
        </div>
        <div class="modal-actions"><a class="button ghost" href="/agents" data-close-dialog>取消</a><button>保存工作区</button></div>
      </form>
    </dialog>`;
}

function removeAgentDialog(
  token: string,
  dialogId: string,
  agentId: string,
  groups: Array<{ id: string; label: string }>,
  isOnlyAgent: boolean,
  open: boolean,
  error?: string,
): string {
  const heading = groups.length > 0 ? "先解除群聊绑定" : isOnlyAgent ? "暂时不能删除" : `删除机器人 ${html(agentId)}`;
  const content = groups.length > 0
    ? `<p class="lede">这台机器人仍绑定以下群聊。请先进入群详情，点击“移除机器人”解除绑定。</p>
       <ul class="links">${groups.map((group) => `<li><a href="${groupAnchor(group.id)}">${identity(group.label, group.id, "群 ID", false)}</a></li>`).join("")}</ul>
       <div class="modal-actions"><a class="button ghost" href="/agents" data-close-dialog>取消</a><a class="button" href="${groupAnchor(groups[0]!.id)}">去解除绑定</a></div>`
    : isOnlyAgent
      ? `<p class="lede">ThreadFerry 至少需要保留一台机器人。请先添加另一台机器人，再删除这台。</p>
         <div class="modal-actions"><a class="button" href="/agents" data-close-dialog>知道了</a></div>`
      : `<p class="lede">删除后，这台机器人的配置将从 ThreadFerry 中移除。此操作无法撤销。</p>
         <div class="modal-actions"><a class="button ghost" href="/agents" data-close-dialog>取消</a><button class="danger">确认删除</button></div>`;
  const body = groups.length === 0 && !isOnlyAgent
    ? `<form method="post" action="/agents/remove">${field(token)}<input type="hidden" name="agentId" value="${html(agentId)}"><h3 id="${html(dialogId)}-title">${heading}</h3>${error ? errorBar(error) : ""}${content}</form>`
    : `<div class="modal-body"><h3 id="${html(dialogId)}-title">${heading}</h3>${error ? errorBar(error) : ""}${content}</div>`;
  return `<dialog id="${html(dialogId)}" class="modal" aria-labelledby="${html(dialogId)}-title"${open ? " open" : ""}>${body}</dialog>`;
}

function addUserDialog(
  token: string,
  dialogId: string,
  groupId: string,
  agentId: string,
  label: string,
  open: boolean,
  error?: string,
): string {
  return `
    <dialog id="${html(dialogId)}" class="modal" aria-labelledby="${html(dialogId)}-title"${open ? " open" : ""}>
      <form method="post" action="/groups/users/add">${field(token)}<input type="hidden" name="groupId" value="${html(groupId)}"><input type="hidden" name="agentId" value="${html(agentId)}">
        <h3 id="${html(dialogId)}-title">添加可使用用户</h3>
        <p class="lede">授权给 <b>${html(agentId)}</b> 在 ${identity(label, groupId, "群 ID")} 里使用</p>
        ${error ? errorBar(error) : ""}
        <div class="fields">
          <div class="field">
            <label for="${html(dialogId)}-user">用户</label>
            <div class="picker" data-picker-root>
              <input id="${html(dialogId)}-user" name="user" data-picker="users" data-agent-id="${html(agentId)}" placeholder="点这里搜索姓名或别名" maxlength="512" required autofocus>
            </div>
            <p class="hint">点输入框搜索姓名或别名。 <span class="picked" data-picker-note="user"></span></p>
          </div>
        </div>
        <div class="modal-actions"><a class="button ghost" href="${html(groupAnchor(groupId))}" data-close-dialog>取消</a><button>添加</button></div>
      </form>
    </dialog>`;
}


async function agentsPage(config: ThreadFerryConfig, dependencies: AdminDependencies, token: string, url: URL): Promise<string> {
  const { sessions } = await fetchSessions(config, dependencies);
  const names = new Map(sessions.map((session) => [session.id, session.name]));
  const boundByAgent = new Map<string, Array<{ id: string; label: string }>>();
  for (const [id, group] of Object.entries(config.groups)) {
    for (const agentId of Object.keys(group.agents)) {
      const list = boundByAgent.get(agentId) ?? [];
      list.push({ id, label: names.get(id) ?? "未获取群名" });
      boundByAgent.set(agentId, list);
    }
  }
  const total = Object.keys(config.agents).length;
  const requestedRuntime = url.searchParams.get("runtime")?.trim() ?? "";
  const prefill = {
    name: url.searchParams.get("name")?.trim() ?? "",
    runtime: isRuntimeName(requestedRuntime) ? requestedRuntime : "codex",
    model: url.searchParams.get("model")?.trim() ?? "",
    workspace: url.searchParams.get("workspace")?.trim() ?? "",
    configDir: url.searchParams.get("configDir")?.trim() ?? "",
    authMode: ["qr", "manual", "later"].includes(url.searchParams.get("authMode") ?? "")
      ? url.searchParams.get("authMode")!
      : "qr",
  };
  const browseLink = `/agents/browse?${carryParams(url, { ...(prefill.workspace ? { path: prefill.workspace } : {}), new: "1" })}`;
  // 每个 Agent 一个机器人：授权状态与 Owner 都是 Agent 自己的属性，必须显示出来。
  const botStatuses = await fetchBotStatuses(config, dependencies);
  const capabilityAgent = url.searchParams.get("capability")?.trim();
  if (capabilityAgent && config.agents[capabilityAgent]) {
    const status = botStatuses.get(capabilityAgent);
    if (status?.authorized && dependencies.probeCapabilities) {
      try {
        const capabilities = await dependencies.probeCapabilities(capabilityAgent);
        if (capabilities) botStatuses.set(capabilityAgent, { ...status, capabilities });
      } catch {
        // 探测异常不是权限缺失；弹窗保持“检测中”，由页面和后台继续重试。
      }
    }
  }
  const openAuth = url.searchParams.get("auth")?.trim();
  const openWorkspace = url.searchParams.get("editWorkspace")?.trim();
  const openRemove = url.searchParams.get("remove")?.trim();
  const error = url.searchParams.get("error") ?? undefined;
  const authDialogs: string[] = [];
  const workspaceDialogs: string[] = [];
  const removeDialogs: string[] = [];
  const cards = Object.entries(config.agents).map(([id, agent], index) => {
    const bound = boundByAgent.get(id) ?? [];
    const attached = bound.filter((group) => config.groups[group.id]?.agents[id]?.removed !== true);
    const bot = botStatuses.get(id);
    const botLine = bot === undefined
      ? ""
      : bot.authorized
        ? `<p>机器人 ${identity(bot.botName ?? id, bot.botId ?? "", "Bot ID")} <span class="badge ok">已授权</span></p>`
        : `<p>机器人 <span class="badge warning">未授权</span></p><p class="muted">${html(bot.hint ?? `在终端执行 threadferry agent login ${id}`)}</p>`;
    const connection = bot?.connection;
    const connectionLine = connection
      ? `<p>长连接 <span class="badge ${connection.state === "connected" ? "ok" : "warning"}">${html(connection.state === "connected" ? "在线" : connection.state === "connecting" ? "连接中" : connection.state === "reconnecting" ? `重连中${connection.reconnectAttempt ? ` · 第 ${connection.reconnectAttempt} 次` : ""}` : "已断开")}</span> <small class="muted">状态更新 ${html(connection.changedAt)}${connection.lastEventAt ? ` · 最后回调 ${html(connection.lastEventAt)}` : ""}</small></p>`
      : bot?.authorized ? `<p class="muted">已读取授权凭据，正在建立连接。</p>` : "";
    const dialogId = `auth-bot-${index}`;
    const authOpen = openAuth === id;
    if (!bot?.authorized) authDialogs.push(botAuthDialog(token, dialogId, id, prefill.authMode, authOpen, authOpen ? error : undefined));
    const workspaceDialogId = `edit-workspace-${index}`;
    const workspaceOpen = openWorkspace === id;
    const workspace = workspaceOpen ? url.searchParams.get("workspace")?.trim() || agent.workspace : agent.workspace;
    const workspaceBrowseLink = `/agents/browse?${new URLSearchParams({ editWorkspace: id, path: workspace })}`;
    workspaceDialogs.push(editWorkspaceDialog(token, workspaceDialogId, id, workspace, workspaceBrowseLink, workspaceOpen, workspaceOpen ? error : undefined));
    const removeDialogId = `remove-agent-${index}`;
    const removeOpen = openRemove === id;
    removeDialogs.push(removeAgentDialog(token, removeDialogId, id, attached, total <= 1, removeOpen, removeOpen ? error : undefined));
    return `
    <article class="card">
      <div class="row"><h3>${html(id)}</h3><span>${bot?.org ? `<span class="badge org">${html(bot.org)}</span> ` : ""}<span class="badge">${html(agent.runtime)}</span></span></div>
      <p>${html(agent.model ?? "默认模型")}</p><code>${html(agent.workspace)}</code>
      ${botLine}
      ${connectionLine}
      ${bot?.authorized ? capabilityLine(bot.capabilities) : ""}
      <p>Owner ${identity(bot?.ownerName ?? "未获取姓名", agent.ownerUser, "Owner ID")}</p>
      <h4>接入群</h4>
      ${bound.length
        ? `<ul class="links">${bound.map((group) => `<li><a href="${groupAnchor(group.id)}">${identity(group.label, group.id, "群 ID", false)}</a></li>`).join("")}</ul>`
        : `<p class="muted">未被任何群使用</p>`}
      <div class="actions">
        <a class="button ghost" href="/agents?editWorkspace=${encodeURIComponent(id)}" data-dialog="${workspaceDialogId}">修改工作区</a>
        ${bot?.authorized
          ? `<a class="button ghost" href="/agents?capability=${encodeURIComponent(id)}">刷新机器人状态</a>`
          : `<a class="button ghost" href="/agents?auth=${encodeURIComponent(id)}" data-dialog="${dialogId}">授权机器人</a>`}
        <a class="button danger" href="/agents?remove=${encodeURIComponent(id)}" data-dialog="${removeDialogId}">删除机器人</a>
      </div>
    </article>`;
  }).join("");
  const open = url.searchParams.get("new") === "1";
  const errorInDialog = (open
    || (openAuth !== undefined && config.agents[openAuth] !== undefined)
    || (openWorkspace !== undefined && config.agents[openWorkspace] !== undefined)
    || (openRemove !== undefined && config.agents[openRemove] !== undefined)) && error !== undefined;
  return shell("agents", config, url, `
    <div class="toolbar">
      <p class="sub">每台机器人对应一个独立 Agent，凭据、Owner、群、Workspace 和 Session 互相隔离。卡片右上角是 Owner 在通讯录里的顶层部门。</p>
      <a class="button" href="/agents?${carryParams(url, { new: "1" })}" data-dialog="add-agent">＋ 添加机器人</a>
    </div>
    <div class="grid">${cards}</div>
    ${authDialogs.join("")}
    ${workspaceDialogs.join("")}
    ${removeDialogs.join("")}
    ${capabilityAgent && config.agents[capabilityAgent]
      ? capabilityResultDialog(capabilityAgent, botStatuses.get(capabilityAgent)?.authorized === true, botStatuses.get(capabilityAgent)?.capabilities)
      : ""}
    ${addAgentDialog(token, prefill, browseLink, open, open ? error : undefined)}`, { errorInDialog });
}

// 无脚本时的目录浏览回退页：选中目录后带着已填的值回到添加对话框。
async function browsePage(config: ThreadFerryConfig, url: URL): Promise<string> {
  const listing = await listDirectories(url.searchParams.get("path") ?? undefined, false);
  const editWorkspace = url.searchParams.get("editWorkspace")?.trim();
  if (editWorkspace && !config.agents[editWorkspace]) throw new Error("机器人不存在");
  const browse = (path: string) => editWorkspace
    ? `/agents/browse?${new URLSearchParams({ editWorkspace, path })}`
    : `/agents/browse?${carryParams(url, { path })}`;
  const choose = editWorkspace
    ? `/agents?${new URLSearchParams({ editWorkspace, workspace: listing.current })}`
    : `/agents?${carryParams(url, { workspace: listing.current, new: "1" })}`;
  const back = editWorkspace ? `/agents?editWorkspace=${encodeURIComponent(editWorkspace)}` : "/agents";
  return shell("agents", config, url, `
    <article class="card">
      <h3>选择 Workspace 目录</h3>
      ${listing.note ? `<p class="muted">${html(listing.note)}</p>` : ""}
      <p>当前目录：<code>${html(listing.current)}</code></p>
      <p><a class="button" href="${html(choose)}">使用此目录</a> <a href="${html(back)}">返回机器人管理</a></p>
      ${listing.parent ? `<p><a href="${html(browse(listing.parent))}">↑ 上级目录</a></p>` : ""}
      <ul class="links">${listing.entries.map((entry) => `<li><a href="${html(browse(entry.path))}">${html(entry.name)}/</a></li>`).join("") || `<li class="muted">没有可进入的子目录</li>`}</ul>
      ${listing.truncated ? `<p class="muted">子目录过多，仅显示前 ${MAX_DIRECTORY_ENTRIES} 个。</p>` : ""}
    </article>`);
}

// 一个群里可以同时启用多台机器人：卡片按 Agent 分段，每段各有自己的可用开关、授权名单和 Session。
function agentSection(
  token: string,
  groupId: string,
  agentId: string,
  access: GroupAccess,
  owner: string | undefined,
  runtime: string | undefined,
  dialogId: string,
  userName: ((userId: string) => string | undefined) | undefined,
  canReset: boolean,
  canRemove: boolean,
  confirmed: boolean,
  contactState: WecomCapabilitySnapshot["contact"] | undefined,
): string {
  const enabled = access.enabled !== false;
  const removed = access.removed === true;
  const hidden = `${field(token)}<input type="hidden" name="groupId" value="${html(groupId)}"><input type="hidden" name="agentId" value="${html(agentId)}">`;
  if (removed) return `
      <section class="agent-block">
        <div class="row">
          <h4>${html(agentId)}${runtime ? ` <span class="badge">${html(runtime)}</span>` : ""} <span class="badge warning">已移除</span></h4>
          <form method="post" action="/groups/enabled">${hidden}<input type="hidden" name="enabled" value="on"><button class="ghost">重新接入</button></form>
        </div>
        <p class="muted">ThreadFerry 不再响应这个群，原授权和 Session 已清理。企业微信暂不支持机器人主动退群；如需从群成员中移除，请由群管理员在企业微信中操作。</p>
      </section>`;
  // 成员一律名称优先；尚未收集到姓名时也只在悬停或聚焦后显示 id。
  const users = access.allowUsers.map((userId) => {
    const name = userName?.(userId);
    const label = `<span class="person">${identity(name ?? "未识别用户", userId, "用户 ID")}</span>`;
    return `
    <li class="member-row"><span class="member-main">${label}${userId === owner ? "<span class=owner>Owner</span>" : ""}</span>${userId === owner ? "" : `
      <form method="post" action="/groups/users/remove">${field(token)}<input type="hidden" name="groupId" value="${html(groupId)}"><input type="hidden" name="agentId" value="${html(agentId)}"><input type="hidden" name="userId" value="${html(userId)}"><button class="danger">移除</button></form>`}</li>`;
  }).join("");
  return `
      <section class="agent-block">
        <div class="agent-heading">
          <h4>${html(agentId)}${runtime ? ` <span class="badge">${html(runtime)}</span>` : ""}${confirmed ? ` <span class="badge ok">机器人已在群</span>` : ""} <span class="badge${enabled ? " ok" : " warning"}">${enabled ? "可用" : "已停用"}</span></h4>
          <div class="agent-controls">
            <form method="post" action="/groups/enabled">${hidden}<input type="hidden" name="enabled" value="${enabled ? "off" : "on"}"><button class="ghost">${enabled ? "停用机器人" : "启用机器人"}</button></form>
            <form method="post" action="/groups/access">${hidden}<input type="hidden" name="allowAll" value="${access.allowAll ? "off" : "on"}"><button class="ghost">${access.allowAll ? "关闭全员可用" : "开启全员可用"}</button></form>
          </div>
        </div>
        ${enabled ? "" : `<p class="muted">这台机器人已停用，群内 @ 不会启动 Agent；成员名单和 Session 仍保留。</p>`}
        <div class="agent-access"><span class="badge${access.allowAll ? " ok" : ""}">${access.allowAll ? "全员可用" : "仅授权成员"}</span>${access.allowAll ? `<p class="muted">群内所有成员都可以 @ 这台机器人；以下名单在关闭后生效。</p>` : ""}</div>
        <ul class="member-list">${users}</ul>
        <div class="agent-actions">
          ${contactState === "unavailable"
            ? `<span class="muted">通讯录未授权，按姓名添加成员不可用；可使用邀请码或开启全员可用。</span>`
            : `<a class="button ghost" href="${html(groupUserAnchor(groupId, agentId))}" data-dialog="${html(dialogId)}">＋ 添加可使用用户</a>`}
          ${canReset ? `<form method="post" action="/groups/session/reset">${hidden}<button class="ghost">重置 Session</button></form>` : ""}
          ${canRemove ? `<form class="danger-action" method="post" action="/groups/remove" data-confirm="确定移除 ${html(agentId)} 在这个群的 ThreadFerry 绑定吗？授权和 Session 会被清理。"><input type="hidden" name="csrf" value="${html(token)}"><input type="hidden" name="groupId" value="${html(groupId)}"><input type="hidden" name="agentId" value="${html(agentId)}"><button class="danger">移除机器人</button></form>` : ""}
        </div>
        ${canRemove ? `<p class="muted">“移除机器人”只移除 ThreadFerry 绑定；从企业微信群成员中移除仍需群管理员操作。</p>` : ""}
      </section>`;
}

function groupListItem(id: string, label: string, group: GroupBinding | undefined): string {
  const agents = Object.keys(group?.agents ?? {});
  const enabled = agents.filter((agentId) => group?.agents[agentId]?.enabled !== false);
  const attached = agents.filter((agentId) => !group?.agents[agentId]?.removed);
  const state = agents.length === 0 ? "等待首次 @" : attached.length === 0 ? "已移除" : enabled.length > 0 ? `${enabled.length} 台可用` : "已停用";
  return `<a class="group-row" href="${html(groupAnchor(id))}">
    <span class="group-main"><span class="group-avatar" aria-hidden="true">群</span><span class="group-label">${identity(label, id, "群 ID", false)}</span></span>
    <span class="group-agents">${agents.length
      ? agents.map((agentId) => `<span class="badge${group?.agents[agentId]?.enabled !== false ? " ok" : " warning"}">${html(agentId)}${group?.agents[agentId]?.removed ? " · 已移除" : group?.agents[agentId]?.enabled === false ? " · 停用" : ""}</span>`).join("")
      : `<span class="muted">收到机器人首次群 @ 后自动启用</span>`}</span>
    <span class="group-state"><span class="badge ${enabled.length > 0 ? "ok" : "warning"}">${state}</span><span class="row-arrow" aria-hidden="true">›</span></span>
  </a>`;
}

async function groupsPage(config: ThreadFerryConfig, dependencies: AdminDependencies, url: URL): Promise<string> {
  const { sessions, failures } = await fetchSessions(config, dependencies);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const groupIds = [...new Set([...sessions.map((session) => session.id), ...Object.keys(config.groups)])];
  const groups = groupIds.map((id) => groupListItem(id, byId.get(id)?.name ?? "未获取群名", config.groups[id]));
  return shell("groups", config, url, `
    ${failures.length > 0 ? `<h2>群查询失败</h2><div class="grid">${failureCard(failures)}</div>` : ""}
    <div class="toolbar"><p class="sub">把机器人拉入群后，第一次 @它 即自动启用；群详情可停用、重新接入、移除 ThreadFerry 绑定和管理成员。</p><a class="button ghost" href="/groups">刷新群列表</a></div>
    <div class="list-panel">${groups.join("") || `<p class="empty-state">还没发现任何群。${DISCOVERY_HINT}</p>`}</div>`);
}

async function groupDetailPage(config: ThreadFerryConfig, dependencies: AdminDependencies, token: string, url: URL): Promise<string> {
  const id = url.searchParams.get("id")?.trim() ?? "";
  if (!GROUP_ID.test(id)) return shell("groups", config, url, `<p><a class="back-link" href="/groups">← 返回群聊列表</a></p>${errorBar("群 ID 无效")}`);
  const [{ sessions, visibleTo, confirmedBy, failures }, botStatuses] = await Promise.all([
    fetchSessions(config, dependencies),
    fetchBotStatuses(config, dependencies),
  ]);
  const session = sessions.find((item) => item.id === id);
  const group = config.groups[id];
  if (!session && !group) return shell("groups", config, url, `<p><a class="back-link" href="/groups">← 返回群聊列表</a></p>${errorBar("群聊不存在或当前不可见")}`);
  const label = session?.name ?? "未获取群名";
  const visible = visibleTo.get(id) ?? new Set<string>();
  const confirmed = confirmedBy.get(id) ?? new Set<string>();
  const openDialog = url.searchParams.get("user")?.trim() ?? "";
  const error = url.searchParams.get("error") ?? undefined;
  const dialogs: string[] = [];
  let openedInDialog = false;
  let body: string;
  if (!group || Object.keys(group.agents).length === 0) {
    body = waitingCard(id, label, visible);
  } else {
    const sections = Object.entries(group.agents).map(([agentId, access], index) => {
      const dialogId = `add-user-${index}`;
      const openHere = openDialog === `${agentId}\n${id}`;
      if (openHere && error !== undefined) openedInDialog = true;
      const contactState = botStatuses.get(agentId)?.capabilities?.contact;
      if (contactState !== "unavailable") dialogs.push(addUserDialog(token, dialogId, id, agentId, label, openHere, openHere ? error : undefined));
      return agentSection(token, id, agentId, access, config.agents[agentId]?.ownerUser,
        config.agents[agentId]?.runtime, dialogId, dependencies.userName, Boolean(dependencies.resetSession), Boolean(dependencies.removeGroup), confirmed.has(agentId), contactState);
    }).join("");
    const spare = [...visible].filter((agentId) => config.agents[agentId] && !group.agents[agentId]);
    body = `<article class="card group-detail"><p class="muted group-intro">群里 @ 哪台机器人，就由它用自己的 Workspace 回答；名单、开关和 Session 各自独立。</p>${sections}
      ${spare.length > 0 ? `<p class="muted">要让其他机器人也接入本群，直接在群里分别 @它们一次；收到后会自动启用。</p>` : ""}</article>`;
  }
  return shell("groups", config, url, `<p><a class="back-link" href="/groups">← 返回群聊列表</a></p>
    <div class="detail-title"><div><p class="eyebrow">群聊详情</p><h2>${identity(label, id, "群 ID")}</h2></div><div class="detail-title-actions"><span class="badge${group && Object.values(group.agents).some((access) => access.enabled !== false) ? " ok" : " warning"}">${group ? `${Object.values(group.agents).filter((access) => access.enabled !== false).length} 台机器人可用` : "等待首次 @"}</span><a class="button ghost" href="${html(groupAnchor(id))}">↻ 刷新</a></div></div>
    ${failures.length > 0 ? failureCard(failures) : ""}${body}${dialogs.join("")}`, { errorInDialog: openedInDialog });
}

export async function startAdminServer(
  config: ThreadFerryConfig,
  dependencies: AdminDependencies,
  port = 17_638,
): Promise<{ url: string; close: () => Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    if (!localHost(request.headers.host)) return send(response, 403, "Forbidden");
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET") {
      try {
        if (url.pathname === "/admin.css") return sendAsset(response, "text/css; charset=utf-8", STYLESHEET);
        if (url.pathname === "/admin.js") return sendAsset(response, "text/javascript; charset=utf-8", CLIENT_SCRIPT);
        if (url.pathname === "/api/dirs") return sendJson(response, 200, await listDirectories(url.searchParams.get("path") ?? undefined, true));
        if (url.pathname === "/api/users") {
          const agentId = url.searchParams.get("agent")?.trim() ?? "";
          if (!config.agents[agentId]) return sendJson(response, 400, { users: [], note: "Agent 无效。" });
          return sendJson(response, 200, await searchDirectoryUsers(dependencies, agentId, url.searchParams.get("q")?.trim() ?? ""));
        }
        if (url.pathname === "/") return send(response, 200, await overviewPage(config, dependencies, url));
        if (url.pathname === "/agents") return send(response, 200, await agentsPage(config, dependencies, token, url));
        if (url.pathname === "/agents/browse") return send(response, 200, await browsePage(config, url));
        if (url.pathname === "/groups") return send(response, 200, await groupsPage(config, dependencies, url));
        if (url.pathname === "/groups/detail") return send(response, 200, await groupDetailPage(config, dependencies, token, url));
        if (url.pathname === "/logs") return send(response, 200, await logsPage(config, dependencies, token, url));
        if (url.pathname === "/settings") return send(response, 200, settingsPage(config, url, token));
        return send(response, 404, "Not found");
      } catch {
        return send(response, 500, "ThreadFerry 管理台暂时无法读取配置");
      }
    }
    if (request.method !== "POST") return send(response, 404, "Not found");

    let input: URLSearchParams;
    try {
      input = await form(request);
    } catch (error) {
      return send(response, 400, html(error instanceof Error ? error.message : "Bad request"));
    }
    if (input.get("csrf") !== token) return send(response, 403, "Forbidden");
    let target = "/";
    // 出错时回到「表单还开着、值还在」的地址；只有添加类操作需要，其他动作沿用 target。
    let errorTarget: string | undefined;
    let message = "配置已更新并立即生效";
    try {
      if (url.pathname === "/logs/clear") {
        target = "/logs";
        if (!dependencies.clearLogs) throw new Error("当前启动方式不支持清理日志");
        const removed = await dependencies.clearLogs();
        message = removed > 0 ? `已清理 ${removed} 条日志` : "没有可清理的日志";
      } else if (url.pathname === "/settings/update") {
        target = "/settings";
        if (!dependencies.checkUpdate) throw new Error("当前启动方式不支持检查更新");
        const release = await dependencies.checkUpdate();
        message = release
          ? `发现新版本 ThreadFerry ${release.version}，请保持 ThreadFerry 桌面应用运行以自动更新`
          : "ThreadFerry 已是最新版本";
      } else if (url.pathname === "/agents/add") {
        target = "/agents";
        errorTarget = `/agents?${new URLSearchParams({
          new: "1",
          ...(input.get("agentId")?.trim() ? { name: input.get("agentId")!.trim() } : {}),
          ...(input.get("runtime")?.trim() ? { runtime: input.get("runtime")!.trim() } : {}),
          ...(input.get("workspace")?.trim() ? { workspace: input.get("workspace")!.trim() } : {}),
          ...(input.get("model")?.trim() ? { model: input.get("model")!.trim() } : {}),
          ...(input.get("configDir")?.trim() ? { configDir: input.get("configDir")!.trim() } : {}),
          ...(input.get("authMode")?.trim() ? { authMode: input.get("authMode")!.trim() } : {}),
        })}`;
        const agentId = required(input, "agentId");
        const runtime = required(input, "runtime") as RuntimeName;
        if (!isRuntimeName(runtime)) throw new Error("runtime 仅支持 codex、pi、claude 或 grok");
        const workspace = await resolveWorkspace(required(input, "workspace"));
        const model = input.get("model")?.trim() || undefined;
        const configDir = input.get("configDir")?.trim() || undefined;
        const authorization = botAuthorization(input);
        await dependencies.updateConfig((latest) => {
          latest.agents = addAgent(latest, agentId, {
            runtime,
            workspace,
            ...(model ? { model } : {}),
            ...(configDir ? { configDir } : {}),
          }).agents;
        });
        message = `机器人 ${agentId} 已添加`;
        if (authorization) {
          errorTarget = `/agents?auth=${encodeURIComponent(agentId)}`;
          if (!dependencies.authorizeBot) throw new Error("当前启动方式不支持机器人授权");
          await dependencies.authorizeBot(agentId, authorization);
          target = `/agents?capability=${encodeURIComponent(agentId)}`;
          message = authorization.mode === "qr"
            ? `机器人 ${agentId} 已添加，扫码授权页已打开；完成后刷新本页即可自动连接`
            : `机器人 ${agentId} 已添加并授权，正在建立连接`;
          if (authorization.mode === "manual") await dependencies.connectBot?.(agentId);
        }
      } else if (url.pathname === "/agents/auth") {
        const agentId = required(input, "agentId");
        target = `/agents?capability=${encodeURIComponent(agentId)}`;
        if (!config.agents[agentId]) throw new Error("机器人不存在");
        const authorization = botAuthorization(input);
        if (!authorization) throw new Error("请选择机器人授权方式");
        errorTarget = `/agents?${new URLSearchParams({ auth: agentId, authMode: authorization.mode })}`;
        if (!dependencies.authorizeBot) throw new Error("当前启动方式不支持机器人授权");
        const status = await dependencies.botStatus?.(agentId);
        if (status?.authorized) {
          await dependencies.connectBot?.(agentId);
          message = `机器人 ${agentId} 已授权，正在建立连接`;
        } else {
          await dependencies.authorizeBot(agentId, authorization);
          message = authorization.mode === "qr"
            ? `机器人 ${agentId} 的扫码授权页已打开；完成后刷新本页即可自动连接`
            : `机器人 ${agentId} 已授权，正在建立连接`;
          if (authorization.mode === "manual") await dependencies.connectBot?.(agentId);
        }
      } else if (url.pathname === "/agents/workspace") {
        target = "/agents";
        const agentId = required(input, "agentId");
        const workspaceInput = input.get("workspace")?.trim() ?? "";
        errorTarget = `/agents?${new URLSearchParams({ editWorkspace: agentId, ...(workspaceInput ? { workspace: workspaceInput } : {}) })}`;
        const workspace = await resolveWorkspace(required(input, "workspace"));
        await dependencies.updateConfig((latest) => {
          const agent = latest.agents[agentId];
          if (!agent) throw new Error("机器人不存在");
          agent.workspace = workspace;
        });
        message = `机器人 ${agentId} 的工作区已更新`;
      } else if (url.pathname === "/agents/remove") {
        target = "/agents";
        const agentId = required(input, "agentId");
        errorTarget = `/agents?remove=${encodeURIComponent(agentId)}`;
        await dependencies.updateConfig((latest) => {
          if (!latest.agents[agentId]) throw new Error("机器人不存在");
          if (Object.values(latest.groups).some((group) => {
            const access = group.agents[agentId];
            return access && access.removed !== true;
          })) {
            throw new Error("仍有群绑定此机器人，请先在群详情解除绑定");
          }
          if (Object.keys(latest.agents).length <= 1) throw new Error("至少保留一个机器人");
          for (const [groupId, group] of Object.entries(latest.groups)) {
            delete group.agents[agentId];
            if (Object.keys(group.agents).length === 0) delete latest.groups[groupId];
          }
          delete latest.agents[agentId];
        });
        message = `机器人 ${agentId} 已删除`;
      } else if (url.pathname === "/groups/enabled") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        const enabled = required(input, "enabled");
        if (enabled !== "on" && enabled !== "off") throw new Error("可用开关取值无效");
        await dependencies.updateConfig((latest) => {
          const access = latest.groups[groupId]?.agents[agentId];
          if (!access) throw new Error("该群没有这个机器人记录");
          if (enabled === "on") {
            delete access.enabled;
            delete access.removed;
          }
          else access.enabled = false;
        });
        target = groupAnchor(groupId);
        message = enabled === "on" ? `${agentId} 已启用` : `${agentId} 已停用，群内 @ 不会启动 Agent`;
      } else if (url.pathname === "/groups/remove") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        if (!dependencies.removeGroup) throw new Error("当前启动方式不支持移除群机器人绑定");
        await dependencies.removeGroup(groupId, agentId);
        target = groupAnchor(groupId);
        message = `${agentId} 的 ThreadFerry 群绑定已移除；从企业微信群成员中移除仍需群管理员操作`;
      } else if (url.pathname === "/groups/access") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        const allowAll = required(input, "allowAll");
        if (allowAll !== "on" && allowAll !== "off") throw new Error("访问开关取值无效");
        await dependencies.updateConfig((latest) => {
          const access = activeGroupAccess(latest, groupId, agentId);
          if (allowAll === "on") access.allowAll = true;
          else delete access.allowAll;
        });
        target = groupAnchor(groupId);
        message = allowAll === "on"
          ? `已开启：群内所有成员都可以 @ ${agentId}`
          : `已关闭：${agentId} 恢复为仅授权成员可用`;
      } else if (url.pathname === "/groups/users/add") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        target = groupAnchor(groupId);
        errorTarget = groupUserAnchor(groupId, agentId);
        const user = await resolveDirectoryUser(required(input, "user"), (keywords) => dependencies.searchUsers(agentId, keywords));
        if (!USER_ID.test(user.id)) throw new Error("通讯录返回的 userid 无效");
        await dependencies.updateConfig((latest) => {
          const access = activeGroupAccess(latest, groupId, agentId);
          access.allowUsers = [...new Set([...access.allowUsers, user.id])];
          if (access.allowUsers.length > 256) throw new Error("可使用用户已达到 256 人上限");
        });
        // 这一刻我们同时知道 id 和姓名，记下来，列表里以后就能显示名字。
        dependencies.rememberUser?.(user.id, user.name);
        message = `已允许 ${user.name} 使用 ${agentId}`;
      } else if (url.pathname === "/groups/users/remove") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        const userId = required(input, "userId");
        await dependencies.updateConfig((latest) => {
          const access = activeGroupAccess(latest, groupId, agentId);
          if (userId === latest.agents[agentId]?.ownerUser) throw new Error(`不能移除 Agent ${agentId} 的 Owner`);
          access.allowUsers = access.allowUsers.filter((id) => id !== userId);
        });
        target = groupAnchor(groupId);
        message = "可使用用户已更新";
      } else if (url.pathname === "/groups/session/reset") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        if (!dependencies.resetSession) throw new Error("当前启动方式不支持重置 Session");
        activeGroupAccess(config, groupId, agentId);
        const removed = await dependencies.resetSession(groupId, agentId);
        target = groupAnchor(groupId);
        message = removed ? `${agentId} 在该群的 Runtime Session 已重置` : `${agentId} 在该群没有已保存的 Runtime Session`;
      } else {
        return send(response, 404, "Not found");
      }
      redirect(response, "ok", message, target);
    } catch (error) {
      redirect(response, "error", error instanceof Error ? error.message : "配置更新失败", errorTarget ?? target);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => {
      if (!server.listening) return resolve();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}
