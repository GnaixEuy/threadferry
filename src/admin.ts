import { randomBytes } from "node:crypto";
import { readdir, realpath, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { addAgent, resolveWorkspace } from "./config.js";
import { resolveDirectoryUser } from "./directory.js";
import type { StateSnapshot } from "./state.js";
import type { DirectoryUser, RuntimeName, ThreadFerryConfig } from "./types.js";

export type ConfigUpdater = (change: (latest: ThreadFerryConfig) => void | Promise<void>) => Promise<void>;

export interface AdminDependencies {
  updateConfig: ConfigUpdater;
  listGroups: () => Promise<Array<{ id: string; name?: string }>>;
  searchUsers: (keywords: string[]) => Promise<DirectoryUser[]>;
  snapshot?: () => Promise<StateSnapshot>;
  resetSession?: (groupId: string) => Promise<boolean>;
}

const GROUP_ID = /^[^\s\u0000-\u001f]{1,512}$/;
const USER_ID = /^[A-Za-z0-9_@.-]{1,512}$/;

function html(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]!);
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
  response.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
}

function send(response: ServerResponse, status: number, content: string): void {
  securityHeaders(response);
  response.writeHead(status);
  response.end(content);
}

function redirect(response: ServerResponse, kind: "ok" | "error", message: string, target = "/"): void {
  securityHeaders(response);
  response.statusCode = 303;
  const [path, fragment] = target.split("#", 2);
  response.setHeader("Location", `${path}?${kind}=${encodeURIComponent(message)}${fragment ? `#${fragment}` : ""}`);
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

function agentOptions(config: ThreadFerryConfig, selected?: string): string {
  return Object.keys(config.agents).map((id) => `<option value="${html(id)}"${id === selected ? " selected" : ""}>${html(id)}</option>`).join("");
}

function field(token: string): string {
  return `<input type="hidden" name="csrf" value="${token}">`;
}

function groupAnchor(groupId: string): string {
  return `/groups#${encodeURIComponent(groupId)}`;
}

function carryParams(url: URL, extra?: Record<string, string>): string {
  const params = new URLSearchParams();
  for (const key of ["name", "runtime", "model"]) {
    const value = url.searchParams.get(key)?.trim();
    if (value) params.set(key, value);
  }
  for (const [key, value] of Object.entries(extra ?? {})) params.set(key, value);
  return params.toString();
}

async function fetchSessions(dependencies: AdminDependencies): Promise<Array<{ id: string; name?: string }>> {
  try {
    return await dependencies.listGroups();
  } catch {
    // 企业微信查询失败时，配置中的群仍可管理。
    return [];
  }
}

async function fetchSnapshot(dependencies: AdminDependencies): Promise<StateSnapshot | undefined> {
  try {
    return await dependencies.snapshot?.();
  } catch {
    // 状态存储不可用时只隐藏运行状态，不阻断配置管理。
    return undefined;
  }
}

async function fetchUserNames(config: ThreadFerryConfig, dependencies: AdminDependencies): Promise<Map<string, string>> {
  const userIds = [...new Set(Object.values(config.groups).flatMap((group) => group.allowUsers))];
  const userNames = new Map<string, string>();
  try {
    for (let index = 0; index < userIds.length; index += 10) {
      const batch = userIds.slice(index, index + 10);
      for (const user of await dependencies.searchUsers(batch)) {
        userNames.set(user.id, user.name);
        for (const keyword of user.matchedKeywords ?? []) if (batch.includes(keyword)) userNames.set(keyword, user.name);
      }
    }
  } catch {
    // 通讯录不可用时只显示 userid，不阻断其他管理能力。
  }
  return userNames;
}

function bindCard(config: ThreadFerryConfig, token: string, id: string, label: string): string {
  return `
    <article class="card">
      <div class="row"><div><h3>${html(label)}</h3><code>${html(id)}</code></div><span class="badge warning">待绑定</span></div>
      <form method="post" action="/groups/bind">${field(token)}<input type="hidden" name="groupId" value="${html(id)}">
        <select name="agentId" aria-label="Agent 工作区">${agentOptions(config)}</select><button>绑定</button>
      </form>
    </article>`;
}

function shell(active: "overview" | "agents" | "groups", config: ThreadFerryConfig, url: URL, content: string): string {
  const notice = url.searchParams.get("ok");
  const error = url.searchParams.get("error");
  const tabs: Array<[string, typeof active, string]> = [["/", "overview", "概览"], ["/agents", "agents", "Agent 工作区"], ["/groups", "groups", "群聊管理"]];
  const nav = tabs.map(([href, key, label]) => `<a href="${href}"${key === active ? ` class="active"` : ""}>${label}</a>`).join("");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>ThreadFerry 管理台</title><style>
  :root{color-scheme:dark;font:15px/1.5 ui-sans-serif,system-ui,-apple-system;color:#e7e9ee;background:#0c0e13}*{box-sizing:border-box}body{margin:0}main{width:min(1080px,calc(100% - 32px));margin:28px auto 80px}header{display:flex;justify-content:space-between;align-items:end;gap:16px;margin-bottom:18px}h1{font-size:30px;margin:0}h2{margin:30px 0 14px;font-size:20px}h3,h4,p{margin:0 0 10px}.sub,.muted{color:#9ca3af}.tabs{display:flex;gap:4px;border-bottom:1px solid #272b36;margin-bottom:24px}.tabs a{color:#9ca3af;text-decoration:none;padding:10px 14px;border-bottom:2px solid transparent;margin-bottom:-1px;font-weight:650}.tabs a:hover{color:#e7e9ee}.tabs a.active{color:#eef1f6;border-bottom-color:#3975eb}.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.stat{display:block;background:#151821;border:1px solid #272b36;border-radius:14px;padding:14px 16px;text-decoration:none;color:inherit}.stat b{display:block;font-size:26px;margin-bottom:2px}.stat span{color:#9ca3af;font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.card{background:#151821;border:1px solid #272b36;border-radius:14px;padding:18px}.row{display:flex;justify-content:space-between;gap:16px;align-items:start}.badge,.owner{font-size:12px;border-radius:999px;padding:3px 9px;background:#2b3140}.badge.ok{color:#7ee787}.badge.warning{color:#f2cc60}.owner{color:#8cb4ff;margin-left:8px}code{font-family:ui-monospace,SFMono-Regular,Menlo;overflow-wrap:anywhere;color:#b8c2d9}form{display:flex;gap:8px;align-items:end;margin-top:14px;flex-wrap:wrap}label{color:#9ca3af}input,select,button{font:inherit;border-radius:9px;border:1px solid #343a49;background:#0f1218;color:#eef1f6;padding:9px 11px}input{min-width:190px;flex:1}button{cursor:pointer;background:#2f67d8;border-color:#3975eb;font-weight:650}button.ghost{background:transparent;border-color:#343a49;color:#cdd5e4}button.danger{background:transparent;border-color:#7f3340;color:#ff9aa7}li button.danger{padding:4px 8px}ul{list-style:none;padding:0;margin:8px 0}li{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:1px solid #272b36;padding:9px 0}li form{margin:0}ul.links li{border:none;padding:4px 0;justify-content:flex-start}ul.links a{color:#8cb4ff;text-decoration:none}a.button{display:inline-block;background:#2f67d8;border:1px solid #3975eb;border-radius:9px;color:#eef1f6;padding:9px 14px;text-decoration:none;font-weight:650}.notice{padding:11px 14px;border-radius:10px;margin:0 0 16px;background:#143321;color:#8de6a9}.notice.error{background:#3b171d;color:#ffabb4}.agent-form{display:grid;grid-template-columns:1fr 140px 1.6fr 1fr auto;align-items:end}.agent-form label{display:flex;flex-direction:column;gap:5px}.agent-form input{min-width:0;width:100%}.mt{margin-top:14px}.actions{display:flex;gap:8px;flex-wrap:wrap;border-top:1px solid #272b36;margin-top:14px;padding-top:14px}.actions form{margin:0}@media(max-width:760px){header{align-items:start;flex-direction:column}.agent-form{display:flex}}
  </style></head><body><main><header><div><h1>ThreadFerry</h1><div class="sub">本机管理台 · 仅监听 127.0.0.1</div></div><code>Owner: ${html(config.ownerUser)}</code></header>
  <nav class="tabs">${nav}</nav>
  ${notice ? `<div class="notice">${html(notice)}</div>` : ""}${error ? `<div class="notice error">${html(error)}</div>` : ""}
  ${content}
  </main></body></html>`;
}

async function overviewPage(config: ThreadFerryConfig, dependencies: AdminDependencies, token: string, url: URL): Promise<string> {
  const sessions = await fetchSessions(dependencies);
  const snapshot = await fetchSnapshot(dependencies);
  const boundIds = new Set(Object.keys(config.groups));
  const unbound = sessions.filter((session) => !boundIds.has(session.id));
  const counts = new Map<string, number>();
  for (const turn of snapshot?.turns ?? []) counts.set(turn.status, (counts.get(turn.status) ?? 0) + 1);
  const active = (counts.get("queued") ?? 0) + (counts.get("running") ?? 0);
  const lastFailure = snapshot?.turns.slice().reverse().find((turn) => turn.status === "failed");
  const stats: Array<[string, string, string]> = [
    [String(Object.keys(config.agents).length), "Agent 工作区", "/agents"],
    [String(boundIds.size), "已绑定群", "/groups"],
    [String(unbound.length), "待绑定群", "/groups"],
  ];
  if (snapshot) {
    stats.push(
      [String(active), "排队 / 运行中", ""],
      [String(snapshot.sessions.length), "Runtime Session", ""],
      [String(snapshot.outbox.length), "待补发回复", ""],
    );
  }
  const todos: string[] = unbound.map((session) => bindCard(config, token, session.id, session.name ?? "未获取群名"));
  if (lastFailure) {
    todos.push(`<article class="card"><h3>最近一次失败</h3><p class="muted">错误编号 <code>${html(lastFailure.errorId ?? "无")}</code> · 阶段 ${html(lastFailure.failurePhase ?? "unknown")} · ${html(lastFailure.updatedAt)}</p><p class="muted">请在终端运行 <code>threadferry status</code> 和 <code>threadferry doctor</code> 排查。</p></article>`);
  }
  return shell("overview", config, url, `
    <div class="stats">${stats.map(([value, label, href]) => href
      ? `<a class="stat" href="${href}"><b>${value}</b><span>${label}</span></a>`
      : `<div class="stat"><b>${value}</b><span>${label}</span></div>`).join("")}</div>
    ${snapshot ? "" : `<p class="sub mt">运行状态暂不可用；Agent 工作区和群配置管理不受影响。</p>`}
    <h2>待处理</h2>${todos.length ? `<div class="grid">${todos.join("")}</div>` : `<p class="sub">没有待处理事项。</p>`}`);
}

async function agentsPage(config: ThreadFerryConfig, dependencies: AdminDependencies, token: string, url: URL): Promise<string> {
  const sessions = await fetchSessions(dependencies);
  const names = new Map(sessions.map((session) => [session.id, session.name]));
  const boundByAgent = new Map<string, Array<{ id: string; label: string }>>();
  for (const [id, group] of Object.entries(config.groups)) {
    const list = boundByAgent.get(group.agent) ?? [];
    list.push({ id, label: names.get(id) ?? "未获取群名" });
    boundByAgent.set(group.agent, list);
  }
  const total = Object.keys(config.agents).length;
  const prefill = {
    name: url.searchParams.get("name")?.trim() ?? "",
    runtime: url.searchParams.get("runtime")?.trim() === "pi" ? "pi" : "codex",
    model: url.searchParams.get("model")?.trim() ?? "",
    workspace: url.searchParams.get("workspace")?.trim() ?? "",
  };
  const browseLink = `/agents/browse?${carryParams(url, prefill.workspace ? { path: prefill.workspace } : {})}`;
  const cards = Object.entries(config.agents).map(([id, agent]) => {
    const bound = boundByAgent.get(id) ?? [];
    const removable = bound.length === 0 && total > 1;
    return `
    <article class="card">
      <div class="row"><h3>${html(id)}</h3><span class="badge">${html(agent.runtime)}</span></div>
      <p>${html(agent.model ?? "默认模型")}</p><code>${html(agent.workspace)}</code>
      <h4>绑定群</h4>
      ${bound.length
        ? `<ul class="links">${bound.map((group) => `<li><a href="${groupAnchor(group.id)}">${html(group.label)}</a><code>${html(group.id)}</code></li>`).join("")}</ul>`
        : `<p class="muted">未被任何群使用</p>`}
      ${removable
        ? `<div class="actions"><form method="post" action="/agents/remove">${field(token)}<input type="hidden" name="agentId" value="${html(id)}"><button class="danger">删除 Agent 工作区</button></form></div>`
        : ""}
    </article>`;
  }).join("");
  return shell("agents", config, url, `
    <div class="grid">${cards}</div>
    <article class="card mt"><h3>添加 Agent 工作区</h3><form class="agent-form" method="post" action="/agents/add">${field(token)}
      <label>名称<input name="agentId" value="${html(prefill.name)}" required></label>
      <label>Runtime<select name="runtime"><option value="codex"${prefill.runtime === "codex" ? " selected" : ""}>Codex</option><option value="pi"${prefill.runtime === "pi" ? " selected" : ""}>Pi</option></select></label>
      <label>Workspace<input name="workspace" placeholder="/absolute/path" value="${html(prefill.workspace)}" required></label>
      <label>模型（可选）<input name="model" placeholder="provider/model" value="${html(prefill.model)}"></label><button>添加</button></form>
      <p class="muted mt">名称 1-64 个字符，支持中文和空格；Workspace 必须是已存在目录的绝对路径，可以先<a href="${html(browseLink)}">浏览本机目录选择</a>再填写其他信息。</p></article>`);
}

async function browsePage(config: ThreadFerryConfig, url: URL): Promise<string> {
  const requested = url.searchParams.get("path")?.trim() || homedir();
  let current = homedir();
  let note = "";
  if (!isAbsolute(requested)) {
    note = `“${requested}”不是绝对路径，已回到用户主目录。`;
  } else {
    try {
      const canonical = await realpath(requested);
      if (!(await stat(canonical)).isDirectory()) {
        note = `“${requested}”不是目录，已回到用户主目录。`;
      } else {
        current = canonical;
      }
    } catch {
      note = `无法读取“${requested}”，已回到用户主目录。`;
    }
  }
  let entries: string[] = [];
  let truncated = false;
  try {
    const all = (await readdir(current, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
    truncated = all.length > 500;
    entries = all.slice(0, 500);
  } catch {
    note = note || "此目录无法读取。";
  }
  const parent = dirname(current);
  const browse = (path: string) => `/agents/browse?${carryParams(url, { path })}`;
  const choose = `/agents?${carryParams(url, { workspace: current })}`;
  return shell("agents", config, url, `
    <article class="card">
      <h3>选择 Workspace 目录</h3>
      ${note ? `<p class="muted">${html(note)}</p>` : ""}
      <p>当前目录：<code>${html(current)}</code></p>
      <p><a class="button" href="${html(choose)}">使用此目录</a> <a href="/agents">返回 Agent 工作区</a></p>
      ${parent !== current ? `<p><a href="${html(browse(parent))}">↑ 上级目录</a></p>` : ""}
      <ul class="links">${entries.map((name) => `<li><a href="${html(browse(join(current, name)))}">${html(name)}/</a></li>`).join("") || `<li class="muted">没有可进入的子目录</li>`}</ul>
      ${truncated ? `<p class="muted">子目录过多，仅显示前 500 个。</p>` : ""}
    </article>`);
}

async function groupsPage(config: ThreadFerryConfig, dependencies: AdminDependencies, token: string, url: URL): Promise<string> {
  const sessions = await fetchSessions(dependencies);
  const userNames = await fetchUserNames(config, dependencies);
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const groupIds = [...new Set([...sessions.map((session) => session.id), ...Object.keys(config.groups)])];
  const unbound: string[] = [];
  const bound: string[] = [];
  for (const id of groupIds) {
    const group = config.groups[id];
    const label = byId.get(id)?.name ?? "未获取群名";
    if (!group) {
      unbound.push(bindCard(config, token, id, label));
      continue;
    }
    const users = group.allowUsers.map((userId) => `
      <li><span>${userNames.get(userId) ? `${html(userNames.get(userId))} ` : ""}<code>${html(userId)}</code>${userId === config.ownerUser ? "<span class=owner>Owner</span>" : ""}</span>${userId === config.ownerUser ? "" : `
        <form method="post" action="/groups/users/remove">${field(token)}<input type="hidden" name="groupId" value="${html(id)}"><input type="hidden" name="userId" value="${html(userId)}"><button class="danger">移除</button></form>`}</li>`).join("");
    bound.push(`
      <article class="card" id="${html(id)}">
        <div class="row"><div><h3>${html(label)}</h3><code>${html(id)}</code></div><span class="badge ok">已配置</span></div>
        <form method="post" action="/groups/agent">${field(token)}<input type="hidden" name="groupId" value="${html(id)}">
          <label>当前 Agent 工作区 <select name="agentId">${agentOptions(config, group.agent)}</select></label><button>切换</button>
        </form>
        <form method="post" action="/groups/access">${field(token)}<input type="hidden" name="groupId" value="${html(id)}"><input type="hidden" name="allowAll" value="${group.allowAll ? "off" : "on"}">
          <span class="badge${group.allowAll ? " ok" : ""}">${group.allowAll ? "全员可用" : "仅授权成员"}</span><button class="ghost">${group.allowAll ? "关闭全员可用" : "开启全员可用"}</button>
        </form>
        <h4>可使用用户</h4>
        ${group.allowAll ? `<p class="muted">全员可用已开启，群内所有成员都可以使用；以下授权列表在关闭后生效。</p>` : ""}
        <ul>${users}</ul>
        <form method="post" action="/groups/users/add">${field(token)}<input type="hidden" name="groupId" value="${html(id)}">
          <input name="user" aria-label="用户姓名、别名或 userid" placeholder="姓名、别名或 id:userid" maxlength="512" required><button>添加用户</button>
        </form>
        <div class="actions">
          ${dependencies.resetSession ? `<form method="post" action="/groups/session/reset">${field(token)}<input type="hidden" name="groupId" value="${html(id)}"><button class="ghost">重置 Session</button></form>` : ""}
          <form method="post" action="/groups/unbind">${field(token)}<input type="hidden" name="groupId" value="${html(id)}"><button class="danger">解绑群</button></form>
        </div>
      </article>`);
  }
  return shell("groups", config, url, `
    <h2>待绑定</h2><div class="grid">${unbound.join("") || `<p class="sub">所有可见群会话都已绑定。</p>`}</div>
    <h2>已配置群</h2><div class="grid">${bound.join("") || `<p class="sub">暂无已配置群；可在上方待绑定区完成绑定，或私聊机器人发送 threadferry bind 命令。</p>`}</div>`);
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
        if (url.pathname === "/") return send(response, 200, await overviewPage(config, dependencies, token, url));
        if (url.pathname === "/agents") return send(response, 200, await agentsPage(config, dependencies, token, url));
        if (url.pathname === "/agents/browse") return send(response, 200, await browsePage(config, url));
        if (url.pathname === "/groups") return send(response, 200, await groupsPage(config, dependencies, token, url));
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
    let message = "配置已更新并立即生效";
    try {
      if (url.pathname === "/agents/add") {
        const agentId = required(input, "agentId");
        const runtime = required(input, "runtime") as RuntimeName;
        if (runtime !== "codex" && runtime !== "pi") throw new Error("runtime 仅支持 codex 或 pi");
        const workspace = await resolveWorkspace(required(input, "workspace"));
        const model = input.get("model")?.trim() || undefined;
        await dependencies.updateConfig((latest) => {
          latest.agents = addAgent(latest, agentId, { runtime, workspace, ...(model ? { model } : {}) }).agents;
        });
        target = "/agents";
        message = `Agent 工作区 ${agentId} 已添加`;
      } else if (url.pathname === "/agents/remove") {
        const agentId = required(input, "agentId");
        await dependencies.updateConfig((latest) => {
          if (!latest.agents[agentId]) throw new Error("Agent 工作区不存在");
          if (Object.values(latest.groups).some((group) => group.agent === agentId)) {
            throw new Error("仍有群绑定此 Agent 工作区，请先切换或解绑这些群");
          }
          if (Object.keys(latest.agents).length <= 1) throw new Error("至少保留一个 Agent 工作区");
          delete latest.agents[agentId];
        });
        target = "/agents";
        message = `Agent 工作区 ${agentId} 已删除`;
      } else if (url.pathname === "/groups/bind") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        if (!GROUP_ID.test(groupId)) throw new Error("群 ID 无效");
        if (!(await dependencies.listGroups()).some((group) => group.id === groupId)) throw new Error("机器人当前不可见该群");
        await dependencies.updateConfig((latest) => {
          if (latest.groups[groupId]) throw new Error("该群已经配置");
          if (!latest.agents[agentId]) throw new Error("Agent 工作区不存在");
          latest.groups[groupId] = { agent: agentId, allowUsers: [latest.ownerUser], context: { lookbackHours: 6, maxMessages: 80 } };
        });
        target = groupAnchor(groupId);
        message = "群已绑定并立即生效";
      } else if (url.pathname === "/groups/access") {
        const groupId = required(input, "groupId");
        const allowAll = required(input, "allowAll");
        if (allowAll !== "on" && allowAll !== "off") throw new Error("访问开关取值无效");
        await dependencies.updateConfig((latest) => {
          const group = latest.groups[groupId];
          if (!group) throw new Error("群不存在");
          if (allowAll === "on") group.allowAll = true;
          else delete group.allowAll;
        });
        target = groupAnchor(groupId);
        message = allowAll === "on" ? "已开启：群内所有成员都可以使用机器人" : "已关闭：恢复为仅授权成员可使用";
      } else if (url.pathname === "/groups/unbind") {
        const groupId = required(input, "groupId");
        await dependencies.updateConfig((latest) => {
          if (!latest.groups[groupId]) throw new Error("群不存在");
          delete latest.groups[groupId];
        });
        target = "/groups";
        message = "群已解绑，该群的消息将不再触发 Agent 工作区";
      } else if (url.pathname === "/groups/agent") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        await dependencies.updateConfig((latest) => {
          if (!latest.groups[groupId] || !latest.agents[agentId]) throw new Error("群或 Agent 工作区不存在");
          latest.groups[groupId].agent = agentId;
        });
        target = groupAnchor(groupId);
        message = "群 Agent 工作区已切换";
      } else if (url.pathname === "/groups/users/add") {
        const groupId = required(input, "groupId");
        target = groupAnchor(groupId);
        const user = await resolveDirectoryUser(required(input, "user"), dependencies.searchUsers);
        if (!USER_ID.test(user.id)) throw new Error("通讯录返回的 userid 无效");
        await dependencies.updateConfig((latest) => {
          const group = latest.groups[groupId];
          if (!group) throw new Error("群不存在");
          group.allowUsers = [...new Set([...group.allowUsers, user.id])];
          if (group.allowUsers.length > 256) throw new Error("可使用用户已达到 256 人上限");
        });
        message = "可使用用户已更新";
      } else if (url.pathname === "/groups/users/remove") {
        const groupId = required(input, "groupId");
        const userId = required(input, "userId");
        await dependencies.updateConfig((latest) => {
          const group = latest.groups[groupId];
          if (!group) throw new Error("群不存在");
          if (userId === latest.ownerUser) throw new Error("不能移除 ThreadFerry Owner");
          group.allowUsers = group.allowUsers.filter((id) => id !== userId);
        });
        target = groupAnchor(groupId);
        message = "可使用用户已更新";
      } else if (url.pathname === "/groups/session/reset") {
        const groupId = required(input, "groupId");
        if (!dependencies.resetSession) throw new Error("当前启动方式不支持重置 Session");
        const removed = await dependencies.resetSession(groupId);
        target = groupAnchor(groupId);
        message = removed ? "该群 Runtime Session 已重置" : "该群当前没有已保存的 Runtime Session";
      } else {
        return send(response, 404, "Not found");
      }
      redirect(response, "ok", message, target);
    } catch (error) {
      redirect(response, "error", error instanceof Error ? error.message : "配置更新失败", target);
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
