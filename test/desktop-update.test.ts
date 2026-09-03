import assert from "node:assert/strict";
import test from "node:test";
import type { AppUpdater } from "electron-updater";
import { installDesktopUpdate, type DesktopUpdateStatus } from "../src/desktop-update.js";

test("desktop update downloads before draining work, then installs and restarts", async () => {
  const calls: string[] = [];
  const statuses: DesktopUpdateStatus[] = [];
  const updater = {
    isUpdaterActive: () => true,
    checkForUpdates: async () => {
      calls.push("check");
      return { isUpdateAvailable: true, updateInfo: { version: "0.30.1" } };
    },
    downloadUpdate: async () => { calls.push("download"); return ["update.zip"]; },
    quitAndInstall: (silent?: boolean, forceRunAfter?: boolean) => { calls.push(`install:${silent}:${forceRunAfter}`); },
  } as unknown as Pick<AppUpdater, "isUpdaterActive" | "checkForUpdates" | "downloadUpdate" | "quitAndInstall">;

  assert.deepEqual(await installDesktopUpdate(
    updater,
    "0.30.0",
    async () => { calls.push("drain"); },
    (status) => statuses.push(status),
  ), { status: "installing", version: "0.30.1" });
  assert.deepEqual(calls, ["check", "download", "drain", "install:true:true"]);
  assert.deepEqual(statuses.map(({ phase }) => phase), ["checking", "downloading", "waiting", "installing"]);
});
