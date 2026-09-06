import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  session,
  WebContentsView,
} from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AuditLog } from "./audit.mjs";
import {
  openChromeSessionBridge,
  openInChrome,
} from "./browser/chrome-launcher.mjs";
import { importSunoAuthCookies } from "./browser/auth-bridge.mjs";
import { BrowserController } from "./browser/controller.mjs";
import { readSunoCookiesFromChrome } from "./browser/chrome-cdp.mjs";
import { ContributionPopupRouter } from "./browser/popup-router.mjs";
import { classifyExternalAuthUrl } from "./browser/external-auth.mjs";
import { createSpaceManager, DEFAULT_SPACE_ID } from "./browser/space-manager.mjs";
import { createTabOwnership } from "./browser/tab-ownership.mjs";
import {
  assertNoElectronBrand,
  buildChromiumUserAgent,
} from "./browser/user-agent.mjs";
import { defaultRuntimeDir, loadConfig } from "./config.mjs";
import { VERSION } from "./constants.mjs";
import { HumanPacedExecutor } from "./executor/human-paced.mjs";
import { detectChromeProfiles } from "./profile/chrome-profile-detector.mjs";
import {
  createManifestStore,
  listMigrationOffers,
  recoverPendingMigrations,
  rollbackLoginMigration,
  runLoginMigration,
} from "./profile/profile-migrator.mjs";
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
let pendingExternalAuth = null;
let lastAutoOpenedExternalAuth = null;
const migrationManifests = createManifestStore(path.join(runtimeDir, "migration"));
let spaceManager;
let defaultSpace;
let browsingSession;
let tabOwnership;

function startupErrorMessage(error) {
  if (error?.code === "EADDRINUSE") {
    return "本地 daemon 端口已被占用。请先确认 Agent Browser Local 是否已经运行；不要重复启动第二个实例。";
  }
  return String(error?.message || error || "未知启动错误").slice(0, 1200);
}

function externalAuthReason(provider) {
  if (provider === "google") {
    return "Google 登录已转到 Chrome。完成后点“同步认证”，只把 Suno 会话带回本窗口；同步前 Agent 保持冻结。";
  }
  return "Suno 登录已转到 Chrome。完成后点“同步认证”，只把 Suno 会话带回本窗口；同步前 Agent 保持冻结。";
}

function setExternalAuthHandoff(auth) {
  pendingExternalAuth = auth;
  controller?.setHandoff(externalAuthReason(auth.provider), {
    code: "external_auth_required",
    provider: auth.provider,
    displayUrl: auth.displayUrl,
    externalBrowser: "Chrome",
  });
}

async function openPendingExternalAuth({ auto = false } = {}) {
  if (!pendingExternalAuth) {
    throw new Error("当前没有等待外部浏览器认证的页面");
  }
  const auth = pendingExternalAuth;
  if (
    auto &&
    lastAutoOpenedExternalAuth?.url === auth.url &&
    Date.now() - lastAutoOpenedExternalAuth.at < 2500
  ) {
    return {
      opened: false,
      provider: auth.provider,
      displayUrl: auth.displayUrl,
      deduplicated: true,
    };
  }
  if (auto) lastAutoOpenedExternalAuth = { url: auth.url, at: Date.now() };
  try {
    const launch = await openInChrome(auth.url);
    return {
      opened: true,
      provider: auth.provider,
      displayUrl: auth.displayUrl,
      browser: launch.browser,
    };
  } catch (error) {
    controller?.setHandoff(
      "无法自动打开系统 Chrome。请手动打开 Chrome，再访问登录页完成认证。",
      {
        code: "external_auth_open_failed",
        provider: auth.provider,
        displayUrl: auth.displayUrl,
        error: String(error?.message || error).slice(0, 240),
      },
    );
    throw error;
  }
}

async function syncPendingExternalAuth() {
  if (!pendingExternalAuth) {
    throw new Error("当前没有等待同步的外部认证");
  }
  if (pendingExternalAuth.provider !== "google" && pendingExternalAuth.provider !== "suno") {
    throw new Error("当前认证来源不支持 Suno 会话同步");
  }
  const endpoint = process.env.ABL_CHROME_CDP_URL || "http://127.0.0.1:9222";
  const { targetUrl, cookies } = await readSunoCookiesFromChrome({ endpoint });
  const imported = await importSunoAuthCookies({
    cookies,
    cookieStore: browsingSession.cookies,
  });
  controller?.setHandoff(
    `已同步 ${imported.count} 项 Suno 会话资料。页面正在刷新；确认已回到已登录页面后，再点击“交还 Agent”。`,
    {
      code: "external_auth_synced",
      provider: pendingExternalAuth.provider,
      targetUrl,
      importedCookies: imported.count,
    },
  );
  await controller?.reload();
  return { ...imported, targetUrl };
}

function handleExternalAuthNavigation(url, { event, childWindow } = {}) {
  const auth = classifyExternalAuthUrl(url);
  if (!auth) return false;
  event?.preventDefault?.();
  childWindow?.close?.();
  setExternalAuthHandoff(auth);
  void openPendingExternalAuth({ auto: true }).catch(() => undefined);
  return true;
}

function resetExternalAuthState() {
  pendingExternalAuth = null;
  lastAutoOpenedExternalAuth = null;
}

function installApplicationMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
        ],
      },
      {
        label: "Edit",
        submenu: [
          { role: "undo" },
          { role: "redo" },
          { type: "separator" },
          { role: "cut" },
          { role: "copy" },
          { role: "paste" },
          { role: "pasteAndMatchStyle" },
          { role: "delete" },
          { role: "selectAll" },
        ],
      },
      {
        label: "Window",
        submenu: [
          { role: "minimize" },
          { role: "zoom" },
          { type: "separator" },
          { role: "close" },
        ],
      },
    ]),
  );
}

function hardenUntrustedWebContents(webContents) {
  webContents.setUserAgent(browserUserAgent);
  webContents.on("will-navigate", (event, url) => {
    handleExternalAuthNavigation(url, { event });
  });
  webContents.on("context-menu", (_event, params) => {
    const items = [];
    if (params.isEditable) {
      items.push(
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { type: "separator" },
        { role: "selectAll" },
      );
    } else if (params.selectionText) {
      items.push({ role: "copy" });
    }
    if (items.length > 0) {
      Menu.buildFromTemplate(items).popup();
    }
  });
  egressPolicy.register(webContents);
  webContents.setWindowOpenHandler(({ url }) => {
    if (handleExternalAuthNavigation(url)) return { action: "deny" };
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
      if (handleExternalAuthNavigation(url, { event, childWindow })) return;
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
        const toolbar = document.querySelector(".toolbar")?.getBoundingClientRect();
        const handoff = document.querySelector("#handoff");
        const handoffRect = handoff?.getBoundingClientRect();
        const result = {
          state: document.querySelector("#agent-state")?.textContent || "",
          handoffHidden: handoff?.hidden,
          handoffDisabled: handoff?.disabled,
          handoffText: handoff?.textContent || "",
          handoffInToolbar: Boolean(
            toolbar && handoffRect &&
            handoffRect.width > 0 && handoffRect.height > 0 &&
            handoffRect.left >= toolbar.left &&
            handoffRect.right <= toolbar.right &&
            handoffRect.top >= toolbar.top &&
            handoffRect.bottom <= toolbar.bottom
          )
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

async function verifyMigrationPanelOpensInSmoke() {
  const panelOpened = await mainWindow.webContents.executeJavaScript(
    `new Promise((resolve) => {
      const toolbar = document.querySelector(".toolbar")?.getBoundingClientRect();
      const toggle = document.querySelector("#migration-toggle");
      const toggleRect = toggle?.getBoundingClientRect();
      toggle?.click();
      setTimeout(() => {
        const panel = document.querySelector("#migration-panel");
        resolve(Boolean(
          toolbar && toggle && toggleRect && !toggle.disabled &&
          toggleRect.width > 0 && toggleRect.height > 0 &&
          toggleRect.left >= toolbar.left && toggleRect.right <= toolbar.right &&
          panel && !panel.hidden
        ));
      }, 25);
    })`,
  );
  const pageHidden = contentView.getVisible() === false;
  await mainWindow.webContents.executeJavaScript(
    `document.querySelector("#migration-close")?.click()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  return panelOpened && pageHidden && contentView.getVisible() === true;
}

async function createWindow(config) {
  browsingSession.setUserAgent(
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
      // Agent 浏览会话运行在默认 Space 的持久化 partition 中，
      // 与 Electron defaultSession 及其他 Space 结构性隔离。
      partition: `persist:${defaultSpace.partition}`,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      safeDialogs: true,
    },
  });
  tabOwnership.bind(contentView.webContents.id, defaultSpace.id);
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
    browserSession: browsingSession,
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
    "Boolean(window.agentBrowser && typeof window.agentBrowser.status === 'function' && typeof window.agentBrowser.requestHandoff === 'function' && typeof window.agentBrowser.clearHandoff === 'function')",
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
    ? toolbarReady.state.startsWith("需要你接管：") &&
      toolbarReady.handoffHidden === false &&
      toolbarReady.handoffDisabled === false &&
      toolbarReady.handoffText === "交还 Agent" &&
      toolbarReady.handoffInToolbar === true
    : toolbarReady.state === "本地 daemon 启动中" &&
      toolbarReady.handoffHidden === false &&
      toolbarReady.handoffDisabled === true &&
      toolbarReady.handoffText === "Agent 未就绪" &&
      toolbarReady.handoffInToolbar === true;
  if (!expectedStateRendered) {
    throw new Error("安全工具栏初始化失败：启动状态未渲染");
  }
  if (
    process.env.ABL_SMOKE_HEADLESS === "1" &&
    !(await verifyMigrationPanelOpensInSmoke())
  ) {
    throw new Error("安全工具栏初始化失败：迁移登录态按钮未能立即打开向导");
  }

  if (process.env.ACL_DEVTOOLS === "1") {
    mainWindow.webContents.openDevTools({ mode: "detach" });
  }
}

function installIpc() {
  ipcMain.handle("browser:status", () => runtimeState());
  ipcMain.handle("browser:navigate", (_event, url) => {
    resetExternalAuthState();
    return controller.navigate(url);
  });
  ipcMain.handle("browser:back", () => {
    resetExternalAuthState();
    return controller.back();
  });
  ipcMain.handle("browser:forward", () => {
    resetExternalAuthState();
    return controller.forward();
  });
  ipcMain.handle("browser:reload", () => controller.reload());
  ipcMain.handle("browser:recover", () => controller.reload());
  ipcMain.handle("browser:open-external-auth", () => openPendingExternalAuth());
  ipcMain.handle("browser:sync-external-auth", () => syncPendingExternalAuth());
  ipcMain.handle("browser:request-user-handoff", () =>
    controller.setHandoff("用户已主动接管，Agent 自动化已暂停。", {
      code: "user_takeover",
    }),
  );
  ipcMain.handle("browser:clear-handoff", () => {
    resetExternalAuthState();
    return controller.clearHandoff();
  });
  // 迁移向导：仅由用户在 UI 中显式触发；daemon/Agent 没有任何调用路径。
  ipcMain.handle("migration:detect", () => detectChromeProfiles());
  ipcMain.handle("migration:offers", () => listMigrationOffers());
  ipcMain.handle("migration:spaces", () => spaceManager.listSpaces());
  ipcMain.handle("migration:open-bridge", () =>
    openChromeSessionBridge({
      endpoint: process.env.ABL_CHROME_CDP_URL || "http://127.0.0.1:9222",
      profileDir: path.join(runtimeDir, "chrome-session-bridge"),
    }),
  );
  ipcMain.handle("migration:set-open", (_event, open) => {
    // WebContentsView is composited above BrowserWindow HTML. Hide it while
    // the trusted toolbar migration panel is open, otherwise the panel exists
    // in the DOM but is visually covered by the page below y=64.
    contentView?.setVisible(!Boolean(open));
    return { open: Boolean(open) };
  });
  ipcMain.handle("migration:run", (_event, selectedDomains) =>
    runLoginMigration({
      selectedDomains,
      cookieStore: browsingSession.cookies,
      manifestStore: migrationManifests,
      space: defaultSpace,
    }),
  );
  ipcMain.handle("migration:rollback", (_event, migrationId) =>
    rollbackLoginMigration({
      migrationId: typeof migrationId === "string" ? migrationId : undefined,
      cookieStore: browsingSession.cookies,
      manifestStore: migrationManifests,
    }),
  );
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
      spaceManager = createSpaceManager({
        spacesDir: path.join(runtimeDir, "spaces"),
        sessionFactory: (name) => session.fromPartition(name),
      });
      await spaceManager.ensureDefaultSpace();
      defaultSpace = await spaceManager.getSpace(DEFAULT_SPACE_ID);
      browsingSession = spaceManager.sessionFor(defaultSpace);
      tabOwnership = createTabOwnership({ defaultSpaceId: defaultSpace.id });
      // 启动恢复：清理崩溃/回滚失败残留的待清理 Cookie（仅 manifest 列出的条目）。
      try {
        const recovery = await recoverPendingMigrations({
          cookieStore: browsingSession.cookies,
          manifestStore: migrationManifests,
        });
        if (recovery.entries > 0) {
          console.warn(
            `Migration recovery: ${recovery.entries} pending record(s), removed ${recovery.removed}, failed ${recovery.failed}`,
          );
        }
      } catch (error) {
        console.warn(
          `Migration recovery failed: ${String(error?.message || error).slice(0, 200)}`,
        );
      }
      installApplicationMenu();
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
          toolbarRunning.handoffHidden === false &&
          toolbarRunning.handoffDisabled === false &&
          toolbarRunning.handoffText === "交还 Agent" &&
          toolbarRunning.handoffInToolbar === true
        : toolbarRunning.state.includes(`v${VERSION}`) &&
          toolbarRunning.handoffHidden === false &&
          toolbarRunning.handoffDisabled === false &&
          toolbarRunning.handoffText === "我要接管" &&
          toolbarRunning.handoffInToolbar === true;
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
