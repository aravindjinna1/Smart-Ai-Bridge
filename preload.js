const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiBridgeDesktop", {
  isElectron: true,
  readScreen: () => ipcRenderer.invoke("ai-bridge:read-screen")
});
