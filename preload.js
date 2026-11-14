const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("aiBridgeDesktop", {
  isElectron: true,
  readScreen: () => ipcRenderer.invoke("ai-bridge:read-screen"),
  captureScreenImage: () => ipcRenderer.invoke("ai-bridge:capture-screen-image"),
  setOpacity: (val) => ipcRenderer.invoke("ai-bridge:set-opacity", val),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke("ai-bridge:set-always-on-top", flag),
  setContentProtection: (flag) => ipcRenderer.invoke("ai-bridge:set-content-protection", flag),
  setCompactMode: (flag) => ipcRenderer.invoke("ai-bridge:set-compact-mode", flag),
  onShortcut: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, action) => callback(action);
    ipcRenderer.on("ai-bridge:shortcut", handler);
    return () => ipcRenderer.removeListener("ai-bridge:shortcut", handler);
  }
});
