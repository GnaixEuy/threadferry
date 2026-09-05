import { createWriteStream, type WriteStream } from "node:fs";
import { mkdir, stat, truncate } from "node:fs/promises";
import { join } from "node:path";
import {
  BrowserWindow,
  Menu,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  shell,
  utilityProcess,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type NativeImage,
  type UtilityProcess,
} from "electron";
import { autoUpdater } from "electron-updater";
import { desktopEnvironment } from "./desktop-environment.js";
import {
  DEFAULT_DESKTOP_PREFERENCES,
  readDesktopPreferences,
  writeDesktopPreferences,
  type DesktopPreferences,
} from "./desktop-preferences.js";
import { installDesktopUpdate, type DesktopUpdateStatus } from "./desktop-update.js";

const ADMIN_URL = "http://127.0.0.1:17638";
const ISSUE_URL = "https://github.com/GnaixEuy/threadferry/issues/new";
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_RECENT_OUTPUT = 8_000;
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1_000;

type ServicePhase = "stopped" | "starting" | "running" | "stopping" | "error";
interface ServiceState {
  phase: ServicePhase;
  owned: boolean;
  url?: string;
  detail?: string;
}

let tray: Tray | undefined;
let trayMenu: Menu | undefined;
let managementWindow: BrowserWindow | undefined;
let service: UtilityProcess | undefined;
let serviceState: ServiceState = { phase: "stopped", owned: false };
let serviceGeneration = 0;
let recentOutput = "";
let logPath = "";
let log: WriteStream | undefined;
let pendingManagementPath: string | undefined;
let quitting = false;
let preferencesPath = "";
let desktopPreferences = { ...DEFAULT_DESKTOP_PREFERENCES };
let updateStatus: DesktopUpdateStatus = { phase: "current", version: app.getVersion() };
let updateOperation: Promise<{ status: "current" | "installing"; version: string }> | undefined;
let updatePreparingRestart = false;

function appendOutput(chunk: Uint8Array | string): void {
  const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
  recentOutput = (recentOutput + text).slice(-MAX_RECENT_OUTPUT);
  log?.write(text);
}

async function prepareLog(): Promise<void> {
  app.setAppLogsPath();
  const directory = app.getPath("logs");
  await mkdir(directory, { recursive: true });
  logPath = join(directory, "threadferry-host.log");
  try {
    if ((await stat(logPath)).size > MAX_LOG_BYTES) await truncate(logPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  log = createWriteStream(logPath, { flags: "a" });
}

function serviceLabel(): string {
  switch (serviceState.phase) {
    case "starting": return "状态：正在启动…";
    case "running": return serviceState.owned ? "状态：正在运行" : "状态：已由其他进程启动";
    case "stopping": return "状态：正在停止…";
    case "error": return "状态：启动失败";
    case "stopped": return "状态：已停止";
  }
}

function rebuildTrayMenu(): void {
  if (!tray) return;
  const running = serviceState.phase === "running";
  const owned = running && serviceState.owned;
  const showStopService = serviceState.phase === "starting" || running || serviceState.phase === "stopping";
  const canStopService = serviceState.owned && serviceState.phase !== "stopping";
  const template: MenuItemConstructorOptions[] = [
    { label: serviceLabel(), enabled: false },
    { type: "separator" },
    { label: "打开管理台", enabled: running, click: () => void showManagement() },
    { label: "偏好设置…", click: () => { if (serviceState.phase !== "stopping") void showManagement("/settings"); } },
    {
      label: showStopService ? "停止服务" : "启动服务",
      enabled: showStopService ? canStopService : serviceState.phase === "stopped" || serviceState.phase === "error",
      click: () => void (showStopService ? stopService() : startService()),
    },
    { label: "重新启动服务", enabled: owned, click: () => void restartService() },
    ...(serviceState.phase === "error" ? [
      { type: "separator" as const },
      { label: "查看启动问题…", click: () => void showProblem() },
    ] : []),
    { type: "separator" },
    { label: "显示服务日志", enabled: Boolean(logPath), click: () => logPath && shell.showItemInFolder(logPath) },
    { label: "退出 ThreadFerry", click: () => app.quit() },
  ];
  trayMenu = Menu.buildFromTemplate(template);
  tray.setContextMenu(trayMenu);
  tray.setToolTip(`ThreadFerry · ${serviceLabel().replace("状态：", "")}`);
}

function setServiceState(next: ServiceState): void {
  serviceState = next;
  rebuildTrayMenu();
  if (next.phase === "running" && pendingManagementPath) {
    const path = pendingManagementPath;
    pendingManagementPath = undefined;
    openManagementWindow(new URL(path, next.url).toString());
  }
}

function readyUrl(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = message as { type?: unknown; url?: unknown };
  if (value.type !== "threadferry:ready" || typeof value.url !== "string") return undefined;
  try {
    return new URL(value.url).origin === ADMIN_URL ? value.url : undefined;
  } catch {
    return undefined;
  }
}

async function existingAdmin(): Promise<boolean> {
  try {
    const response = await fetch(ADMIN_URL, { signal: AbortSignal.timeout(1_000) });
    return response.ok && (await response.text()).includes("<title>ThreadFerry 管理台</title>");
  } catch {
    return false;
  }
}

async function startService(): Promise<void> {
  if (serviceState.phase === "starting" || serviceState.phase === "running") return;
  const generation = ++serviceGeneration;
  recentOutput = "";
  setServiceState({ phase: "starting", owned: true });
  try {
    if (await existingAdmin()) {
      if (generation === serviceGeneration) setServiceState({ phase: "running", owned: false, url: ADMIN_URL });
      return;
    }
    const environment = await desktopEnvironment();
    if (generation !== serviceGeneration) return;
    const child = utilityProcess.fork(join(app.getAppPath(), "dist", "src", "cli.js"), ["start"], {
      env: environment,
      serviceName: "ThreadFerry Host",
      stdio: "pipe",
    });
    service = child;
    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("message", (message) => {
      const url = readyUrl(message);
      if (service === child && url) setServiceState({ phase: "running", owned: true, url });
    });
    child.on("exit", (code) => {
      if (service !== child) return;
      service = undefined;
      if (serviceState.phase === "stopping" || quitting) {
        setServiceState({ phase: "stopped", owned: false });
        return;
      }
      const detail = recentOutput.trim() || `ThreadFerry 服务已退出（退出码 ${code}）`;
      setServiceState({ phase: "error", owned: false, detail });
      void showProblem();
    });
  } catch (error) {
    if (generation !== serviceGeneration) return;
    const detail = error instanceof Error ? error.message : String(error);
    appendOutput(`${detail}\n`);
    setServiceState({ phase: "error", owned: false, detail });
    void showProblem();
  }
}

async function stopService(cancel = true): Promise<void> {
  serviceGeneration += 1;
  const child = service;
  managementWindow?.hide();
  if (!child) {
    setServiceState({ phase: "stopped", owned: false });
    return;
  }
  setServiceState({ phase: "stopping", owned: true });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.postMessage({ type: "threadferry:stop", cancel });
  if (!cancel) {
    await exited;
    return;
  }
  let timedOut = false;
  await Promise.race([
    exited,
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => { timedOut = true; resolve(); }, 10_000);
      timer.unref();
    }),
  ]);
  if (timedOut && service === child) {
    child.kill();
    service = undefined;
    setServiceState({ phase: "stopped", owned: false });
  }
}

async function restartService(): Promise<void> {
  if (!serviceState.owned) return;
  await stopService();
  await startService();
}

function openManagementWindow(url: string): void {
  if (!managementWindow) {
    const window = new BrowserWindow({
      width: 1180,
      height: 780,
      minWidth: 860,
      minHeight: 620,
      show: false,
      title: "ThreadFerry 管理台",
      autoHideMenuBar: true,
      backgroundColor: "#0b1220",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: join(app.getAppPath(), "build", "desktop-preload.cjs"),
        sandbox: true,
      },
    });
    managementWindow = window;
    window.removeMenu();
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (target === ISSUE_URL || target.startsWith(`${ISSUE_URL}?`)) void shell.openExternal(target).catch(() => undefined);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event, target) => {
      if (new URL(target).origin !== ADMIN_URL) event.preventDefault();
    });
    window.on("close", (event) => {
      if (!quitting) {
        event.preventDefault();
        window.hide();
      }
    });
    window.on("closed", () => { managementWindow = undefined; });
    window.once("ready-to-show", () => window.show());
  }
  void managementWindow.loadURL(url).then(() => {
    managementWindow?.show();
    managementWindow?.focus();
  }).catch((error) => {
    setServiceState({ phase: "error", owned: Boolean(service), detail: `管理台加载失败：${error.message}` });
  });
}

async function showManagement(path = "/"): Promise<void> {
  if (serviceState.phase === "running" && serviceState.url) {
    const url = new URL(path, serviceState.url).toString();
    if (managementWindow?.webContents.getURL() === url) {
      managementWindow.show();
      managementWindow.focus();
    } else {
      openManagementWindow(url);
    }
    return;
  }
  pendingManagementPath = path;
  if (serviceState.phase === "error") {
    await showProblem();
    return;
  }
  if (serviceState.phase === "stopped") await startService();
}

async function showProblem(): Promise<void> {
  const detail = serviceState.detail ?? recentOutput.trim() ?? "ThreadFerry 未能启动。";
  const needsSetup = /配置不存在|没有初始化/.test(detail);
  const result = await dialog.showMessageBox({
    type: "warning",
    title: "ThreadFerry 启动问题",
    message: needsSetup ? "ThreadFerry 尚未完成首次设置" : "ThreadFerry 服务未能启动",
    detail,
    buttons: needsSetup ? ["复制初始化命令", "重试", "关闭"] : ["重试", "关闭"],
    defaultId: needsSetup ? 1 : 0,
    cancelId: needsSetup ? 2 : 1,
  });
  if (needsSetup && result.response === 0) clipboard.writeText("threadferry onboard");
  else if (result.response === (needsSetup ? 1 : 0)) void startService();
  else pendingManagementPath = undefined;
}

function trayImage(): NativeImage {
  const template = process.platform === "darwin";
  const image = nativeImage.createFromPath(join(app.getAppPath(), "build", template ? "trayTemplate.png" : "tray.png"));
  if (image.isEmpty()) throw new Error("托盘图标资源无法读取");
  if (template) image.setTemplateImage(true);
  return image;
}

function preferenceState(): {
  preferences: DesktopPreferences;
  capabilities: { dockIcon: boolean; launchAtLogin: boolean };
  platform: NodeJS.Platform;
} {
  return {
    preferences: desktopPreferences,
    capabilities: {
      dockIcon: process.platform === "darwin",
      launchAtLogin: app.isPackaged && (process.platform === "darwin" || process.platform === "win32"),
    },
    platform: process.platform,
  };
}

function applyDesktopPreferences(): void {
  if (app.isPackaged && (process.platform === "darwin" || process.platform === "win32")) {
    app.setLoginItemSettings({ openAtLogin: desktopPreferences.launchAtLogin });
  }
  if (process.platform === "darwin") {
    if (desktopPreferences.showDockIcon) void app.dock?.show();
    else app.dock?.hide();
  }
}

function assertAdminSender(event: IpcMainInvokeEvent): void {
  try {
    if (new URL(event.senderFrame?.url ?? "").origin === ADMIN_URL) return;
  } catch {
    // 统一落到下面的拒绝。
  }
  throw new Error("偏好设置只允许本机管理台访问");
}

function reportUpdateStatus(status: DesktopUpdateStatus): void {
  updateStatus = status;
  if (managementWindow && !managementWindow.isDestroyed()) {
    managementWindow.webContents.send("desktop-update:status", status);
  }
}

function runDesktopUpdate(): Promise<{ status: "current" | "installing"; version: string }> {
  if (!app.isPackaged) return Promise.reject(new Error("开发模式不执行桌面自动更新"));
  if (!updateOperation) {
    updateOperation = installDesktopUpdate(autoUpdater, app.getVersion(), async () => {
      updatePreparingRestart = true;
      await stopService(false);
      quitting = true;
    }, reportUpdateStatus).catch(async (error: unknown) => {
      if (updatePreparingRestart) {
        updatePreparingRestart = false;
        quitting = false;
        await startService();
      }
      const message = error instanceof Error ? error.message : String(error);
      appendOutput(`[update] ${message}\n`);
      reportUpdateStatus({ phase: "error", message });
      throw error;
    }).finally(() => { updateOperation = undefined; });
  }
  return updateOperation;
}

function configureAutomaticUpdates(): void {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.on("download-progress", ({ percent }) => {
    reportUpdateStatus({ phase: "downloading", version: updateStatus.version, percent });
  });
  autoUpdater.on("error", (error) => appendOutput(`[update] ${error.message}\n`));
  const firstCheck = setTimeout(() => void runDesktopUpdate().catch(() => undefined), 10_000);
  firstCheck.unref();
  const interval = setInterval(() => void runDesktopUpdate().catch(() => undefined), UPDATE_INTERVAL_MS);
  interval.unref();
}

function registerDesktopHandlers(): void {
  ipcMain.handle("desktop-preferences:get", (event) => {
    assertAdminSender(event);
    return preferenceState();
  });
  ipcMain.handle("desktop-preferences:set", async (event, input: unknown) => {
    assertAdminSender(event);
    desktopPreferences = await writeDesktopPreferences(preferencesPath, input);
    applyDesktopPreferences();
    return preferenceState();
  });
  ipcMain.handle("desktop-update:install", (event) => {
    assertAdminSender(event);
    return runDesktopUpdate();
  });
}

async function initialize(): Promise<void> {
  await prepareLog();
  preferencesPath = join(app.getPath("userData"), "desktop-preferences.json");
  desktopPreferences = await readDesktopPreferences(preferencesPath);
  registerDesktopHandlers();
  if (app.isPackaged) configureAutomaticUpdates();
  Menu.setApplicationMenu(null);
  applyDesktopPreferences();
  tray = new Tray(trayImage());
  rebuildTrayMenu();
  if (process.platform === "win32") tray.on("click", () => tray?.popUpContextMenu(trayMenu));
  if (desktopPreferences.openManagementOnLaunch) pendingManagementPath = "/";
  if (desktopPreferences.autoStartService || pendingManagementPath) void startService();
}

const primary = app.requestSingleInstanceLock();
if (!primary) {
  app.quit();
} else {
  app.on("second-instance", () => void showManagement());
  app.on("activate", () => void showManagement());
  app.on("window-all-closed", () => undefined);
  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void stopService().finally(() => app.quit());
  });
  void app.whenReady().then(initialize).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`ThreadFerry Desktop: ${detail}`);
    dialog.showErrorBox("ThreadFerry 无法启动", detail);
    app.quit();
  });
}
