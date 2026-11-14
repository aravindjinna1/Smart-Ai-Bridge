const electron = require("electron");

// If run via standard Node or with ELECTRON_RUN_AS_NODE=1 (e.g. from IDE terminal),
// re-launch with real Electron without ELECTRON_RUN_AS_NODE
if (typeof electron === "string") {
  const { spawn } = require("child_process");
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env
  });
  child.on("close", (code) => process.exit(code || 0));
  return;
}

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, session } = electron;
const http = require("http");
const { spawn } = require("child_process");
const path = require("path");
const { extractTextFromImageBuffer, terminateOcrWorker } = require("./ocr-service");

let serverProcess = null;
let mainWin = null;
let captureInProgress = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForWindowHidden(win) {
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) {
    await sleep(180);
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      win.removeListener("hide", onHide);
      resolve();
    };
    const onHide = () => done();
    win.once("hide", onHide);
    win.setOpacity(0);
    win.hide();
    // Safety fallback if compositor event lags
    setTimeout(done, 450);
  });

  // Allow desktop compositor (DWM / Quartz / X11) to flush frame without the floating window
  await sleep(260);
}

function restoreWindow(win, state) {
  if (!win || win.isDestroyed()) return;
  try {
    win.setOpacity(state.opacity ?? 0.85);
    win.setContentProtection(true);
    if (state.wasVisible) {
      if (state.wasFocused) {
        win.show();
      } else {
        win.showInactive();
      }
    }
    win.setAlwaysOnTop(state.wasAlwaysOnTop ?? true);
  } catch {
    // Ensure best-effort restore never throws
    try {
      win.setOpacity(0.85);
      win.show();
      win.setAlwaysOnTop(true);
    } catch {}
  }
}

async function captureVisibleScreenBuffer(win) {
  const bounds = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0, width: 900, height: 550 };
  const targetDisplay = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
  const scaleFactor = Math.max(1, targetDisplay?.scaleFactor || 1);
  const captureWidth = Math.min(Math.round((targetDisplay?.size?.width || 1920) * scaleFactor), 2560);
  const captureHeight = Math.min(Math.round((targetDisplay?.size?.height || 1080) * scaleFactor), 1440);

  let sources;
  try {
    sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: captureWidth, height: captureHeight },
      fetchWindowIcons: false
    });
  } catch (err) {
    throw new Error(
      `Screen capture permission denied or unavailable: ${err?.message || "Check OS screen recording permissions."}`
    );
  }

  if (!Array.isArray(sources) || sources.length === 0) {
    throw new Error(
      "No display sources found for screen capture. Check OS Screen Recording permissions for AI Bridge."
    );
  }

  const targetId = String(targetDisplay?.id || "");
  const matchedSource =
    sources.find((s) => String(s.display_id || "") === targetId) || sources[0];

  if (!matchedSource || !matchedSource.thumbnail || matchedSource.thumbnail.isEmpty()) {
    throw new Error(
      "Captured screen image was empty. Grant Screen Recording permission in your OS settings and try again."
    );
  }

  const pngBuffer = matchedSource.thumbnail.toPNG();
  if (!Buffer.isBuffer(pngBuffer) || pngBuffer.length === 0) {
    throw new Error("Could not encode captured screen image in memory.");
  }

  return pngBuffer;
}

ipcMain.handle("ai-bridge:read-screen", async (event) => {
  if (captureInProgress) {
    return { ok: false, code: "CAPTURE_IN_PROGRESS", error: "Screen capture is already in progress." };
  }

  captureInProgress = true;
  const senderWin = BrowserWindow.fromWebContents(event.sender) || mainWin;
  let pngBuffer = null;

  try {
    const windowState = senderWin && !senderWin.isDestroyed()
      ? {
          wasVisible: senderWin.isVisible(),
          wasAlwaysOnTop: senderWin.isAlwaysOnTop(),
          wasFocused: senderWin.isFocused(),
          opacity: 0.85
        }
      : { wasVisible: true, wasAlwaysOnTop: true, wasFocused: true, opacity: 0.85 };

    try {
      await waitForWindowHidden(senderWin);
      pngBuffer = await captureVisibleScreenBuffer(senderWin);
    } finally {
      // Restore the floating window immediately after capture (even if capture failed)
      restoreWindow(senderWin, windowState);
    }

    const ocrResult = await extractTextFromImageBuffer(pngBuffer);
    pngBuffer = null;
    return ocrResult;
  } catch (err) {
    return {
      ok: false,
      code: err?.code || "READ_SCREEN_FAILED",
      error: err?.message || "Failed to capture or extract text from screen."
    };
  } finally {
    pngBuffer = null;
    captureInProgress = false;
  }
});

// Connect app code: ensure the Express server (server.js) is running on Node
function ensureServerRunning() {
  const req = http.get("http://localhost:3000", () => {
    console.log("Backend server is already running on port 3000.");
  });
  req.on("error", () => {
    console.log("Starting backend server (node server.js)...");
    try {
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const isWin = process.platform === "win32";
      const cmd = isWin ? "cmd.exe" : "node";
      const args = isWin ? ["/c", "node", "server.js"] : ["server.js"];
      serverProcess = spawn(cmd, args, {
        cwd: __dirname,
        env,
        stdio: "inherit",
        windowsHide: true
      });
      serverProcess.on("error", (err) => {
        console.error("Failed to start server.js:", err);
      });
    } catch (err) {
      console.error("Failed to start server.js:", err);
    }
  });
}

ensureServerRunning();

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 550,
    // minWidth: 400,
    // minHeight: 600,
    transparent: false, // allows transparency
    frame: true, // optional: remove title bar
    alwaysOnTop: true, // float above other windows
    resizable: true,
    minWidth: 320, // smallest width (like a phone screen)
    minHeight: 480, // smallest height
    maxWidth: 1920, // optional: cap max size
    maxHeight: 1080, // optional: cap max size
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWin = win;

  win.loadURL("http://localhost:3000");

  // If server is still starting up, retry loading
  win.webContents.on("did-fail-load", () => {
    setTimeout(() => {
      win.loadURL("http://localhost:3000");
    }, 500);
  });

  // Makes the window invisible to screen share/record
  win.setContentProtection(true);

  // Optional: adjust opacity for faint tint
  win.setOpacity(0.85);
}

app.whenReady().then(() => {
  // Automatically allow getDisplayMedia with system loopback audio (captures Google Meet/Zoom/system audio)
  if (session?.defaultSession?.setDisplayMediaRequestHandler) {
    session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
      try {
        const sources = await desktopCapturer.getSources({ types: ["screen"] });
        if (sources.length > 0) {
          callback({ video: sources[0], audio: "loopback" });
        } else {
          callback({});
        }
      } catch {
        callback({});
      }
    });
  }
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("will-quit", async () => {
  await terminateOcrWorker();
  if (serverProcess) {
    serverProcess.kill();
  }
});
