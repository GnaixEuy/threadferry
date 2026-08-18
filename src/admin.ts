import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { addAgent, resolveWorkspace } from "./config.js";
import { resolveDirectoryUser } from "./directory.js";
import type { DirectoryUser, RuntimeName, WardenConfig } from "./types.js";

export type ConfigUpdater = (change: (latest: WardenConfig) => void | Promise<void>) => Promise<void>;

export interface AdminDependencies {
  updateConfig: ConfigUpdater;
  listGroups: () => Promise<Array<{ id: string; name?: string }>>;
  searchUsers: (keywords: string[]) => Promise<DirectoryUser[]>;
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

function redirect(response: ServerResponse, kind: "ok" | "error", message: string): void {
  securityHeaders(response);
  response.statusCode = 303;
  response.setHeader("Location", `/?${kind}=${encodeURIComponent(message)}`);
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

function agentOptions(config: WardenConfig, selected?: string): string {
  return Object.keys(config.agents).map((id) => `<option value="${html(id)}"${id === selected ? " selected" : ""}>${html(id)}</option>`).join("");
}

async function page(config: WardenConfig, dependencies: AdminDependencies, token: string, url: URL): Promise<string> {
  let sessions: Array<{ id: string; name?: string }> = [];
  try {
    sessions = await dependencies.listGroups();
  } catch {
    // 企业微信查询失败时，配置中的群仍可管理。
  }
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
  const byId = new Map(sessions.map((group) => [group.id, group]));
  const groupIds = [...new Set([...sessions.map((group) => group.id), ...Object.keys(config.groups)])];
  const field = `<input type="hidden" name="csrf" value="${token}">`;
  const agents = Object.entries(config.agents).map(([id, agent]) => `
    <article class="card">
      <div class="row"><h3>${html(id)}</h3><span class="badge">${html(agent.runtime)}</span></div>
      <p>${html(agent.model ?? "默认模型")}</p><code>${html(agent.workspace)}</code>
    </article>`).join("");
  const groups = groupIds.map((id) => {
    const group = config.groups[id];
    const label = byId.get(id)?.name ?? "未获取群名";
    if (!group) return `
      <article class="card muted">
        <div class="row"><div><h3>${html(label)}</h3><code>${html(id)}</code></div><span class="badge warning">未绑定</span></div>
        <form method="post" action="/groups/bind">${field}<input type="hidden" name="groupId" value="${html(id)}">
          <select name="agentId" aria-label="Agent">${agentOptions(config)}</select><button>绑定 Agent</button>
        </form>
      </article>`;
    const users = group.allowUsers.map((userId) => `
      <li><span>${userNames.get(userId) ? `${html(userNames.get(userId))} ` : ""}<code>${html(userId)}</code>${userId === config.ownerUser ? "<span class=owner>Owner</span>" : ""}</span>${userId === config.ownerUser ? "" : `
        <form method="post" action="/groups/users/remove">${field}<input type="hidden" name="groupId" value="${html(id)}"><input type="hidden" name="userId" value="${html(userId)}"><button class="danger">移除</button></form>`}</li>`).join("");
    return `
      <article class="card group">
        <div class="row"><div><h3>${html(label)}</h3><code>${html(id)}</code></div><span class="badge ok">已配置</span></div>
        <form method="post" action="/groups/agent">${field}<input type="hidden" name="groupId" value="${html(id)}">
          <label>当前 Agent <select name="agentId">${agentOptions(config, group.agent)}</select></label><button>切换</button>
        </form>
        <h4>可使用用户</h4><ul>${users}</ul>
        <form method="post" action="/groups/users/add">${field}<input type="hidden" name="groupId" value="${html(id)}">
          <input name="user" aria-label="用户姓名、别名或 userid" placeholder="姓名、别名或 id:userid" maxlength="512" required><button>添加用户</button>
        </form>
      </article>`;
  }).join("");
  const notice = url.searchParams.get("ok");
  const error = url.searchParams.get("error");
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Warden 管理台</title><style>
  :root{color-scheme:dark;font:15px/1.5 ui-sans-serif,system-ui,-apple-system;color:#e7e9ee;background:#0c0e13}*{box-sizing:border-box}body{margin:0}main{width:min(1080px,calc(100% - 32px));margin:40px auto 80px}header{display:flex;justify-content:space-between;align-items:end;margin-bottom:28px}h1{font-size:34px;margin:0}h2{margin:34px 0 14px}h3,h4,p{margin:0 0 10px}.sub,.muted{color:#9ca3af}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}.card{background:#151821;border:1px solid #272b36;border-radius:14px;padding:18px}.card.group{grid-column:span 1}.row{display:flex;justify-content:space-between;gap:16px;align-items:start}.badge,.owner{font-size:12px;border-radius:999px;padding:3px 9px;background:#2b3140}.badge.ok{color:#7ee787}.badge.warning{color:#f2cc60}.owner{color:#8cb4ff;margin-left:8px}code{font-family:ui-monospace,SFMono-Regular,Menlo;overflow-wrap:anywhere;color:#b8c2d9}form{display:flex;gap:8px;align-items:end;margin-top:14px;flex-wrap:wrap}label{color:#9ca3af}input,select,button{font:inherit;border-radius:9px;border:1px solid #343a49;background:#0f1218;color:#eef1f6;padding:9px 11px}input{min-width:190px;flex:1}button{cursor:pointer;background:#2f67d8;border-color:#3975eb;font-weight:650}button.danger{background:transparent;border-color:#7f3340;color:#ff9aa7;padding:4px 8px}ul{list-style:none;padding:0;margin:8px 0}li{display:flex;align-items:center;justify-content:space-between;border-top:1px solid #272b36;padding:9px 0}li form{margin:0}.notice{padding:11px 14px;border-radius:10px;margin:0 0 16px;background:#143321;color:#8de6a9}.notice.error{background:#3b171d;color:#ffabb4}.agent-form{display:grid;grid-template-columns:1fr 140px 1.6fr 1fr auto;align-items:end}.agent-form label{display:flex;flex-direction:column;gap:5px}.agent-form input{min-width:0;width:100%}@media(max-width:760px){header{align-items:start;flex-direction:column}.agent-form{display:flex}.card.group{grid-column:auto}}
  </style></head><body><main><header><div><h1>Warden</h1><div class="sub">本机管理台 · 仅监听 127.0.0.1</div></div><code>Owner: ${html(config.ownerUser)}</code></header>
  ${notice ? `<div class="notice">${html(notice)}</div>` : ""}${error ? `<div class="notice error">${html(error)}</div>` : ""}
  <h2>Agents</h2><div class="grid">${agents}</div>
  <article class="card"><h3>添加 Agent</h3><form class="agent-form" method="post" action="/agents/add">${field}
    <label>名称<input name="agentId" pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,63}" required></label>
    <label>Runtime<select name="runtime"><option value="codex">Codex</option><option value="pi">Pi</option></select></label>
    <label>Workspace<input name="workspace" placeholder="/absolute/path" required></label>
    <label>模型（可选）<input name="model" placeholder="provider/model"></label><button>添加</button></form></article>
  <h2>企业微信群</h2><div class="grid">${groups || "<p class=sub>暂无群会话</p>"}</div>
  </main></body></html>`;
}

export async function startAdminServer(
  config: WardenConfig,
  dependencies: AdminDependencies,
  port = 17_638,
): Promise<{ url: string; close: () => Promise<void> }> {
  const token = randomBytes(32).toString("hex");
  const server = createServer(async (request, response) => {
    if (!localHost(request.headers.host)) return send(response, 403, "Forbidden");
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (request.method === "GET" && url.pathname === "/") {
      try {
        return send(response, 200, await page(config, dependencies, token, url));
      } catch {
        return send(response, 500, "Warden 管理台暂时无法读取配置");
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
      } else if (url.pathname === "/groups/bind") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        if (!GROUP_ID.test(groupId)) throw new Error("群 ID 无效");
        if (!(await dependencies.listGroups()).some((group) => group.id === groupId)) throw new Error("机器人当前不可见该群");
        await dependencies.updateConfig((latest) => {
          if (latest.groups[groupId]) throw new Error("该群已经配置");
          if (!latest.agents[agentId]) throw new Error("Agent 不存在");
          latest.groups[groupId] = { agent: agentId, allowUsers: [latest.ownerUser], context: { lookbackHours: 6, maxMessages: 80 } };
        });
      } else if (url.pathname === "/groups/agent") {
        const groupId = required(input, "groupId");
        const agentId = required(input, "agentId");
        await dependencies.updateConfig((latest) => {
          if (!latest.groups[groupId] || !latest.agents[agentId]) throw new Error("群或 Agent 不存在");
          latest.groups[groupId].agent = agentId;
        });
      } else if (url.pathname === "/groups/users/add") {
        const groupId = required(input, "groupId");
        const user = await resolveDirectoryUser(required(input, "user"), dependencies.searchUsers);
        if (!USER_ID.test(user.id)) throw new Error("通讯录返回的 userid 无效");
        await dependencies.updateConfig((latest) => {
          const group = latest.groups[groupId];
          if (!group) throw new Error("群不存在");
          group.allowUsers = [...new Set([...group.allowUsers, user.id])];
          if (group.allowUsers.length > 256) throw new Error("可使用用户已达到 256 人上限");
        });
      } else if (url.pathname === "/groups/users/remove") {
        const groupId = required(input, "groupId");
        const userId = required(input, "userId");
        await dependencies.updateConfig((latest) => {
          const group = latest.groups[groupId];
          if (!group) throw new Error("群不存在");
          if (userId === latest.ownerUser) throw new Error("不能移除 Warden Owner");
          group.allowUsers = group.allowUsers.filter((id) => id !== userId);
        });
      } else {
        return send(response, 404, "Not found");
      }
      redirect(response, "ok", "配置已更新并立即生效");
    } catch (error) {
      redirect(response, "error", error instanceof Error ? error.message : "配置更新失败");
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
