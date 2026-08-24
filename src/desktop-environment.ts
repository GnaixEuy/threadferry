import { execFile } from "node:child_process";
import { isAbsolute } from "node:path";

type PathResolver = (environment: Record<string, string>, fallbackShell: string) => Promise<string | undefined>;

const PATH_MARKER = "__THREADFERRY_PATH__";

async function loginShellPath(environment: Record<string, string>, fallbackShell: string): Promise<string | undefined> {
  const shell = environment.SHELL && isAbsolute(environment.SHELL) ? environment.SHELL : fallbackShell;
  return new Promise((resolve) => {
    execFile(shell, ["-lc", `printf '\n${PATH_MARKER}%s' "$PATH"`], {
      env: environment,
      timeout: 5_000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error) return resolve(undefined);
      const marker = stdout.lastIndexOf(PATH_MARKER);
      const path = marker === -1 ? "" : stdout.slice(marker + PATH_MARKER.length).trim();
      resolve(path || undefined);
    });
  });
}

export async function desktopEnvironment(
  platform: NodeJS.Platform = process.platform,
  base: NodeJS.ProcessEnv = process.env,
  resolvePath: PathResolver = loginShellPath,
): Promise<Record<string, string>> {
  const environment = Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  if (platform === "darwin" || platform === "linux") {
    const path = await resolvePath(environment, platform === "darwin" ? "/bin/zsh" : "/bin/sh");
    if (path) environment.PATH = path;
  }
  environment.THREADFERRY_DESKTOP = "1";
  return environment;
}
