import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeResources } from "../attachments.js";
import { resolveWorkspace } from "../config.js";
import { runCommand } from "../process.js";
import { nativeRuntimeEnvironment } from "./environment.js";
import { runtimeFailure } from "./runtime-error.js";
import type { CommandRunner, RuntimeRequest, RuntimeResult } from "../types.js";

const MAX_PROMPT_JSON_BYTES = 700 * 1024;

export async function runGrok(
  request: Omit<RuntimeRequest, "agentId" | "runtime">,
  runner: CommandRunner = runCommand,
): Promise<RuntimeResult> {
  const workspace = await resolveWorkspace(request.workspace);
  const prepared = await prepareRuntimeResources(request.prompt, request.resources);
  const sessionId = request.sessionId ?? randomUUID();
  const content = await Promise.all(prepared.images.map(async (image) => ({
    type: "image",
    data: (await readFile(image.path)).toString("base64"),
    mimeType: image.contentType,
  })));
  const promptJson = content.length
    ? JSON.stringify([{ type: "text", text: prepared.prompt }, ...content])
    : undefined;
  if (promptJson && Buffer.byteLength(promptJson) > MAX_PROMPT_JSON_BYTES) {
    throw new Error("Grok：图片编码后超过命令行安全上限，请切换到 Codex、Pi 或 Claude Runtime");
  }
  let stdout: string;
  let promptRoot: string | undefined;
  try {
    let promptPath: string | undefined;
    if (!promptJson) {
      promptRoot = await mkdtemp(join(tmpdir(), "threadferry-grok-prompt-"));
      await chmod(promptRoot, 0o700);
      promptPath = join(promptRoot, "prompt.txt");
      await writeFile(promptPath, prepared.prompt, { encoding: "utf8", mode: 0o600 });
    }
    const args = [
      "--no-auto-update", "--cwd", workspace,
      "--output-format", "json",
      "--verbatim",
      ...(request.model ? ["--model", request.model] : []),
      ...(request.sessionId ? ["--resume", request.sessionId] : ["--session-id", sessionId]),
      ...(promptJson ? ["--prompt-json", promptJson] : ["--prompt-file", promptPath!]),
    ];
    ({ stdout } = await runner("grok", args, {
      cwd: workspace,
      env: nativeRuntimeEnvironment(),
      timeoutMs: 10 * 60_000,
      signal: request.signal,
    }));
  } catch (error) {
    throw runtimeFailure("Grok", error);
  } finally {
    if (promptRoot) await rm(promptRoot, { recursive: true, force: true });
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
