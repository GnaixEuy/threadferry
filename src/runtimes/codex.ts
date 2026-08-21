import { resolveWorkspace } from "../config.js";
import { prepareRuntimeResources } from "../attachments.js";
import { CommandExecutionError, runCommand } from "../process.js";
import { runtimeFailure, structuredRuntimeError } from "./runtime-error.js";
import type { CommandRunner, RuntimeRequest, RuntimeResult } from "../types.js";

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "CODEX_HOME", "TMPDIR", "LANG", "LC_ALL",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
    "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

function messageText(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const value = item as Record<string, unknown>;
  if (value.type !== "agent_message") return undefined;
  if (typeof value.text === "string") return value.text;
  if (!Array.isArray(value.content)) return undefined;
  return value.content
    .flatMap((part) => part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
      ? [(part as { text: string }).text]
      : [])
    .join("");
}

export async function runCodex(
  request: Omit<RuntimeRequest, "agentId" | "runtime">,
  runner: CommandRunner = runCommand,
): Promise<RuntimeResult> {
  const workspace = await resolveWorkspace(request.workspace);
  const prepared = await prepareRuntimeResources(request.prompt, request.resources);
  const profile = "threadferry-read-only";
  const filesystemPolicy = `{":minimal"="read",glob_scan_max_depth=8,":workspace_roots"={"."="read",".env"="deny",".env.*"="deny","**/.env"="deny","**/.env.*"="deny",".npmrc"="deny","**/.npmrc"="deny",".git-credentials"="deny","**/.git-credentials"="deny","*.pem"="deny","**/*.pem"="deny","*.key"="deny","**/*.key"="deny","*.p12"="deny","**/*.p12"="deny","id_rsa*"="deny","**/id_rsa*"="deny","id_ed25519*"="deny","**/id_ed25519*"="deny"}}`;
  const baseArgs = [
    "-a", "never",
    "-C", workspace,
    "--strict-config",
    "-c", `default_permissions=${JSON.stringify(profile)}`,
    "-c", `permissions.${profile}.description="ThreadFerry workspace-only read access"`,
    "-c", `permissions.${profile}.filesystem=${filesystemPolicy}`,
    "-c", `permissions.${profile}.network.enabled=false`,
    "-c", `projects.${JSON.stringify(workspace)}.trust_level="untrusted"`,
    "-c", "shell_environment_policy.inherit=none",
    "--disable", "plugins",
    "--disable", "apps",
    "--disable", "browser_use",
    "--disable", "computer_use",
    "--disable", "image_generation",
    ...(request.model ? ["--model", request.model] : []),
    "exec",
    "--json",
    "--ignore-user-config",
    "--ignore-rules",
    "--skip-git-repo-check",
  ];

  const images = prepared.images.flatMap((resource) => ["--image", resource.path]);
  const execute = (sessionId?: string) => runner("codex", [
    ...baseArgs,
    ...(sessionId ? ["resume", ...images, sessionId, "-"] : [...images, "-"]),
  ], {
    cwd: workspace,
    env: safeEnvironment(),
    input: prepared.prompt,
    timeoutMs: 10 * 60_000,
    signal: request.signal,
  });

  let stdout: string;
  let resumedSessionId = request.sessionId;
  try {
    ({ stdout } = await execute(request.sessionId));
  } catch (error) {
    const detail = error instanceof CommandExecutionError ? error.stderr : error instanceof Error ? error.message : "";
    const invalidSession = /(?:session|thread|rollout).{0,40}(?:not found|does not exist|invalid)|no (?:saved )?(?:session|thread|rollout)|failed to (?:load|resume)/i.test(detail);
    if (!request.sessionId || request.signal?.aborted || !invalidSession) throw runtimeFailure("Codex", error);
    resumedSessionId = undefined;
    try {
      ({ stdout } = await execute());
    } catch (retryError) {
      throw runtimeFailure("Codex", retryError);
    }
  }

  let finalMessage: string | undefined;
  let sessionId: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "thread.started" && typeof event.thread_id === "string") sessionId = event.thread_id;
    const text = messageText(event.item);
    if (text) finalMessage = text;
  }
  if (!finalMessage) {
    const reported = structuredRuntimeError(stdout);
    throw new Error(reported ? `Codex：${reported}` : "Codex 未返回可解析的最终消息");
  }
  return { text: finalMessage, ...(sessionId ? { sessionId } : resumedSessionId ? { sessionId: resumedSessionId } : {}) };
}
