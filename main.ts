import electron, { app, BrowserWindow, ipcMain, desktopCapturer, screen, session } from "electron";
import http from "http";
import path from "path";
import { spawn, ChildProcess } from "child_process";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { extractTextFromImageBuffer, terminateOcrWorker } = require("./ocr-service");

interface WindowRestoreState {
  wasVisible: boolean;
  wasAlwaysOnTop: boolean;
  wasFocused: boolean;
  opacity: number;
}

// If run via standard Node or with ELECTRON_RUN_AS_NODE=1 (e.g. from IDE terminal),
// re-launch with real Electron without ELECTRON_RUN_AS_NODE
if (typeof electron === "string") {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(electron as unknown as string, [__filename, ...process.argv.slice(2)], {
    stdio: "inherit",
    env
  });
  child.on("close", (code) => process.exit(code || 0));
} else {
  let serverProcess: ChildProcess | null = null;
  let mainWin: BrowserWindow | null = null;
  let captureInProgress = false;

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  async function waitForWindowHidden(win: BrowserWindow | null) {
    if (!win || win.isDestroyed()) return;
    if (!win.isVisible()) {
      await sleep(180);
      return;
    }

    await new Promise<void>((resolve) => {
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
      setTimeout(done, 450);
    });

    await sleep(260);
  }

  function restoreWindow(win: BrowserWindow | null, state: WindowRestoreState) {
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
      try {
        win.setOpacity(0.85);
        win.show();
        win.setAlwaysOnTop(true);
      } catch {}
    }
  }

  async function captureVisibleScreenBuffer(win: BrowserWindow | null): Promise<Buffer> {
    const bounds = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0, width: 900, height: 550 };
    const targetDisplay = screen.getDisplayMatching(bounds) || screen.getPrimaryDisplay();
    const scaleFactor = Math.max(1, targetDisplay?.scaleFactor || 1);
    const captureWidth = Math.min(Math.round((targetDisplay?.size?.width || 1920) * scaleFactor), 2560);
    const captureHeight = Math.min(Math.round((targetDisplay?.size?.height || 1080) * scaleFactor), 1440);

    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: captureWidth, height: captureHeight },
      fetchWindowIcons: false
    });

    if (!Array.isArray(sources) || sources.length === 0) {
      throw new Error(
        "No display sources found for screen capture. Check OS Screen Recording permissions for AI Bridge."
      );
    }

    const targetId = String(targetDisplay?.id || "");
    const matchedSource = sources.find((s) => String(s.display_id || "") === targetId) || sources[0];
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
    let pngBuffer: Buffer | null = null;

    try {
      const windowState: WindowRestoreState = senderWin && !senderWin.isDestroyed()
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
        restoreWindow(senderWin, windowState);
      }

      const ocrResult = await extractTextFromImageBuffer(pngBuffer);
      pngBuffer = null;
      return ocrResult;
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      return {
        ok: false,
        code: e?.code || "READ_SCREEN_FAILED",
        error: e?.message || "Failed to capture or extract text from screen."
      };
    } finally {
      pngBuffer = null;
      captureInProgress = false;
    }
  });

  // Connect app code: ensure the Express server (server.js) is running on system Node (Node 20+)
  function ensureServerRunning() {
    const req = http.get("http://localhost:3000", () => {
      console.log("Backend server is already running on port 3000.");
    });
    req.on("error", () => {
      console.log("Starting backend server with system Node...");
      try {
        const env = { ...process.env };
        delete env.ELECTRON_RUN_AS_NODE;
        serverProcess = spawn("node", ["server.js"], {
          cwd: __dirname,
          stdio: "inherit",
          env,
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
      transparent: false,
      frame: true,
      alwaysOnTop: true,
      resizable: true,
      minWidth: 320,
      minHeight: 480,
      maxWidth: 1920,
      maxHeight: 1080,
      webPreferences: {
        preload: path.join(__dirname, "preload.js"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });
    mainWin = win;

    win.loadURL("http://localhost:3000");

    win.webContents.on("did-fail-load", () => {
      setTimeout(() => {
        win.loadURL("http://localhost:3000");
      }, 500);
    });

    win.setContentProtection(true);
    win.setOpacity(0.85);
  }

  app.whenReady().then(() => {
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
}
