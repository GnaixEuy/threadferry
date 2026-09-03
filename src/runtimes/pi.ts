import { createHash } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { prepareRuntimeResources } from "../attachments.js";
import { resolveWorkspace } from "../config.js";
import { runCommand } from "../process.js";
import { officialWecomSkillPaths } from "../wecom-skills.js";
import { nativeRuntimeEnvironment } from "./environment.js";
import { runtimeFailure, structuredRuntimeError } from "./runtime-error.js";
import type { CommandRunner, RuntimeRequest, RuntimeResult } from "../types.js";

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
  const args = [
    "--mode", "json", "--print",
    "--approve",
    ...officialWecomSkillPaths().flatMap((path) => ["--skill", path]),
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
        env: nativeRuntimeEnvironment(),
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
