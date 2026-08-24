const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("threadferryDesktop", {
  getPreferences: () => ipcRenderer.invoke("desktop-preferences:get"),
  setPreferences: (preferences) => ipcRenderer.invoke("desktop-preferences:set", preferences),
});
