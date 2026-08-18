import { isAbsolute, join } from "node:path";
import { runCommand } from "./process.js";
import type { CommandRunner } from "./types.js";

const LATEST_RELEASE_URL = "https://github.com/GnaixEuy/threadferry/releases/latest";
const RELEASE_PATH = "/GnaixEuy/threadferry/releases/tag/";
const VERSION = /^(\d+)\.(\d+)\.(\d+)$/;
const TAG = /^v\d+\.\d+\.\d+$/;

export interface UpdateRelease {
  version: string;
  packageUrl: string;
}

function version(value: string): [number, number, number] {
  const match = value.match(VERSION);
  if (!match) throw new Error(`版本号无效: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function newer(candidate: string, current: string): boolean {
  const next = version(candidate);
  const installed = version(current);
  for (let index = 0; index < next.length; index += 1) {
    if (next[index] !== installed[index]) return next[index]! > installed[index]!;
  }
  return false;
}

export async function findUpdate(currentVersion: string, fetcher: typeof fetch = fetch): Promise<UpdateRelease | undefined> {
  const response = await fetcher(LATEST_RELEASE_URL, {
    method: "HEAD",
    redirect: "manual",
    signal: AbortSignal.timeout(5_000),
  });
  const location = response.headers.get("location");
  if (![301, 302, 303, 307, 308].includes(response.status) || !location) {
    throw new Error(`无法获取 Latest Release（HTTP ${response.status}）`);
  }
  const release = new URL(location, LATEST_RELEASE_URL);
  const tag = decodeURIComponent(release.pathname.slice(RELEASE_PATH.length));
  if (release.origin !== "https://github.com" || !release.pathname.startsWith(RELEASE_PATH) || !TAG.test(tag)) {
    throw new Error("Latest Release 地址无效");
  }
  const releaseVersion = tag.slice(1);
  if (!newer(releaseVersion, currentVersion)) return undefined;
  return {
    version: releaseVersion,
    packageUrl: `https://github.com/GnaixEuy/threadferry/releases/download/${tag}/threadferry.tgz`,
  };
}

export async function installUpdate(update: UpdateRelease, runner: CommandRunner = runCommand): Promise<string> {
  const expectedUrl = `https://github.com/GnaixEuy/threadferry/releases/download/v${update.version}/threadferry.tgz`;
  if (update.packageUrl !== expectedUrl) throw new Error("更新包地址无效");
  await runner("npm", ["install", "--global", "--ignore-scripts", update.packageUrl], { timeoutMs: 300_000 });
  const prefix = (await runner("npm", ["prefix", "--global"], { timeoutMs: 10_000 })).stdout.trim();
  if (!isAbsolute(prefix)) throw new Error("npm 全局安装目录无效");
  const binary = join(prefix, "bin", "threadferry");
  const installedVersion = (await runner(binary, ["--version"], { timeoutMs: 10_000 })).stdout.trim();
  if (installedVersion !== update.version) {
    throw new Error(`更新失败：安装后版本为 ${installedVersion || "unknown"}，预期 ${update.version}`);
  }
  return binary;
}
