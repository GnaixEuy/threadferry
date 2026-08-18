import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const SENSITIVE = /(^|\/)(?:\.env(?:\..*)?|\.npmrc|\.git-credentials|id_rsa[^/]*|id_ed25519[^/]*|[^/]+\.(?:pem|key|p12))$/i;

export function allowedReadPath(rootInput: string, pathInput: string): boolean {
  if (pathInput === "~" || pathInput.startsWith("~/") || pathInput.startsWith("~\\")) return false;
  const root = realpathSync(rootInput);
  const candidate = resolve(root, pathInput);
  let actual = candidate;
  try {
    actual = realpathSync(candidate);
  } catch {
    // 不存在的路径交给只读工具报错；它无法创建文件。
  }
  const fromRoot = relative(root, actual);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) return false;
  return !SENSITIVE.test(fromRoot.split(sep).join("/"));
}

interface PiExtensionApi {
  on(event: "tool_call", handler: (event: { toolName: string; input: unknown }, context: { cwd: string }) => unknown): void;
}

export default function workspaceReadOnly(pi: PiExtensionApi): void {
  pi.on("tool_call", (event, context) => {
    if (event.toolName !== "read" && event.toolName !== "ls") {
      return { block: true, reason: "Warden V0.1 仅允许只读工具", terminate: true };
    }
    const input = event.input as { path?: unknown };
    const path = input?.path ?? ".";
    if (typeof path !== "string" || !allowedReadPath(context.cwd, path)) {
      return { block: true, reason: "Warden 禁止读取 Workspace 外或敏感文件", terminate: true };
    }
    return undefined;
  });
}
