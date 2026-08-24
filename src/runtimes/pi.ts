import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareRuntimeResources } from "../attachments.js";
import { resolveWorkspace } from "../config.js";
import { runCommand } from "../process.js";
import { officialWecomSkillPaths } from "../wecom-skills.js";
import { runtimeFailure, structuredRuntimeError } from "./runtime-error.js";
import type { CommandRunner, RuntimeRequest, RuntimeResult } from "../types.js";

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "PI_CODING_AGENT_DIR",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
    "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY",
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

function assistantText(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || (message as { role?: unknown }).role !== "assistant") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  const text = content.flatMap((part) => part && typeof part === "object" && (part as { type?: unknown }).type === "text"
    && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []).join("");
  return text || undefined;
}

function retryableConnectionError(message: string | undefined): boolean {
  return !!message && /connection error|fetch failed|econnreset|econnrefused|etimedout|enetunreach|network error/i.test(message);
}

export async function runPi(
  request: Omit<RuntimeRequest, "runtime">,
  runner: CommandRunner = runCommand,
  sessionRootInput = join(homedir(), ".threadferry", "pi-sessions"),
): Promise<RuntimeResult> {
  const workspace = await resolveWorkspace(request.workspace);
  const prepared = await prepareRuntimeResources(request.prompt, request.resources);
  const sessionRoot = resolve(sessionRootInput);
  await mkdir(sessionRoot, { recursive: true, mode: 0o700 });
  if ((await lstat(sessionRoot)).isSymbolicLink()) throw new Error("Pi Session 目录不能是符号链接");
  const sessionDir = join(sessionRoot, createHash("sha256").update(request.agentId).digest("hex"));
  await mkdir(sessionDir, { recursive: true, mode: 0o700 });
  if ((await lstat(sessionDir)).isSymbolicLink()) throw new Error("Pi Agent Session 目录不能是符号链接");
  const extension = fileURLToPath(new URL("./pi-readonly-extension.js", import.meta.url));
  const args = [
    "--mode", "json", "--print",
    "--tools", "read,ls",
    "--no-extensions", "--extension", extension,
    "--no-skills", ...officialWecomSkillPaths().flatMap((path) => ["--skill", path]),
    "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-approve",
    "--session-dir", sessionDir,
    ...(request.model ? ["--model", request.model] : []),
    ...(request.sessionId ? ["--session-id", request.sessionId] : []),
    ...prepared.images.map((resource) => `@${resource.path}`),
  ];
  let retried = false;
  while (true) {
    let stdout: string;
    try {
      ({ stdout } = await runner("pi", args, {
        cwd: workspace,
        env: safeEnvironment(),
        input: prepared.prompt,
        timeoutMs: 10 * 60_000,
        signal: request.signal,
      }));
    } catch (error) {
      const failure = runtimeFailure("Pi", error);
      if (!retried && request.sessionId && retryableConnectionError(failure.message)) {
        retried = true;
        continue;
      }
      throw failure;
    }

    let sessionId = request.sessionId;
    let finalMessage: string | undefined;
    for (const line of stdout.split("\n")) {
      if (!line.trim()) continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (event.type === "session" && typeof event.id === "string") sessionId = event.id;
      if (event.type === "message_end") finalMessage = assistantText(event.message) ?? finalMessage;
    }
    if (finalMessage) return { text: finalMessage, ...(sessionId ? { sessionId } : {}) };

    const reported = structuredRuntimeError(stdout);
    if (!retried && request.sessionId && retryableConnectionError(reported)) {
      retried = true;
      continue;
    }
    throw new Error(reported ? `Pi：${reported}` : "Pi 未返回可解析的最终消息");
  }
}
