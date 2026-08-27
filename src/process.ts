import spawn from "cross-spawn";
import type { CommandRunner } from "./types.js";

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

export class CommandExecutionError extends Error {
  constructor(
    command: string,
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(`${command} 执行失败（退出码 ${exitCode ?? "unknown"}）`);
  }
}

export class CommandTimeoutError extends Error {
  constructor(command: string) {
    super(`${command} 执行超时`);
    this.name = "CommandTimeoutError";
  }
}

export const runCommand: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      const error = new Error(`${command} 执行已取消`);
      error.name = "AbortError";
      reject(error);
      return;
    }
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let forceKill: NodeJS.Timeout | undefined;
    const terminate = () => {
      child.kill("SIGTERM");
      forceKill ??= setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs ?? 120_000);

    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        terminate();
        return;
      }
      target.push(chunk);
    };

    child.stdout!.on("data", collect(stdout));
    child.stderr!.on("data", collect(stderr));
    child.on("error", (error) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      if (!settled) {
        settled = true;
        reject(new Error(`无法启动 ${command}: ${error.message}`));
      }
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      options.signal?.removeEventListener("abort", abort);
      if (settled) return;
      settled = true;
      if (aborted) {
        const error = new Error(`${command} 执行已取消`);
        error.name = "AbortError";
        reject(error);
      } else if (timedOut) {
        reject(new CommandTimeoutError(command));
      } else if (outputBytes > MAX_OUTPUT_BYTES) {
        reject(new Error(`${command} 输出超过安全上限`));
      } else if (code !== 0) {
        reject(new CommandExecutionError(
          command,
          code,
          Buffer.concat(stdout).toString("utf8"),
          Buffer.concat(stderr).toString("utf8"),
        ));
      } else {
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
      }
    });

    child.stdin!.on("error", () => undefined);
    child.stdin!.end(options.input);
  });
