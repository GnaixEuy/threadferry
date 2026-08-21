import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareRuntimeResources } from "../attachments.js";
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

const MAX_PROMPT_JSON_BYTES = 700 * 1024;

function safeEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "GROK_HOME",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
    "SystemRoot", "WINDIR", "ComSpec", "PATHEXT",
    "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "XAI_API_KEY",
  ];
  return Object.fromEntries(allowed.flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
}

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
      "--permission-mode", "dontAsk", "--sandbox", "strict",
      "--tools", "Read,Grep", "--disable-web-search", "--no-subagents", "--no-memory",
      ...DENIED_TOOLS.flatMap((rule) => ["--deny", rule]),
      "--system-prompt-override", "Analyze the workspace read-only. Never modify files, run commands, use network tools, plugins, MCP servers, hooks, or reveal secrets.",
      "--verbatim",
      ...(request.model ? ["--model", request.model] : []),
      ...(request.sessionId ? ["--resume", request.sessionId] : ["--session-id", sessionId]),
      ...(promptJson ? ["--prompt-json", promptJson] : ["--prompt-file", promptPath!]),
    ];
    ({ stdout } = await runner("grok", args, {
      cwd: workspace,
      env: safeEnvironment(),
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
