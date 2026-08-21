import { randomUUID } from "node:crypto";
import { resolveWorkspace } from "../config.js";
import { runCommand } from "../process.js";
import { runtimeFailure } from "./runtime-error.js";
import type { CommandRunner, RuntimeRequest, RuntimeResult } from "../types.js";

const DENIED_TOOLS = [
  "Bash", "Edit", "Write", "MCPTool", "WebFetch", "WebSearch",
  "Read(.env)", "Read(.env.*)", "Read(**/.env)", "Read(**/.env.*)",
  "Read(.npmrc)", "Read(**/.npmrc)", "Read(.git-credentials)", "Read(**/.git-credentials)",
  "Read(*.pem)", "Read(**/*.pem)", "Read(*.key)", "Read(**/*.key)",
  "Read(*.p12)", "Read(**/*.p12)", "Read(id_rsa*)", "Read(**/id_rsa*)",
  "Read(id_ed25519*)", "Read(**/id_ed25519*)",
];

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "GROK_HOME",
    "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "XAI_API_KEY",
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

export async function runGrok(
  request: Omit<RuntimeRequest, "agentId" | "runtime">,
  runner: CommandRunner = runCommand,
): Promise<RuntimeResult> {
  const workspace = await resolveWorkspace(request.workspace);
  const sessionId = request.sessionId ?? randomUUID();
  const args = [
    "--no-auto-update", "--cwd", workspace,
    "--output-format", "json",
    "--permission-mode", "dontAsk", "--sandbox", "strict",
    "--tools", "Read,Grep", "--disable-web-search", "--no-subagents", "--no-memory",
    ...DENIED_TOOLS.flatMap((rule) => ["--deny", rule]),
    "--system-prompt-override", "Analyze the workspace read-only. Never modify files, run commands, use network tools, plugins, MCP servers, hooks, or reveal secrets.",
    "--verbatim",
    ...(request.model ? ["--model", request.model] : []),
    ...(request.sessionId ? ["--resume", request.sessionId] : ["--session-id", sessionId]),
    "--prompt-file", "/dev/stdin",
  ];
  let stdout: string;
  try {
    ({ stdout } = await runner("grok", args, {
      cwd: workspace,
      env: safeEnvironment(),
      input: request.prompt,
      timeoutMs: 10 * 60_000,
      signal: request.signal,
    }));
  } catch (error) {
    throw runtimeFailure("Grok", error);
  }

  let output: Record<string, unknown>;
  try {
    output = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("Grok 未返回可解析的 JSON");
  }
  if (typeof output.text !== "string" || !output.text.trim()) {
    const detail = output.error && typeof output.error === "object" && typeof (output.error as { message?: unknown }).message === "string"
      ? (output.error as { message: string }).message
      : "未返回最终消息";
    throw new Error(`Grok：${detail}`);
  }
  return {
    text: output.text,
    sessionId: typeof output.sessionId === "string" ? output.sessionId : sessionId,
  };
}
