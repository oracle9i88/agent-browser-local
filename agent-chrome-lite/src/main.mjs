import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  WebContentsView,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuditLog } from "./audit.mjs";
import { BrowserController } from "./browser/controller.mjs";
import { ContributionPopupRouter } from "./browser/popup-router.mjs";
import {
  assertNoElectronBrand,
  buildChromiumUserAgent,
} from "./browser/user-agent.mjs";
import { defaultRuntimeDir, loadConfig } from "./config.mjs";
import { VERSION } from "./constants.mjs";
import { HumanPacedExecutor } from "./executor/human-paced.mjs";
import { BrowserDaemon } from "./server/daemon.mjs";
import { createApiServer } from "./server/http-server.mjs";
import { installNetworkEgressPolicy } from "./security/network-egress.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const runtimeDir = defaultRuntimeDir();
const browserUserAgent = assertNoElectronBrand(buildChromiumUserAgent());
app.setName("Agent Browser Local");
app.userAgentFallback = browserUserAgent;
app.setPath(
  "userData",
  process.env.ABL_PROFILE_DIR || path.join(runtimeDir, "profile"),
);
const singleInstance = app.requestSingleInstanceLock();

let mainWindow;
let contentView;
let controller;
let api;
let egressPolicy;
let daemonReady = false;
let popupRouter;

function startupErrorMessage(error) {
  if (error?.code === "EADDRINUSE") {
    return "本地 daemon 端口已被占用。请先确认 Agent Browser Local 是否已经运行；不要重复启动第二个实例。";
  }
  return String(error?.message || error || "未知启动错误").slice(0, 1200);
}

function hardenUntrustedWebContents(webContents) {
  webContents.setUserAgent(browserUserAgent);
  egressPolicy.register(webContents);
  webContents.setWindowOpenHandler(({ url }) => {
    if (popupRouter?.route(url)) return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        autoHideMenuBar: true,
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
          allowRunningInsecureContent: false,
          safeDialogs: true,
        },
      },
    };
  });
  webContents.on("did-create-window", (childWindow) => {
    hardenUntrustedWebContents(childWindow.webContents);
    const routeChild = (event, url) => {
      if (!popupRouter?.route(url, { close: () => childWindow.close() })) return;
      event?.preventDefault?.();
    };
    childWindow.webContents.on("will-navigate", routeChild);
    childWindow.webContents.on("did-navigate", (event, url) => routeChild(event, url));
  });
}

function layoutContent() {
  if (!mainWindow || !contentView) return;
  const [width, height] = mainWindow.getContentSize();
  contentView.setBounds({ x: 0, y: 64, width, height: Math.max(0, height - 64) });
}

function sendState() {
  if (!mainWindow?.isDestroyed() && controller) {
    mainWindow.webContents.send("browser:state", runtimeState());
  }
}

function runtimeState() {
  return {
    ...controller.status(),
    daemon: {
      ready: daemonReady,
      binding: "loopback-only",
    },
    version: VERSION,
  };
}

async function waitForToolbarChange(previousState) {
  return mainWindow.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const startedAt = Date.now();
      const inspect = () => {
        const result = {
          state: document.querySelector("#agent-state")?.textContent || "",
          handoffHidden: document.querySelector("#handoff")?.hidden
        };
        if (result.state !== ${JSON.stringify(previousState)} || Date.now() - startedAt >= 1000) {
          resolve(result);
          return;
        }
        setTimeout(inspect, 25);
      };
      inspect();
    })`,
  );
}

async function createWindow(config) {
  session.defaultSession.setUserAgent(
    browserUserAgent,
    "zh-CN,zh;q=0.9,en;q=0.8",
  );
  mainWindow = new BrowserWindow({
    show: process.env.ABL_SMOKE_HEADLESS !== "1",
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 620,
    title: "Agent Browser Local",
    backgroundColor: "#111318",
    webPreferences: {
      preload: path.join(sourceDir, "preload.cjs"),
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
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
    },
  });
  mainWindow.contentView.addChildView(contentView);
  mainWindow.on("resize", layoutContent);
  layoutContent();

  controller = new BrowserController(contentView.webContents, config);
  popupRouter = new ContributionPopupRouter(config, {
    navigate: (url) => controller.navigate(url),
    onRouted: sendState,
    onError: () => {
      controller.setHandoff(
        "投稿编辑器弹窗接回主窗口失败，自动化已冻结，等待用户决定。",
        { code: "contribution_popup_route_failed" },
      );
    },
  });
  egressPolicy = installNetworkEgressPolicy({
    browserSession: session.defaultSession,
    config,
    onBlocked: (decision, details) => {
      console.warn(
        `Blocked untrusted page request: ${decision.code} (${details.resourceType})`,
      );
      if (details.resourceType === "mainFrame") {
        controller.setHandoff(decision.reason, {
          code: "unsafe_page_request",
          policyCode: decision.code,
        });
      }
    },
    onMainFrameEscape: (decision) => {
      controller.setHandoff(decision.reason, { code: decision.code });
    },
  });
  hardenUntrustedWebContents(contentView.webContents);
  controller.on("state", sendState);
  controller.on("handoff", sendState);

  await mainWindow.loadFile(path.join(sourceDir, "ui", "index.html"));
  const bridgeReady = await mainWindow.webContents.executeJavaScript(
    "Boolean(window.agentBrowser && typeof window.agentBrowser.status === 'function' && typeof window.agentBrowser.clearHandoff === 'function')",
  );
  if (!bridgeReady) {
    throw new Error("安全工具栏初始化失败：preload IPC bridge 不可用");
  }
  await controller.initialize();
  await controller.navigate(config.browser.startUrl || "about:blank");
  sendState();
  const expectedHandoff = Boolean(controller.status().handoff?.required);
  const toolbarReady = await waitForToolbarChange("本地安全模式");
  const expectedStateRendered = expectedHandoff
    ? toolbarReady.state.startsWith("需要你接管：") && toolbarReady.handoffHidden === false
    : toolbarReady.state === "本地 daemon 启动中" && toolbarReady.handoffHidden === true;
  if (!expectedStateRendered) {
    throw new Error("安全工具栏初始化失败：启动状态未渲染");
  }

  if (process.env.ACL_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function installIpc() {
  ipcMain.handle("browser:status", () => runtimeState());
  ipcMain.handle("browser:navigate", (_event, url) => controller.navigate(url));
  ipcMain.handle("browser:back", () => controller.back());
  ipcMain.handle("browser:forward", () => controller.forward());
  ipcMain.handle("browser:reload", () => controller.reload());
  ipcMain.handle("browser:recover", () => controller.reload());
  ipcMain.handle("browser:clear-handoff", () => controller.clearHandoff());
}

if (!singleInstance) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    try {
      const { config, configPath, tokens } = await loadConfig();
      installIpc();
      await createWindow(config);

      const executor = new HumanPacedExecutor({
        minDelayMs: config.security.minActionDelayMs,
        maxDelayMs: config.security.maxActionDelayMs,
      });
      const audit = new AuditLog(path.join(runtimeDir, "audit", "events.jsonl"));
      const daemon = new BrowserDaemon({ controller, config, executor, audit });
      api = createApiServer({ daemon, config, controller });
      const toolbarBeforeReady = await mainWindow.webContents.executeJavaScript(
        'document.querySelector("#agent-state")?.textContent || ""',
      );
      await api.listen();
      daemonReady = true;
      sendState();
      const toolbarRunning = await waitForToolbarChange(toolbarBeforeReady);
      const runningHandoff = Boolean(controller.status().handoff?.required);
      const runningStateRendered = runningHandoff
        ? toolbarRunning.state.startsWith("需要你接管：") &&
          toolbarRunning.handoffHidden === false
        : toolbarRunning.state.includes(`v${VERSION}`) &&
          toolbarRunning.handoffHidden === true;
      if (!runningStateRendered) {
        throw new Error("安全工具栏初始化失败：daemon 就绪状态未渲染");
      }

      console.log(`Agent Browser Local listening on http://${config.server.host}:${config.server.port}`);
      console.log(`Config: ${configPath}`);
      console.log(`Compatibility UA: Chromium/${process.versions.chrome}`);
      if (tokens) {
        console.log("First-run tokens (store them now; only hashes are saved):");
        for (const [principal, token] of Object.entries(tokens)) {
          console.log(`${principal}: ${token}`);
        }
      }

      const smokeExitMs = Number.parseInt(
        process.env.ABL_SMOKE_EXIT_MS || "",
        10,
      );
      if (Number.isFinite(smokeExitMs) && smokeExitMs > 0) {
        setTimeout(() => app.quit(), smokeExitMs).unref();
      }

      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow(config);
      });
    } catch (error) {
      console.error(error);
      if (app.isReady()) {
        dialog.showErrorBox(
          "Agent Browser Local 无法启动",
          startupErrorMessage(error),
        );
      }
      app.quit();
    }
  });
}

app.on("before-quit", async () => {
  daemonReady = false;
  popupRouter = null;
  controller?.close();
  if (api) await api.close().catch(() => undefined);
});

app.on("window-all-closed", () => {
  app.quit();
});
