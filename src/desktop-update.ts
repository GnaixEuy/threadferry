import type { AppUpdater } from "electron-updater";

export type DesktopUpdateStatus = {
  phase: "checking" | "current" | "downloading" | "waiting" | "installing" | "error";
  version?: string;
  percent?: number;
  message?: string;
};

type Updater = Pick<AppUpdater, "isUpdaterActive" | "checkForUpdates" | "downloadUpdate" | "quitAndInstall">;

export async function installDesktopUpdate(
  updater: Updater,
  currentVersion: string,
  prepareRestart: () => Promise<void>,
  report: (status: DesktopUpdateStatus) => void,
): Promise<{ status: "current" | "installing"; version: string }> {
  if (!updater.isUpdaterActive()) throw new Error("当前安装方式不支持应用内自动更新");
  report({ phase: "checking" });
  const result = await updater.checkForUpdates();
  if (!result) throw new Error("自动更新服务当前不可用");
  if (!result.isUpdateAvailable) {
    report({ phase: "current", version: currentVersion });
    return { status: "current", version: currentVersion };
  }
  const version = result.updateInfo.version;
  report({ phase: "downloading", version, percent: 0 });
  await updater.downloadUpdate();
  report({ phase: "waiting", version });
  await prepareRestart();
  report({ phase: "installing", version });
  updater.quitAndInstall(true, true);
  return { status: "installing", version };
}
