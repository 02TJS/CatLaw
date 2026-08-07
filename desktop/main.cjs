const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require("electron");
const dotenv = require("dotenv");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HOST = "127.0.0.1";
const BASE_WINDOW_WIDTH = 760;
const BASE_WINDOW_HEIGHT = 720;
const MIN_WINDOW_SCALE = 0.55;
const MAX_WINDOW_SCALE = 1.35;
let server = null;
let mainWindow = null;
let localPort = 18788;
let appIsQuitting = false;
let windowScale = 1;
const windowDragState = new Map();
let rendererRecoveryCount = 0;
let rendererRecoveryScheduled = false;
let qaRendererCrashInjected = false;
const MAX_RENDERER_RECOVERIES = 2;
const DISPOSABLE_CHROMIUM_CACHE_NAMES = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
];

app.setName("猫咪工坊");
app.disableHardwareAcceleration();
app.commandLine.appendSwitch("disable-gpu-shader-disk-cache");
app.commandLine.appendSwitch("disable-gpu-program-cache");
app.commandLine.appendSwitch("disable-features", "Vulkan,CanvasOopRasterization");

function executableDirectory() {
  return app.isPackaged
    ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)
    : path.resolve(__dirname, "..");
}

function startupLog(message, error) {
  const detail = error instanceof Error ? `${error.stack || error.message}` : error ? String(error) : "";
  const line = `[${new Date().toISOString()}] ${message}${detail ? ` | ${detail}` : ""}\n`;
  try {
    fs.appendFileSync(path.join(executableDirectory(), "CatWorkshop-startup.log"), line, "utf8");
  } catch {
    // A read-only launch directory must not prevent the game from starting.
  }
}

function clearDisposableChromiumCaches(reason) {
  const userDataRoot = path.resolve(app.getPath("userData"));
  const cleared = [];
  for (const name of DISPOSABLE_CHROMIUM_CACHE_NAMES) {
    const target = path.resolve(userDataRoot, name);
    if (path.dirname(target) !== userDataRoot) continue;
    try {
      if (!fs.existsSync(target)) continue;
      fs.rmSync(target, { recursive: true, force: true });
      cleared.push(name);
    } catch (error) {
      startupLog(`could not clear disposable Chromium cache ${name}`, error);
    }
  }
  if (cleared.length > 0) startupLog(`cleared disposable Chromium caches for ${reason}: ${cleared.join(", ")}`);
}

async function clearLiveSessionCaches(reason) {
  const results = await Promise.allSettled([
    session.defaultSession.clearCache(),
    session.defaultSession.clearCodeCaches({}),
  ]);
  for (const result of results) {
    if (result.status === "rejected") startupLog(`could not clear live Chromium caches for ${reason}`, result.reason);
  }
}

function loadLocalEnvironment() {
  dotenv.config({ path: path.join(executableDirectory(), ".env"), quiet: true });
}

function secureKeyPath() {
  return path.join(app.getPath("userData"), "deepseek-key.bin");
}

function deepSeekSettingsPath() {
  return path.join(app.getPath("userData"), "deepseek-settings.json");
}

function loadSecureDeepSeekKey() {
  try {
    const keyFile = secureKeyPath();
    if (!fs.existsSync(keyFile) || !safeStorage.isEncryptionAvailable()) return undefined;
    const value = safeStorage.decryptString(fs.readFileSync(keyFile)).trim();
    return /^sk-[A-Za-z0-9_-]{17,509}$/.test(value) ? value : undefined;
  } catch (error) {
    startupLog("secure DeepSeek key could not be loaded", error);
    return undefined;
  }
}

function persistSecureDeepSeekKey(apiKey) {
  if (!safeStorage.isEncryptionAvailable()) return false;
  const target = secureKeyPath();
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, safeStorage.encryptString(apiKey), { mode: 0o600 });
    fs.renameSync(temporary, target);
    try {
      fs.chmodSync(target, 0o600);
    } catch {
      // Windows applies the current user's ACL even when POSIX mode bits are unavailable.
    }
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Ignore cleanup errors; the key itself is encrypted by Electron safeStorage.
    }
    startupLog("secure DeepSeek key could not be saved", error);
    throw new Error("无法写入本机安全密钥存储");
  }
}

function loadDeepSeekBaseUrl() {
  try {
    const settingsFile = deepSeekSettingsPath();
    if (!fs.existsSync(settingsFile)) return undefined;
    const value = JSON.parse(fs.readFileSync(settingsFile, "utf8"))?.baseUrl;
    if (typeof value !== "string") return undefined;
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? value : undefined;
  } catch (error) {
    startupLog("DeepSeek API URL could not be loaded", error);
    return undefined;
  }
}

function persistDeepSeekBaseUrl(baseUrl) {
  const target = deepSeekSettingsPath();
  const temporary = `${target}.tmp-${process.pid}`;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify({ baseUrl }, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(temporary, target);
    return true;
  } catch (error) {
    try {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    } catch {
      // Ignore cleanup errors; no secret is stored in this file.
    }
    startupLog("DeepSeek API URL could not be saved", error);
    throw new Error("无法写入本机模型连接设置");
  }
}

async function startLocalServer() {
  const appRoot = app.getAppPath();
  const moduleUrl = pathToFileURL(path.join(appRoot, "dist-server", "server", "app.js")).href;
  const { createCatWorkshopApp } = await import(moduleUrl);
  const initialApiKey = loadSecureDeepSeekKey() || process.env.DEEPSEEK_API_KEY;
  const expressApp = createCatWorkshopApp({
    webDist: path.join(appRoot, "dist"),
    apiKey: initialApiKey,
    baseUrl: loadDeepSeekBaseUrl() || process.env.DEEPSEEK_BASE_URL,
    persistApiKey: safeStorage.isEncryptionAvailable() ? persistSecureDeepSeekKey : undefined,
    persistBaseUrl: persistDeepSeekBaseUrl,
  });

  const configuredPort = Number(process.env.CAT_WORKSHOP_PORT || 18788);
  const preferredPort = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65_535
    ? configuredPort
    : 18788;
  let lastError = null;
  for (let offset = 0; offset < 10; offset += 1) {
    const candidatePort = preferredPort + offset;
    if (candidatePort > 65_535) break;
    const candidateServer = http.createServer(expressApp);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        candidateServer.once("error", onError);
        candidateServer.listen(candidatePort, HOST, () => {
          candidateServer.off("error", onError);
          resolve();
        });
      });
      server = candidateServer;
      localPort = candidatePort;
      startupLog(`local server ready at http://${HOST}:${localPort}`);
      return;
    } catch (error) {
      lastError = error;
      try {
        candidateServer.close();
      } catch {
        // A server that failed before listening has nothing to close.
      }
      if (error?.code !== "EADDRINUSE") throw error;
      startupLog(`port ${candidatePort} occupied; trying the next port`);
    }
  }
  throw lastError || new Error("没有可用的本地服务端口");
}

function reportWindowFailure(title, error) {
  startupLog(title, error);
  const detail = error instanceof Error ? error.message : String(error);
  dialog.showErrorBox("猫咪工坊显示失败", `${title}\n\n${detail}\n\n请把 CatWorkshop-startup.log 发给开发者。`);
}

function physicalScreenPointer(target, rawValue, axis) {
  const bounds = target.getBounds();
  const zoom = target.webContents.getZoomFactor() || 1;
  const origin = axis === "x" ? bounds.x : bounds.y;
  return origin + (rawValue - origin) / zoom;
}

async function recoverRenderer(targetWindow, details) {
  if (appIsQuitting || rendererRecoveryScheduled || targetWindow.isDestroyed()) return;
  if (rendererRecoveryCount >= MAX_RENDERER_RECOVERIES) {
    reportWindowFailure("渲染进程反复异常退出", new Error(`${details.reason}; exitCode=${details.exitCode}`));
    startupLog("renderer recovery limit reached; quitting instead of retaining a dead single-instance shell");
    try {
      targetWindow.destroy();
    } catch (error) {
      startupLog("failed to destroy the renderer window after exhausting recovery", error);
    }
    app.quit();
    return;
  }
  rendererRecoveryScheduled = true;
  rendererRecoveryCount += 1;
  startupLog(
    `renderer recovery ${rendererRecoveryCount}/${MAX_RENDERER_RECOVERIES} scheduled after ${details.reason}; exitCode=${details.exitCode}`,
  );
  if (mainWindow === targetWindow) mainWindow = null;
  try {
    targetWindow.destroy();
  } catch (error) {
    startupLog("failed to destroy the crashed renderer window", error);
  }
  await clearLiveSessionCaches(`renderer recovery ${rendererRecoveryCount}`);
  await new Promise((resolve) => setTimeout(resolve, 350 * rendererRecoveryCount));
  if (!appIsQuitting) {
    createWindow();
    startupLog(`renderer recovery ${rendererRecoveryCount}/${MAX_RENDERER_RECOVERIES} created a replacement window`);
  }
  rendererRecoveryScheduled = false;
}

function createWindow() {
  const origin = `http://${HOST}:${localPort}`;
  let windowCloseRequested = false;
  let loadAttempt = 0;
  const targetWindow = new BrowserWindow({
    title: "猫咪工坊",
    width: Math.round(BASE_WINDOW_WIDTH * windowScale),
    height: Math.round(BASE_WINDOW_HEIGHT * windowScale),
    minWidth: Math.round(BASE_WINDOW_WIDTH * MIN_WINDOW_SCALE),
    minHeight: Math.round(BASE_WINDOW_HEIGHT * MIN_WINDOW_SCALE),
    show: true,
    frame: false,
    transparent: true,
    hasShadow: true,
    alwaysOnTop: true,
    autoHideMenuBar: true,
    backgroundColor: "#00000000",
    movable: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow = targetWindow;
  targetWindow.webContents.setZoomFactor(windowScale);

  startupLog("main window created and shown");
  targetWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  targetWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(origin)) event.preventDefault();
  });
  const loadLocalPage = () => {
    if (appIsQuitting || windowCloseRequested || targetWindow.isDestroyed()) return;
    loadAttempt += 1;
    void targetWindow.loadURL(origin).catch((error) => {
      if (appIsQuitting || windowCloseRequested || targetWindow.isDestroyed()) {
        startupLog("local page load cancelled while closing");
        return;
      }
      if (loadAttempt < 3) {
        startupLog(`local page load attempt ${loadAttempt} failed; retrying`, error);
        setTimeout(loadLocalPage, 250 * loadAttempt);
        return;
      }
      reportWindowFailure("无法打开本地游戏页面", error);
    });
  };
  targetWindow.webContents.on("did-finish-load", () => {
    targetWindow.webContents.setZoomFactor(windowScale);
    startupLog(`renderer finished loading at window scale ${windowScale}`);
    if (process.env.CAT_WORKSHOP_QA_CRASH_RENDERER_ONCE === "1" && !qaRendererCrashInjected) {
      qaRendererCrashInjected = true;
      setTimeout(() => {
        if (!targetWindow.isDestroyed()) targetWindow.webContents.forcefullyCrashRenderer();
      }, 500);
    }
  });
  targetWindow.webContents.on("render-process-gone", (_event, details) => {
    if (appIsQuitting || windowCloseRequested) return;
    startupLog("渲染进程意外退出", new Error(`${details.reason}; exitCode=${details.exitCode}`));
    void recoverRenderer(targetWindow, details);
  });
  targetWindow.on("unresponsive", () => startupLog("main window became unresponsive"));
  targetWindow.on("close", () => {
    windowCloseRequested = true;
  });
  targetWindow.on("closed", () => {
    if (mainWindow === targetWindow) mainWindow = null;
  });
  loadLocalPage();
}

process.on("uncaughtException", (error) => startupLog("uncaught exception", error));
process.on("unhandledRejection", (error) => startupLog("unhandled rejection", error));

ipcMain.on("desktop-window-action", (event, action) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;
  if (action === "minimize") target.minimize();
  if (action === "close") target.close();
});

ipcMain.handle("desktop-toggle-always-on-top", (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return false;
  target.setAlwaysOnTop(!target.isAlwaysOnTop());
  return target.isAlwaysOnTop();
});

ipcMain.handle("desktop-window-scale", (event, request) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return { scale: windowScale, ...target?.getBounds?.() };
  const deltaY = Number(request?.deltaY);
  if (!Number.isFinite(deltaY) || deltaY === 0) {
    const bounds = target.getBounds();
    return { scale: windowScale, width: bounds.width, height: bounds.height };
  }
  const before = target.getBounds();
  const nextScale = Math.max(
    MIN_WINDOW_SCALE,
    Math.min(MAX_WINDOW_SCALE, windowScale * Math.exp(-deltaY * 0.0012)),
  );
  if (Math.abs(nextScale - windowScale) < 0.001) {
    return { scale: windowScale, width: before.width, height: before.height };
  }
  const rawScreenX = Number(request?.screenX);
  const rawScreenY = Number(request?.screenY);
  const screenX = Number.isFinite(rawScreenX) ? physicalScreenPointer(target, rawScreenX, "x") : Number.NaN;
  const screenY = Number.isFinite(rawScreenY) ? physicalScreenPointer(target, rawScreenY, "y") : Number.NaN;
  const anchorX = Number.isFinite(screenX) ? (screenX - before.x) / Math.max(1, before.width) : 0.5;
  const anchorY = Number.isFinite(screenY) ? (screenY - before.y) / Math.max(1, before.height) : 0.5;
  const width = Math.round(BASE_WINDOW_WIDTH * nextScale);
  const height = Math.round(BASE_WINDOW_HEIGHT * nextScale);
  const nextX = Math.round((Number.isFinite(screenX) ? screenX : before.x + before.width / 2) - anchorX * width);
  const nextY = Math.round((Number.isFinite(screenY) ? screenY : before.y + before.height / 2) - anchorY * height);
  windowScale = nextScale;
  target.setBounds({ x: nextX, y: nextY, width, height }, false);
  target.webContents.setZoomFactor(windowScale);
  return { scale: windowScale, width, height };
});

ipcMain.handle("open-recipes-in-browser", async (event) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;
  await shell.openExternal(`http://${HOST}:${localPort}/recipes.html`);
});

ipcMain.on("desktop-window-drag", (event, action, pointer) => {
  const target = BrowserWindow.fromWebContents(event.sender);
  if (!target || target.isDestroyed()) return;
  const key = event.sender.id;
  if (action === "begin" && Number.isFinite(pointer?.screenX) && Number.isFinite(pointer?.screenY)) {
    const bounds = target.getBounds();
    windowDragState.set(key, {
      startX: physicalScreenPointer(target, pointer.screenX, "x"),
      startY: physicalScreenPointer(target, pointer.screenY, "y"),
      windowX: bounds.x,
      windowY: bounds.y,
    });
    return;
  }
  if (action === "move") {
    const drag = windowDragState.get(key);
    if (!drag || !Number.isFinite(pointer?.screenX) || !Number.isFinite(pointer?.screenY)) return;
    const screenX = physicalScreenPointer(target, pointer.screenX, "x");
    const screenY = physicalScreenPointer(target, pointer.screenY, "y");
    target.setPosition(
      Math.round(drag.windowX + screenX - drag.startX),
      Math.round(drag.windowY + screenY - drag.startY),
    );
    return;
  }
  if (action === "end") windowDragState.delete(key);
});

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  startupLog("a second instance was redirected to the running game");
  app.quit();
} else {
  app.on("second-instance", () => {
    startupLog("second launch requested; focusing the existing window");
    if (!mainWindow || mainWindow.isDestroyed()) {
      if (!appIsQuitting && !rendererRecoveryScheduled && server) {
        createWindow();
        startupLog("second launch rebuilt the missing main window");
      }
      return;
    }
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    startupLog(`application ready; packaged=${app.isPackaged}`);
    clearDisposableChromiumCaches("startup");
    loadLocalEnvironment();
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    try {
      await startLocalServer();
      createWindow();
    } catch (error) {
      startupLog("startup failed", error);
      const detail = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("猫咪工坊无法启动", `本地服务启动失败。\n\n${detail}\n\n请查看 EXE 同目录的 CatWorkshop-startup.log。`);
      app.quit();
    }
  }).catch((error) => {
    startupLog("Electron readiness failed", error);
    dialog.showErrorBox("猫咪工坊无法启动", String(error));
    app.quit();
  });
}

app.on("child-process-gone", (_event, details) => {
  if (appIsQuitting) return;
  startupLog(`child process gone: ${details.type} ${details.reason}; exitCode=${details.exitCode}`);
});

app.on("window-all-closed", () => {
  if (!rendererRecoveryScheduled) app.quit();
});
app.on("before-quit", () => {
  appIsQuitting = true;
  startupLog("application quitting");
  if (server) {
    server.close();
    server = null;
  }
});
