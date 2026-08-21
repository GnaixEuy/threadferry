import { CommandExecutionError } from "../process.js";

// Runtime CLI 失败时，真正可操作的信息在 stdout 的结构化事件里，而不是退出码。
// 例如 Codex 配额耗尽会打印：
//   {"type":"error","message":"You've hit your usage limit. ... try again at ..."}
//   {"type":"turn.failed","error":{"message":"..."}}
// 而 CommandExecutionError.message 只有「codex 执行失败（退出码 1）」。
// 只读 stdout/stderr 里 CLI 自己产生的错误文本，不回显我们发出去的 prompt。
const MAX_REASON = 400;

function messageOf(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.message === "string") return record.message;
  if (typeof record.error === "string") return record.error;
  if (typeof record.result === "string") return record.result;
  if (record.error && typeof record.error === "object") {
    const nested = (record.error as Record<string, unknown>).message;
    if (typeof nested === "string") return nested;
  }
  return undefined;
}

/** 从 Runtime CLI 的 NDJSON 输出里取最后一条错误说明。 */
export function structuredRuntimeError(stdout: string): string | undefined {
  let found: string | undefined;
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    const record = event as Record<string, unknown>;
    const type = record.type;
    if (type !== "error" && type !== "turn.failed" && record.is_error !== true) continue;
    const message = messageOf(event) ?? messageOf(record.item);
    if (message?.trim()) found = message.trim();
  }
  return found;
}

/**
 * 把 Runtime CLI 的失败包装成带可操作说明的错误。
 * 优先用 stdout 里的结构化错误，其次 stderr 首行，最后退回退出码。
 */
export function runtimeFailure(command: string, error: unknown): Error {
  if (!(error instanceof CommandExecutionError)) return error instanceof Error ? error : new Error(String(error));
  const structured = structuredRuntimeError(error.stdout);
  const stderrLine = error.stderr.split("\n").map((line) => line.trim()).filter(Boolean).at(-1);
  const detail = structured ?? stderrLine;
  if (!detail) return error;
  const trimmed = detail.length > MAX_REASON ? `${detail.slice(0, MAX_REASON)}…` : detail;
  const wrapped = new Error(`${command}：${trimmed}`);
  wrapped.cause = error;
  return wrapped;
}
