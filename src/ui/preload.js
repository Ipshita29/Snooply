// Minimal, explicit bridge between the overlay page and the Electron main
// process — no Node integration exposed to the page itself, just the two
// calls it actually needs (report its own height, ask to be closed).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("snooply", {
  resize: (height) => ipcRenderer.send("snooply:resize", height),
  requestClose: () => ipcRenderer.send("snooply:close"),
  moveBy: (dx, dy) => ipcRenderer.send("snooply:move", dx, dy),
});
