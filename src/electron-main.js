// Electron main process for Snooply's overlay window. Spawned as a detached
// child process by src/index.js (see openPopupWindow) — it owns nothing but
// the window itself: all recommendation data still comes from the local
// server the CLI started, loaded here exactly like a normal page.

const { app, BrowserWindow, screen, ipcMain } = require("electron");
const path = require("path");

const targetUrl = process.argv[2];

const WINDOW_WIDTH = 400;
const INITIAL_HEIGHT = 220;
const RIGHT_MARGIN = 28;

// Keeps a bounds rect fully within whichever display it's currently on —
// used both while dragging and after a resize, so the popup can never end
// up (even partially) off-screen.
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

function createWindow() {
  const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: INITIAL_HEIGHT,
    x: screenWidth - WINDOW_WIDTH - RIGHT_MARGIN,
    y: Math.round((screenHeight - INITIAL_HEIGHT) / 2),
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
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "floating");
  win.once("ready-to-show", () => win.show());
  win.loadURL(targetUrl);

  // Only ever change height here, keeping the window's current top-left —
  // otherwise every recommendation/view change would snap it back to the
  // default right-center spot and undo whatever the user dragged it to.
  const resizeListener = (event, height) => {
    if (event.sender !== win.webContents) {
      return;
    }

    const current = win.getBounds();
    const nextHeight = Math.max(160, Math.min(Math.round(height), screenHeight - 80));
    win.setBounds(clampToDisplay({ x: current.x, y: current.y, width: WINDOW_WIDTH, height: nextHeight }));
  };

  const closeListener = (event) => {
    if (event.sender !== win.webContents) {
      return;
    }
    win.close();
  };

  // The page drives dragging itself (mousemove deltas over IPC) rather than
  // native -webkit-app-region: drag, which was found to swallow clicks on
  // buttons layered inside the draggable card. Each delta just nudges the
  // window from its current position, clamped so it can't go off-screen.
  const moveListener = (event, dx, dy) => {
    if (event.sender !== win.webContents) {
      return;
    }
    const current = win.getBounds();
    win.setBounds(clampToDisplay({ x: current.x + dx, y: current.y + dy, width: current.width, height: current.height }));
  };

  ipcMain.on("snooply:resize", resizeListener);
  ipcMain.on("snooply:close", closeListener);
  ipcMain.on("snooply:move", moveListener);

  win.on("closed", () => {
    ipcMain.removeListener("snooply:resize", resizeListener);
    ipcMain.removeListener("snooply:close", closeListener);
    ipcMain.removeListener("snooply:move", moveListener);
    app.quit();
  });
}

app.whenReady().then(() => {
  if (process.platform === "darwin" && app.dock) {
    app.dock.hide();
  }
  createWindow();
});

app.on("window-all-closed", () => {
  app.quit();
});
