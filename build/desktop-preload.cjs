const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("threadferryDesktop", {
  getPreferences: () => ipcRenderer.invoke("desktop-preferences:get"),
  setPreferences: (preferences) => ipcRenderer.invoke("desktop-preferences:set", preferences),
  updateAndRestart: () => ipcRenderer.invoke("desktop-update:install"),
  onUpdateStatus: (callback) => ipcRenderer.on("desktop-update:status", (_event, status) => callback(status)),
});
