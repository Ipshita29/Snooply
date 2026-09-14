// Safe bridge between the popup page and Electron
// The page can only call these two things, nothing else

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("snooply", {
  requestClose: () => ipcRenderer.send("snooply:close"),
  moveBy: (dx, dy) => ipcRenderer.send("snooply:move", dx, dy),
});
