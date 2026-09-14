// Creates the Snooply popup window.
// Spawned by index.js as a separate process — it just loads the local
// server's page, it doesn't know anything about dependencies.

const { app, BrowserWindow, screen, ipcMain } = require("electron");
const path = require("path");

const targetUrl = process.argv[2];

const WINDOW_WIDTH = 400;
const WINDOW_HEIGHT = 620;
const RIGHT_MARGIN = 28;

// Keep the window on screen
function clampToDisplay(bounds) {
  const display = screen.getDisplayMatching(bounds) || screen.getDisplayNearestPoint(bounds);
  const wa = display.workArea;
  const maxX = wa.x + wa.width - bounds.width;
  const maxY = wa.y + wa.height - bounds.height;

  return {
    x: Math.min(Math.max(bounds.x, wa.x), Math.max(wa.x, maxX)),
    y: Math.min(Math.max(bounds.y, wa.y), Math.max(wa.y, maxY)),
    width: bounds.width,
    height: bounds.height,
  };
}

// Create the transparent popup window
function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    x: screenWidth - WINDOW_WIDTH - RIGHT_MARGIN,
    y: Math.round((screenHeight - WINDOW_HEIGHT) / 2),
    frame: false,
    transparent: true,
    hasShadow: false,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    skipTaskbar: true,
    backgroundColor: "#00000000",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "bridge.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  win.once("ready-to-show", () => win.show());
  win.loadURL(targetUrl);

  const closeListener = (event) => {
    if (event.sender !== win.webContents) {
      return;
    }
    win.close();
  };

  // Move the window by a drag delta
  // (native drag-region swallowed button clicks, so the page drives this)
  const moveListener = (event, dx, dy) => {
    if (event.sender !== win.webContents) {
      return;
    }
    const current = win.getBounds();
    win.setBounds(clampToDisplay({ x: current.x + dx, y: current.y + dy, width: current.width, height: current.height }));
  };

  ipcMain.on("snooply:close", closeListener);
  ipcMain.on("snooply:move", moveListener);

  win.on("closed", () => {
    ipcMain.removeListener("snooply:close", closeListener);
    ipcMain.removeListener("snooply:move", moveListener);
    app.quit();
  });
}

// Hide the dock icon and show the popup
app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
  createWindow();
});

// Quit once the popup is closed
app.on("window-all-closed", () => {
  app.quit();
});
