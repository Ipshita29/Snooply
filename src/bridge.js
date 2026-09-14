// Safe bridge between the popup page and Electron
// The page can only call these three things, nothing else

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("snooply", {
  resize: (height) => ipcRenderer.send("snooply:resize", height),
  requestClose: () => ipcRenderer.send("snooply:close"),
  moveBy: (dx, dy) => ipcRenderer.send("snooply:move", dx, dy),
});
