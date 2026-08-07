import { app, BrowserWindow, ipcMain, session, WebContentsView } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuditLog } from "./audit.mjs";
import { BrowserController } from "./browser/controller.mjs";
import {
  assertNoElectronBrand,
  buildChromiumUserAgent,
} from "./browser/user-agent.mjs";
import { defaultRuntimeDir, loadConfig } from "./config.mjs";
import { HumanPacedExecutor } from "./executor/human-paced.mjs";
import { BrowserDaemon } from "./server/daemon.mjs";
import { createApiServer } from "./server/http-server.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = defaultRuntimeDir();
const browserUserAgent = assertNoElectronBrand(buildChromiumUserAgent());
app.setName("Agent Browser Local");
app.userAgentFallback = browserUserAgent;
app.setPath(
  "userData",
  process.env.ABL_PROFILE_DIR || path.join(runtimeDir, "profile"),
);

let mainWindow;
let contentView;
let controller;
let api;

function layoutContent() {
  if (!mainWindow || !contentView) return;
  const [width, height] = mainWindow.getContentSize();
  contentView.setBounds({ x: 0, y: 64, width, height: Math.max(0, height - 64) });
}

function sendState() {
  if (!mainWindow?.isDestroyed() && controller) {
    mainWindow.webContents.send("browser:state", controller.status());
  }
}

async function createWindow(config) {
  session.defaultSession.setUserAgent(
    browserUserAgent,
    "zh-CN,zh;q=0.9,en;q=0.8",
  );
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 620,
    title: "Agent Browser Local",
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(sourceDir, "preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  contentView = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  contentView.webContents.setUserAgent(browserUserAgent);
  mainWindow.contentView.addChildView(contentView);
  mainWindow.on("resize", layoutContent);
  layoutContent();

  contentView.webContents.setWindowOpenHandler(() => ({
    action: "allow",
    overrideBrowserWindowOptions: {
      autoHideMenuBar: true,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    },
  }));

  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  controller = new BrowserController(contentView.webContents, config);
  controller.on("state", sendState);
  controller.on("handoff", sendState);

  await mainWindow.loadFile(path.join(sourceDir, "ui", "index.html"));
  await controller.initialize();
  await controller.navigate(config.browser.startUrl || "about:blank");
  sendState();

  if (process.env.ACL_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function installIpc() {
  ipcMain.handle("browser:status", () => controller.status());
  ipcMain.handle("browser:navigate", (_event, url) => controller.navigate(url));
  ipcMain.handle("browser:back", () => controller.back());
  ipcMain.handle("browser:forward", () => controller.forward());
  ipcMain.handle("browser:reload", () => controller.reload());
  ipcMain.handle("browser:clear-handoff", () => controller.clearHandoff());
}

app.whenReady().then(async () => {
  try {
    const { config, configPath, tokens } = await loadConfig();
    await createWindow(config);
    installIpc();

    const executor = new HumanPacedExecutor({
      minDelayMs: config.security.minActionDelayMs,
      maxDelayMs: config.security.maxActionDelayMs,
    });
    const audit = new AuditLog(path.join(runtimeDir, "audit", "events.jsonl"));
    const daemon = new BrowserDaemon({ controller, config, executor, audit });
    api = createApiServer({ daemon, config, controller });
    await api.listen();

    console.log(`Agent Browser Local listening on http://${config.server.host}:${config.server.port}`);
    console.log(`Config: ${configPath}`);
    console.log(`Compatibility UA: Chromium/${process.versions.chrome}`);
    if (tokens) {
      console.log("First-run tokens (store them now; only hashes are saved):");
      for (const [principal, token] of Object.entries(tokens)) {
        console.log(`${principal}: ${token}`);
      }
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow(config);
    });
  } catch (error) {
    console.error(error);
    app.quit();
  }
});

app.on("before-quit", async () => {
  controller?.close();
  if (api) await api.close().catch(() => undefined);
});

app.on("window-all-closed", () => {
  app.quit();
});
