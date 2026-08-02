const { app, BrowserWindow, dialog, session } = require("electron");
const dotenv = require("dotenv");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const HOST = "127.0.0.1";
const PORT = Number(process.env.CAT_WORKSHOP_PORT || 18788);
let server = null;
let mainWindow = null;

app.setName("猫咪工坊");

function loadLocalEnvironment() {
  const directory = app.isPackaged
    ? process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath)
    : path.resolve(__dirname, "..");
  dotenv.config({ path: path.join(directory, ".env"), quiet: true });
}

async function startLocalServer() {
  const appRoot = app.getAppPath();
  const moduleUrl = pathToFileURL(path.join(appRoot, "dist-server", "server", "app.js")).href;
  const { createCatWorkshopApp } = await import(moduleUrl);
  const expressApp = createCatWorkshopApp({
    webDist: path.join(appRoot, "dist"),
    apiKey: process.env.DEEPSEEK_API_KEY,
  });

  server = http.createServer(expressApp);
  await new Promise((resolve, reject) => {
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen(PORT, HOST, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function createWindow() {
  const origin = `http://${HOST}:${PORT}`;
  mainWindow = new BrowserWindow({
    title: "猫咪工坊",
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: !app.isPackaged,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, target) => {
    if (!target.startsWith(origin)) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  void mainWindow.loadURL(origin);
}

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    loadLocalEnvironment();
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    try {
      await startLocalServer();
      createWindow();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      dialog.showErrorBox("猫咪工坊无法启动", `本地服务端口 ${PORT} 启动失败。\n\n${detail}`);
      app.quit();
    }
  });
}

app.on("window-all-closed", () => app.quit());
app.on("before-quit", () => {
  if (server) server.close();
});
