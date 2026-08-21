import { randomUUID } from "node:crypto";
import { resolveWorkspace } from "../config.js";
import { runCommand } from "../process.js";
import { runtimeFailure } from "./runtime-error.js";
import type { CommandRunner, RuntimeRequest, RuntimeResult } from "../types.js";

const SETTINGS = JSON.stringify({
  permissions: {
    allow: ["Read", "Glob", "Grep"],
    deny: [
      "Bash", "Edit", "Write", "WebFetch", "WebSearch", "mcp__*",
      "Read(./.env)", "Read(./.env.*)", "Read(./**/.env)", "Read(./**/.env.*)",
      "Read(./.npmrc)", "Read(./**/.npmrc)", "Read(./.git-credentials)", "Read(./**/.git-credentials)",
      "Read(./*.pem)", "Read(./**/*.pem)", "Read(./*.key)", "Read(./**/*.key)",
      "Read(./*.p12)", "Read(./**/*.p12)", "Read(./id_rsa*)", "Read(./**/id_rsa*)",
      "Read(./id_ed25519*)", "Read(./**/id_ed25519*)",
    ],
    defaultMode: "dontAsk",
    disableBypassPermissionsMode: "disable",
  },
});

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL",
    "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

export async function runClaude(
  request: Omit<RuntimeRequest, "agentId" | "runtime">,
  runner: CommandRunner = runCommand,
): Promise<RuntimeResult> {
  const workspace = await resolveWorkspace(request.workspace);
  const sessionId = request.sessionId ?? randomUUID();
  const args = [
    "-p", "--output-format", "json",
    "--permission-mode", "dontAsk",
    "--safe-mode", "--disable-slash-commands", "--no-chrome",
    "--allowedTools", "Read,Glob,Grep",
    "--disallowedTools", "Bash,Edit,Write,WebFetch,WebSearch,mcp__*",
    "--settings", SETTINGS,
    ...(request.model ? ["--model", request.model] : []),
    ...(request.sessionId ? ["--resume", request.sessionId] : ["--session-id", sessionId]),
  ];
  let stdout: string;
  try {
    ({ stdout } = await runner("claude", args, {
      cwd: workspace,
      env: safeEnvironment(),
      input: request.prompt,
      timeoutMs: 10 * 60_000,
      signal: request.signal,
    }));
  } catch (error) {
    throw runtimeFailure("Claude", error);
  }

  let output: Record<string, unknown>;
  try {
    output = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new Error("Claude 未返回可解析的 JSON");
  }
  if (output.is_error === true || typeof output.result !== "string" || !output.result.trim()) {
    throw new Error(`Claude：${typeof output.result === "string" && output.result.trim() ? output.result.trim() : "未返回最终消息"}`);
  }
  return {
    text: output.result,
    sessionId: typeof output.session_id === "string" ? output.session_id : sessionId,
  };
}
