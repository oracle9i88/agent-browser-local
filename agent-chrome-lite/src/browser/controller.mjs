import { EventEmitter } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { CdpSession } from "./cdp-session.mjs";
import {
  isMainFrameLoadFailure,
  PageHealthState,
} from "./page-health.mjs";
import {
  readNodeMetadata,
  resolveEditableFromSemanticHint,
  SnapshotStore,
} from "./snapshot.mjs";
import { CaptureStore, sanitizeCaptureLabel } from "./capture-store.mjs";
import { isContributionUrlAllowed } from "../security/contribution-policy.mjs";
import { isXimalayaUploadShell, locateXimalayaPublish } from "./ximalaya-publish.mjs";

const DEFAULT_DOWNLOADS_DIR = path.join(os.homedir(), "Downloads");
const DOWNLOAD_PERMIT_TTL_MS = 15_000;

export function isSunoStudioUrl(value) {
  try {
    const url = new URL(value);
    return (
      url.origin === "https://suno.com" &&
      (url.pathname === "/studio" || url.pathname.startsWith("/studio/"))
    );
  } catch {
    return false;
  }
}

export function isMiniMaxMusicUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === "https://www.minimax.cn" && url.pathname === "/audio/music";
  } catch {
    return false;
  }
}

export function isMiniMaxMusicDownload(urlValue, filename) {
  try {
    const url = new URL(urlValue);
    return url.origin === "https://cdn.hailuoai.com" &&
      /^\/prod\/[^/]+\/moss-audio\/user_music\/[^/]+\.mp3$/.test(url.pathname) &&
      url.searchParams.get("download") === "1" &&
      /_no-watermark\.mp3$/i.test(String(filename || ""));
  } catch {
    return false;
  }
}

export function sanitizeDownloadFilename(input) {
  const base = path.basename(String(input || "").replaceAll("\\", "/"));
  const extension = path.extname(base).slice(0, 16);
  const stem = base.slice(0, Math.max(0, base.length - extension.length));
  const safeStem = sanitizeCaptureLabel(stem).slice(0, 96) || "download";
  const safeExtension = /^\.[A-Za-z0-9]{1,15}$/.test(extension) ? extension : "";
  return `${safeStem}${safeExtension}`;
}

export function availableDownloadPath(directory, filename, pathExists = existsSync) {
  const parsed = path.parse(filename);
  for (let index = 1; index <= 999; index += 1) {
    const suffix = index === 1 ? "" : ` (${index})`;
    const candidate = path.join(directory, `${parsed.name}${suffix}${parsed.ext}`);
    if (!pathExists(candidate)) return candidate;
  }
  throw new Error("download_name_exhausted");
}

function parseAnchor(anchor) {
  // anchor 形如 { kind: "coords", x: 0.9, y: 0.5 }
  // 本项目禁止任意 JS evaluate / CSS selector 接口，所以只接坐标锚点。
  // 留 kind 是为未来 extension 协议占位；非 coords 一律拒绝。
  if (!anchor || typeof anchor !== "object") return null;
  if (anchor.kind && anchor.kind !== "coords") {
    throw new Error(
      "Scroll anchor must be coordinates (kind='coords'); CSS/XPath selectors are not allowed",
    );
  }
  const x = Number(anchor.x);
  const y = Number(anchor.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.min(1, Math.max(0, x)),
    y: Math.min(1, Math.max(0, y)),
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function screenshotDigest(dataBase64) {
  return createHash("sha256").update(String(dataBase64 || ""), "base64").digest("hex");
}

export async function waitForNavigationQuiet({
  isLoading,
  lastActivityAt,
  quietMs = 2500,
  timeoutMs = 10_000,
  now = Date.now,
  wait = delay,
}) {
  const startedAt = now();
  while (now() - startedAt < timeoutMs) {
    if (!isLoading() && now() - lastActivityAt() >= quietMs) return true;
    await wait(100);
  }
  return false;
}

export function isExpectedNavigationAbort(error) {
  return (
    error?.code === "ERR_ABORTED" ||
    error?.errno === -3 ||
    /\bERR_ABORTED\b/.test(String(error?.message || ""))
  );
}

export function contributionScopeTransition(config, url, handoff) {
  if (!isContributionUrlAllowed(config, url)) return "handoff";
  return "unchanged";
}

function normalizeUrl(input, { allowFileUrls = false } = {}) {
  const raw = String(input || "").trim();
  if (raw === "about:blank") return raw;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  const allowed = new Set(["http:", "https:"]);
  if (allowFileUrls) allowed.add("file:");
  if (!allowed.has(parsed.protocol)) {
    throw new Error("Only http(s) navigation is allowed");
  }
  return parsed.href;
}

function safeFaultUrl(value) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "";
  }
}

function pointFromQuads(quads) {
  const quad = quads?.[0];
  if (!Array.isArray(quad) || quad.length < 8) return null;
  return {
    x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
    y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4,
  };
}

export function boundedScrollDelta({ direction, amount, viewportHeight }) {
  const height = Math.max(1, Number(viewportHeight) || 1);
  const distance = amount === "small"
    ? Math.min(280, Math.max(120, Math.round(height * 0.3)))
    : Math.min(720, Math.max(320, Math.round(height * 0.8)));
  return direction === "up" ? -distance : distance;
}

export function documentEndState({ pageY, viewportHeight, contentHeight }) {
  const viewport = Math.max(1, Number(viewportHeight) || 1);
  const content = Math.max(viewport, Number(contentHeight) || viewport);
  const scrollable = content > viewport + 2;
  return {
    scrollable,
    reachedEnd:
      scrollable &&
      Math.max(0, Number(pageY) || 0) + viewport >= content - 2,
  };
}

export function namedVisualAxNode(nodes = []) {
  const named = nodes.filter((node) => String(node?.name?.value || "").trim());
  return (
    named.find((node) =>
      /button|link|menuitem|checkbox|radio|switch/i.test(
        String(node?.role?.value || ""),
      ),
    ) || named[0]
  );
}

export class BrowserController extends EventEmitter {
  constructor(
    webContents,
    config,
    { allowFileUrls = false, capturesDir, downloadsDir } = {},
  ) {
    super();
    this.webContents = webContents;
    this.config = config;
    this.allowFileUrls = allowFileUrls;
    this.pageHealth = new PageHealthState();
    this.cdp = new CdpSession(webContents, {
      onFault: (error) => {
        this.failPage("cdp_command_timeout", error.detail || {});
      },
    });
    this.snapshotStore = new SnapshotStore({
      maxControls: config.security.maxSnapshotControls,
      maxHints: config.security.maxSnapshotHints,
    });
    this.screenshotState = null;
    this.ximalayaPublishAttempted = false;
    this.handoff = null;
    this.lastNavigationActivityAt = Date.now();

    const runtimeDir =
      capturesDir || path.join(os.homedir(), ".agent-browser-local", "captures");
    this.captureStore = new CaptureStore(runtimeDir);
    this.downloadsDir = downloadsDir || DEFAULT_DOWNLOADS_DIR;
    this.downloads = new Map(); // downloadId → record
    this.downloadCounter = 0;
    this.sunoDownloadPermit = null;
    this.sunoDownloadPermitTimer = null;
    this.miniMaxDownloadPermit = null;
    this.miniMaxDownloadPermitTimer = null;

    const reconcileContributionScope = (url) => {
      const transition = contributionScopeTransition(
        this.config,
        url,
        this.handoff,
      );
      if (transition === "handoff") {
        this.setHandoff("当前页面需要用户本人完成登录、验证或人工导航。", {
          code: "outside_contribution_scope",
        });
      }
    };

    webContents.on("did-navigate", (_event, url) => {
      this.lastNavigationActivityAt = Date.now();
      if (!isXimalayaUploadShell(url)) this.ximalayaPublishAttempted = false;
      this.invalidate();
      reconcileContributionScope(url);
    });
    webContents.on("did-navigate-in-page", (_event, url) => {
      this.lastNavigationActivityAt = Date.now();
      if (!isXimalayaUploadShell(url)) this.ximalayaPublishAttempted = false;
      this.invalidate();
      reconcileContributionScope(url);
    });
    webContents.on("dom-ready", () => {
      this.lastNavigationActivityAt = Date.now();
      this.invalidate();
    });
    webContents.on("page-title-updated", () => this.emitState());
    webContents.on("render-process-gone", (_event, detail = {}) => {
      this.failPage("renderer_gone", {
        reason: detail.reason,
        exitCode: detail.exitCode,
      });
    });
    webContents.on("unresponsive", () => {
      this.failPage("page_unresponsive");
    });
    webContents.on("responsive", () => {
      this.recoverPage();
    });
    webContents.on(
      "did-fail-load",
      (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
        if (!isMainFrameLoadFailure({ errorCode, isMainFrame })) return;
        this.failPage("main_frame_load_failed", {
          errorCode,
          errorDescription,
          url: safeFaultUrl(validatedURL),
        });
      },
    );
    webContents.on("did-finish-load", () => {
      this.recoverPage();
    });

    // 接管 session 下载事件。经审计放行的 Suno Studio Multitrack
    // 走普通 download，
    // 默认会弹系统保存对话框。改写 setSavePath 直接写到 ~/Downloads。
    // Browser.downloadWillBegin / Browser.downloadProgress 由 session 层的
    // 'will-download' 事件触发（Electron 不直接转 CDP 事件）。
    // 部分单元测试用裸 EventEmitter 模拟 webContents，没有 .session 接口，
    // 这里做防御性检查。
    if (webContents.session && typeof webContents.session.on === "function") {
      webContents.session.on("will-download", (_event, item, sourceContents) => {
        this.handleWillDownload(item, sourceContents).catch(() => undefined);
      });
    }
  }

  armSunoDownload({ principal, ttlMs = DOWNLOAD_PERMIT_TTL_MS } = {}) {
    const pageUrl = this.webContents.getURL();
    if (!isSunoStudioUrl(pageUrl)) {
      const error = new Error("Suno downloads can only be armed from Suno Studio");
      error.code = "suno_studio_required";
      throw error;
    }
    const permit = {
      permitId: randomUUID(),
      principal: String(principal || ""),
      pageUrl,
      expiresAt: Date.now() + Math.max(1_000, Math.min(30_000, Number(ttlMs) || DOWNLOAD_PERMIT_TTL_MS)),
    };
    if (this.sunoDownloadPermitTimer) clearTimeout(this.sunoDownloadPermitTimer);
    this.sunoDownloadPermit = permit;
    this.sunoDownloadPermitTimer = setTimeout(() => {
      if (this.sunoDownloadPermit?.permitId === permit.permitId) {
        this.sunoDownloadPermit = null;
      }
      this.sunoDownloadPermitTimer = null;
    }, permit.expiresAt - Date.now());
    this.sunoDownloadPermitTimer.unref?.();
    return { permitId: permit.permitId, expiresAt: permit.expiresAt };
  }

  disarmSunoDownload(permitId) {
    if (!permitId || this.sunoDownloadPermit?.permitId === permitId) {
      this.sunoDownloadPermit = null;
      if (this.sunoDownloadPermitTimer) clearTimeout(this.sunoDownloadPermitTimer);
      this.sunoDownloadPermitTimer = null;
    }
  }

  consumeSunoDownloadPermit(sourceContents) {
    const permit = this.sunoDownloadPermit;
    this.sunoDownloadPermit = null;
    if (this.sunoDownloadPermitTimer) clearTimeout(this.sunoDownloadPermitTimer);
    this.sunoDownloadPermitTimer = null;
    if (!permit || permit.expiresAt < Date.now()) return null;
    if (
      !isSunoStudioUrl(this.webContents.getURL()) ||
      this.webContents.getURL() !== permit.pageUrl
    ) return null;
    if (
      !sourceContents ||
      this.webContents?.id == null ||
      sourceContents.id !== this.webContents.id
    ) {
      return null;
    }
    return permit;
  }

  armMiniMaxDownload({ principal, ttlMs = DOWNLOAD_PERMIT_TTL_MS } = {}) {
    const pageUrl = this.webContents.getURL();
    if (!isMiniMaxMusicUrl(pageUrl)) {
      const error = new Error("MiniMax downloads can only be armed from the music page");
      error.code = "minimax_music_required";
      throw error;
    }
    const permit = {
      permitId: randomUUID(),
      principal: String(principal || ""),
      pageUrl,
      expiresAt: Date.now() + Math.max(1_000, Math.min(30_000, Number(ttlMs) || DOWNLOAD_PERMIT_TTL_MS)),
    };
    this.disarmMiniMaxDownload();
    this.miniMaxDownloadPermit = permit;
    this.miniMaxDownloadPermitTimer = setTimeout(() => {
      this.disarmMiniMaxDownload(permit.permitId);
    }, permit.expiresAt - Date.now());
    this.miniMaxDownloadPermitTimer.unref?.();
    return { permitId: permit.permitId, expiresAt: permit.expiresAt };
  }

  disarmMiniMaxDownload(permitId) {
    if (permitId && this.miniMaxDownloadPermit?.permitId !== permitId) return;
    this.miniMaxDownloadPermit = null;
    if (this.miniMaxDownloadPermitTimer) clearTimeout(this.miniMaxDownloadPermitTimer);
    this.miniMaxDownloadPermitTimer = null;
  }

  consumeMiniMaxDownloadPermit(sourceContents, item) {
    const permit = this.miniMaxDownloadPermit;
    this.disarmMiniMaxDownload();
    if (!permit || permit.expiresAt < Date.now()) return null;
    if (!isMiniMaxMusicUrl(this.webContents.getURL()) ||
        this.webContents.getURL() !== permit.pageUrl ||
        !sourceContents || sourceContents.id !== this.webContents.id ||
        !isMiniMaxMusicDownload(item.getURL?.(), item.getFilename?.())) return null;
    return permit;
  }

  isPermittedMiniMaxDownloadRequest(url) {
    const permit = this.miniMaxDownloadPermit;
    if (!permit || permit.expiresAt < Date.now() ||
        !isMiniMaxMusicUrl(this.webContents.getURL()) ||
        this.webContents.getURL() !== permit.pageUrl) return false;
    try {
      const parsed = new URL(url);
      return isMiniMaxMusicDownload(url, parsed.searchParams.get("filename"));
    } catch {
      return false;
    }
  }

  async handleWillDownload(item, sourceContents) {
    const permit = isMiniMaxMusicUrl(this.webContents.getURL())
      ? this.consumeMiniMaxDownloadPermit(sourceContents, item)
      : this.consumeSunoDownloadPermit(sourceContents);
    // No audited, one-shot platform permit: leave Electron's normal human download
    // handling untouched. In particular, never silently choose a save path.
    if (!permit) return { handled: false };
    this.downloadCounter += 1;
    const downloadId = `dl_${this.downloadCounter}_${randomUUID().slice(0, 8)}`;
    const suggestedFilename = item.getFilename() || "";
    const safeName = sanitizeDownloadFilename(suggestedFilename);
    const savePath = availableDownloadPath(
      this.downloadsDir,
      safeName,
      (candidate) =>
        existsSync(candidate) ||
        [...this.downloads.values()].some(
          (record) => record.savePath === candidate && !record.finishedAt,
        ),
    );
    item.setSavePath(savePath);
    const record = {
      downloadId,
      filename: safeName,
      savePath,
      url: this.webContents.getURL(),
      state: "in_progress",
      receivedBytes: 0,
      totalBytes: -1,
      startedAt: Date.now(),
      finishedAt: null,
      error: null,
      permitId: permit.permitId,
      principal: permit.principal,
    };
    this.downloads.set(downloadId, record);
    this.emit("download", {
      event: "browser.download.started",
      principal: permit.principal,
      downloadId,
      filename: safeName,
    });
    item.on("updated", (_event, state) => {
      const current = this.downloads.get(downloadId);
      if (!current) return;
      current.state = state;
      current.receivedBytes = item.getReceivedBytes();
      current.totalBytes = item.getTotalBytes();
    });
    const finalize = (state, error = null) => {
      const current = this.downloads.get(downloadId);
      if (!current || current.finishedAt) return;
      current.state = state;
      current.receivedBytes = item.getReceivedBytes();
      current.totalBytes = item.getTotalBytes();
      current.finishedAt = Date.now();
      current.error = error;
    };
    item.once("done", (_event, state) => {
      // Electron reports the terminal state as the second `done` argument.
      // A successful completion is not an error; keeping the literal
      // "completed" in `error` makes callers treat a valid download as a
      // partial failure.
      finalize(
        state === "completed" ? "completed" : "failed",
        state === "completed" ? null : state,
      );
      this.emit("download", {
        event: state === "completed"
          ? "browser.download.completed"
          : "browser.download.failed",
        principal: permit.principal,
        downloadId,
        filename: safeName,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
      });
    });
    return { handled: true, downloadId };
  }

  async initialize() {
    if (!this.webContents.getURL()) {
      await this.webContents.loadURL("about:blank");
    }
    await this.cdp.attach();
  }

  invalidate() {
    this.snapshotStore.invalidate();
    this.screenshotState = null;
    this.emitState();
  }

  emitState() {
    this.emit("state", this.status());
  }

  status() {
    const currentUrl = this.webContents.getURL();
    return {
      title: this.webContents.getTitle(),
      url: currentUrl,
      loading: this.webContents.isLoading(),
      canGoBack: this.webContents.navigationHistory.canGoBack(),
      canGoForward: this.webContents.navigationHistory.canGoForward(),
      handoff: this.handoff,
      pageHealth: this.pageHealth.snapshot(),
    };
  }

  /**
   * 登录态探活：检查指定平台 requiredCookieNames 在对应域的 cookie store 中是否存在。
   * 只返回布尔与缺失名单，绝不回传 cookie 值。
   */
  async authCheck(spec) {
    const cookies = await this.webContents.session.cookies.get({});
    const present = new Set(
      cookies
        .filter((cookie) =>
          spec.domains.some((domain) => String(cookie.domain || "").includes(domain)),
        )
        .map((cookie) => cookie.name),
    );
    const missing = spec.requiredCookieNames.filter((name) => !present.has(name));
    return {
      checked: true,
      loggedIn: missing.length === 0,
      required: [...spec.requiredCookieNames],
      missing,
    };
  }

  /** 清空指定 origin 的前端存储（localStorage 等，保留 Cookie）。finalize 级运维操作。 */
  async clearSiteData(origin) {
    const parsed = new URL(String(origin || ""));
    if (parsed.protocol !== "https:" || !parsed.hostname) {
      throw new Error("clearSiteData requires an https origin");
    }
    await this.webContents.session.clearStorageData({
      origins: [`${parsed.origin}`],
      storages: ["localstorage", "serviceworkers", "cachestorage", "indexdb"],
    });
    return { cleared: parsed.origin, cookiesPreserved: true };
  }

  assertPageAvailable() {
    this.pageHealth.assertAvailable();
  }

  failPage(code, detail = {}) {
    const health = this.pageHealth.fail(code, detail);
    this.invalidate();
    this.setHandoff(
      "页面渲染发生故障，自动化已冻结；登录 Profile 保留，等待用户决定重新加载或重新导航。",
      {
        code: "page_unavailable",
        fault: health.fault,
      },
    );
    return health;
  }

  recoverPage() {
    const changed = this.pageHealth.recover();
    if (
      changed &&
      this.handoff?.detail?.code === "page_unavailable" &&
      isContributionUrlAllowed(this.config, this.webContents.getURL())
    ) {
      this.clearHandoff();
      return;
    }
    if (changed) this.emitState();
  }

  async navigate(url) {
    const target = normalizeUrl(url, { allowFileUrls: this.allowFileUrls });
    this.handoff = null;
    this.lastNavigationActivityAt = Date.now();
    try {
      await this.webContents.loadURL(target);
    } catch (error) {
      if (!isExpectedNavigationAbort(error)) throw error;
    }
    await waitForNavigationQuiet({
      isLoading: () => this.webContents.isLoading(),
      lastActivityAt: () => this.lastNavigationActivityAt,
    });
    return this.status();
  }

  async back() {
    if (this.webContents.navigationHistory.canGoBack()) {
      this.webContents.navigationHistory.goBack();
    }
    return this.status();
  }

  async forward() {
    if (this.webContents.navigationHistory.canGoForward()) {
      this.webContents.navigationHistory.goForward();
    }
    return this.status();
  }

  async reload() {
    this.webContents.reload();
    return this.status();
  }

  setHandoff(reason, detail = {}) {
    this.handoff = {
      required: true,
      reason,
      detail,
      at: new Date().toISOString(),
    };
    this.emit("handoff", this.handoff);
    this.emitState();
    return this.handoff;
  }

  clearHandoff() {
    this.handoff = null;
    this.emitState();
  }

  async snapshot() {
    this.assertPageAvailable();
    return this.snapshotStore.captureStable(this.cdp, {
      title: this.webContents.getTitle(),
      url: this.webContents.getURL(),
    });
  }

  resolveRef(ref) {
    this.assertPageAvailable();
    return this.snapshotStore.resolve(ref);
  }

  async screenshot() {
    this.assertPageAvailable();
    const [{ data }, metrics] = await Promise.all([
      this.cdp.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      }),
      this.cdp.send("Page.getLayoutMetrics"),
    ]);
    const viewport = metrics.cssVisualViewport || metrics.visualViewport;
    const screenshotId = randomUUID();
    this.screenshotState = {
      screenshotId,
      url: this.webContents.getURL(),
      width: Math.round(viewport?.clientWidth || 0),
      height: Math.round(viewport?.clientHeight || 0),
      createdAt: Date.now(),
    };
    return {
      ...this.screenshotState,
      mimeType: "image/png",
      dataBase64: data,
    };
  }

  async resolveVisualPoint(
    { screenshotId, x, y },
    { promoteEditable = false } = {},
  ) {
    this.assertPageAvailable();
    const state = this.screenshotState;
    if (
      !state ||
      state.screenshotId !== screenshotId ||
      state.url !== this.webContents.getURL() ||
      Date.now() - state.createdAt > 60_000
    ) {
      const error = new Error("Visual reference is stale; take a fresh screenshot");
      error.code = "stale_visual_ref";
      throw error;
    }
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > state.width ||
      y > state.height
    ) {
      throw new Error("Visual click point is outside the current viewport");
    }
    const hit = await this.cdp.send("DOM.getNodeForLocation", {
      x: Math.round(x),
      y: Math.round(y),
      includeUserAgentShadowDOM: true,
    });
    const hitBackendNodeId = hit.backendNodeId;
    if (!hitBackendNodeId) throw new Error("No DOM node exists at the visual point");
    // Only visual-fill needs to promote a rich-editor container to its
    // editable descendant. Doing this for ordinary/secondary clicks can turn
    // an unrelated canvas hit into the page's sole textarea, corrupting both
    // risk classification and audit attribution.
    const editable = promoteEditable
      ? await resolveEditableFromSemanticHint(
          this.cdp,
          hitBackendNodeId,
          "",
        ).catch(() => null)
      : null;
    const backendNodeId = editable?.backendNodeId || hitBackendNodeId;
    const metadata = editable?.metadata || await readNodeMetadata(this.cdp, backendNodeId);
    const ax = await this.cdp.send("Accessibility.getPartialAXTree", {
      backendNodeId,
      fetchRelatives: true,
    });
    const axNode = namedVisualAxNode(ax.nodes) || ax.nodes?.[0];
    const node = {
      ...metadata,
      role: axNode?.role?.value || metadata.role || "control",
      name:
        axNode?.name?.value ||
        metadata.ariaLabel ||
        metadata.placeholder ||
        metadata.title ||
        "",
    };
    return { backendNodeId, node, point: { x, y } };
  }

  resolveVisualAnchor(anchor) {
    this.assertPageAvailable();
    const state = this.screenshotState;
    if (
      !anchor ||
      anchor.kind !== "visual" ||
      !state ||
      state.screenshotId !== anchor.screenshotId ||
      state.url !== this.webContents.getURL() ||
      Date.now() - state.createdAt > 60_000
    ) {
      const error = new Error("Capture anchor is stale; take a fresh screenshot");
      error.code = "stale_visual_ref";
      throw error;
    }
    const x = Number(anchor.x);
    const y = Number(anchor.y);
    if (
      !Number.isFinite(x) ||
      !Number.isFinite(y) ||
      x < 0 ||
      y < 0 ||
      x > state.width ||
      y > state.height
    ) {
      const error = new Error("Capture anchor is outside the current screenshot");
      error.code = "invalid_visual_anchor";
      throw error;
    }
    return {
      x: state.width > 0 ? x / state.width : 0,
      y: state.height > 0 ? y / state.height : 0,
    };
  }

  async clickRef(ref, { mouseButton = "left" } = {}) {
    const { backendNodeId } = this.resolveRef(ref);
    await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    await delay(220);
    const { quads } = await this.cdp.send("DOM.getContentQuads", {
      backendNodeId,
    });
    const point = pointFromQuads(quads);
    if (!point) throw new Error("Target has no clickable viewport geometry");
    await this.clickPoint(point, { mouseButton });
    return { ok: true };
  }

  async clickVisual(point, { mouseButton = "left" } = {}) {
    await this.clickPoint(point, { mouseButton });
    return { ok: true };
  }

  async inspectXimalayaPublish() {
    this.assertPageAvailable();
    if (this.ximalayaPublishAttempted) {
      const error = new Error("Publication result is unverified; do not click again on this form");
      error.code = "ximalaya_publish_attempt_unverified";
      throw error;
    }
    const metrics = await this.cdp.send("Page.getLayoutMetrics");
    const visual = metrics.cssVisualViewport || metrics.cssLayoutViewport;
    const target = await locateXimalayaPublish(this.cdp, this.webContents.getURL(), {
      width: Number(visual?.clientWidth) || 0,
      height: Number(visual?.clientHeight) || 0,
    });
    return target;
  }

  async clickXimalayaPublish() {
    if (this.ximalayaPublishAttempted) {
      const error = new Error("Publication result is unverified; do not click again on this form");
      error.code = "ximalaya_publish_attempt_unverified";
      throw error;
    }
    // Resolve afresh inside the execution queue; never reuse stale iframe
    // coordinates across navigation, scroll, or another agent's action.
    const target = await this.inspectXimalayaPublish();
    this.ximalayaPublishAttempted = true;
    await this.clickPoint(target.childPoint, { sessionId: target.sessionId });
    return { ok: true, result: "click_dispatched_verify_publication" };
  }

  async scroll({ direction, amount, anchor }) {
    this.assertPageAvailable();
    const maxSteps = amount === "bottom" ? 12 : 1;
    const anchorPoint = parseAnchor(anchor); // throws on CSS/XPath, returns null otherwise
    let steps = 0;
    let totalDeltaY = 0;
    let reachedEnd = false;
    let documentScrollRangeObserved = false;
    let innerNoChangeCount = 0;
    const isInner = Boolean(anchorPoint);
    for (let index = 0; index < maxSteps; index += 1) {
      const metrics = await this.cdp.send("Page.getLayoutMetrics");
      const viewport = metrics.cssLayoutViewport || metrics.layoutViewport || {};
      const visual = metrics.cssVisualViewport || metrics.visualViewport || {};
      const content = metrics.cssContentSize || metrics.contentSize || {};
      const width = Math.max(1, Number(viewport.clientWidth) || 1);
      const height = Math.max(1, Number(viewport.clientHeight) || 1);
      const pageY = Math.max(0, Number(visual.pageY) || Number(viewport.pageY) || 0);
      const contentHeight = Math.max(height, Number(content.height) || height);
      const documentState = documentEndState({
        pageY,
        viewportHeight: height,
        contentHeight,
      });
      const documentScrollable = documentState.scrollable;
      documentScrollRangeObserved ||= documentScrollable;
      if (
        direction === "down" &&
        !isInner &&
        documentState.reachedEnd
      ) {
        reachedEnd = true;
        break;
      }
      const deltaY = boundedScrollDelta({
        direction,
        amount: amount === "bottom" ? "page" : amount,
        viewportHeight: height,
      });
      const anchorX = anchorPoint
        ? Math.round(width * anchorPoint.x)
        : Math.round(width * 0.9);
      const anchorY = anchorPoint
        ? Math.round(height * anchorPoint.y)
        : Math.round(height / 2);
      const beforeDigest = isInner
        ? screenshotDigest((await this.cdp.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: false,
          })).data)
        : null;
      await this.cdp.send("Input.dispatchMouseEvent", {
        type: "mouseWheel",
        x: anchorX,
        y: anchorY,
        deltaX: 0,
        deltaY,
      });
      steps += 1;
      totalDeltaY += deltaY;
      await delay(
        amount === "bottom"
          ? 420 + Math.floor(Math.random() * 260)
          : 180,
      );

      // 内层容器不会改变顶层页面 pageY。使用当前视口截图的 SHA-256
      // 判断滚轮后是否有可见变化；连续两次不变才保守地报告到底。
      // 动画造成的变化只会让 reachedEnd 保持 false，不会制造假阳性。
      if (isInner) {
        const afterDigest = screenshotDigest((await this.cdp.send(
          "Page.captureScreenshot",
          { format: "png", captureBeyondViewport: false },
        )).data);
        innerNoChangeCount = afterDigest === beforeDigest
          ? innerNoChangeCount + 1
          : 0;
        if (innerNoChangeCount >= 2) {
          reachedEnd = true;
          break;
        }
      }
    }
    if (
      amount === "bottom" &&
      !reachedEnd &&
      !isInner &&
      documentScrollRangeObserved
    ) {
      const metrics = await this.cdp.send("Page.getLayoutMetrics");
      const viewport = metrics.cssLayoutViewport || metrics.layoutViewport || {};
      const visual = metrics.cssVisualViewport || metrics.visualViewport || {};
      const content = metrics.cssContentSize || metrics.contentSize || {};
      const height = Math.max(1, Number(viewport.clientHeight) || 1);
      const pageY = Math.max(0, Number(visual.pageY) || Number(viewport.pageY) || 0);
      const contentHeight = Math.max(height, Number(content.height) || height);
      reachedEnd = documentEndState({
        pageY,
        viewportHeight: height,
        contentHeight,
      }).reachedEnd;
    }
    this.invalidate();
    return {
      ok: true,
      direction,
      amount,
      steps,
      reachedEnd,
      deltaY: totalDeltaY,
      anchor: anchorPoint
        ? { kind: "coords", x: anchorPoint.x, y: anchorPoint.y }
        : null,
    };
  }

  async clickPoint({ x, y }, { mouseButton = "left", sessionId } = {}) {
    if (!new Set(["left", "right"]).has(mouseButton)) {
      const error = new Error("mouseButton must be left or right");
      error.code = "invalid_mouse_button";
      throw error;
    }
    const buttons = mouseButton === "right" ? 2 : 1;
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    }, { sessionId });
    await delay(90);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: mouseButton,
      buttons,
      clickCount: 1,
    }, { sessionId });
    await delay(75);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: mouseButton,
      buttons: 0,
      clickCount: 1,
    }, { sessionId });
    this.invalidate();
  }

  async fillRef(ref, value) {
    const { backendNodeId } = this.resolveRef(ref);
    return this.fillBackendNode(backendNodeId, value);
  }

  async fillVisual(backendNodeId, value) {
    return this.fillBackendNode(backendNodeId, value);
  }

  async fillBackendNode(backendNodeId, value) {
    await this.cdp.send("DOM.focus", { backendNodeId });
    await this.clearFieldValue(backendNodeId);
    return this.fillFocused(value);
  }

  async clearFieldValue(backendNodeId) {
    // Controlled inputs (React & co.) can ignore synthetic select-all +
    // Backspace; clearing through the native value setter plus input/change
    // events is the path their onChange handlers actually observe.
    const { object } = await this.cdp.send("DOM.resolveNode", { backendNodeId });
    try {
      await this.cdp.send("Runtime.callFunctionOn", {
        objectId: object.objectId,
        functionDeclaration: `function() {
          const el = this;
          if (el.isContentEditable) {
            el.textContent = "";
            el.dispatchEvent(new InputEvent("input", { bubbles: true }));
            return;
          }
          if (!("value" in el)) return;
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
          if (descriptor && descriptor.set) descriptor.set.call(el, "");
          else el.value = "";
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }`,
      });
    } finally {
      await this.cdp.send("Runtime.releaseObject", {
        objectId: object.objectId,
      }).catch(() => {});
    }
  }

  async fillVisualPoint(point, value) {
    await this.clickVisual(point);
    await delay(120);
    this.webContents.selectAll();
    await delay(90);
    this.webContents.delete();
    for (const character of String(value)) {
      if (character === "\n") {
        this.webContents.sendInputEvent({ type: "keyDown", keyCode: "Enter" });
        await delay(45 + Math.floor(Math.random() * 55));
        this.webContents.sendInputEvent({ type: "keyUp", keyCode: "Enter" });
        continue;
      }
      this.webContents.insertText(character);
      await delay(18 + Math.floor(Math.random() * 36));
    }
    this.invalidate();
    return { ok: true, length: String(value).length };
  }

  async fillFocused(value) {
    const modifier = process.platform === "darwin" ? 4 : 2;
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: process.platform === "darwin" ? "Meta" : "Control",
      modifiers: modifier,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "a",
      code: "KeyA",
      modifiers: modifier,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "a",
      code: "KeyA",
      modifiers: modifier,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: process.platform === "darwin" ? "Meta" : "Control",
      modifiers: 0,
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyDown",
      key: "Backspace",
      code: "Backspace",
    });
    await this.cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Backspace",
      code: "Backspace",
    });

    for (const character of String(value)) {
      if (character === "\n") {
        // A complete Enter event triggers the editor's native paragraph
        // behavior; the virtual key fields are required by Chromium CDP.
        await this.cdp.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          key: "Enter",
          code: "Enter",
          text: "\r",
          unmodifiedText: "\r",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        await delay(45 + Math.floor(Math.random() * 55));
        await this.cdp.send("Input.dispatchKeyEvent", {
          type: "keyUp",
          key: "Enter",
          code: "Enter",
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
        });
        continue;
      }
      await this.cdp.send("Input.insertText", { text: character });
      await delay(18 + Math.floor(Math.random() * 36));
    }
    this.invalidate();
    return { ok: true, length: String(value).length };
  }

  async uploadRef(ref, files) {
    const { backendNodeId, node } = this.resolveRef(ref);
    let fileInputBackendNodeId = backendNodeId;
    let mechanism = "native-file-input";

    if (!(node.tag === "input" && node.type === "file")) {
      if (node.role !== "upload") {
        const error = new Error("Upload ref is neither a native file input nor a semantic upload trigger");
        error.code = "invalid_upload_target";
        throw error;
      }
      mechanism = "semantic-trigger-file-chooser";
      fileInputBackendNodeId = await this.fileInputFromChooser(() =>
        this.clickRef(ref),
      );
    }

    return this.setFileInputFiles(fileInputBackendNodeId, files, mechanism);
  }

  async uploadVisual(point, files) {
    const fileInputBackendNodeId = await this.fileInputFromChooser(() =>
      this.clickVisual(point),
    );
    return this.setFileInputFiles(
      fileInputBackendNodeId,
      files,
      "visual-trigger-file-chooser",
    );
  }

  async fileInputFromChooser(activate) {
    await this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
    try {
      const opened = this.cdp.waitFor("Page.fileChooserOpened", 8000);
      await activate();
      const event = await opened;
      const backendNodeId = event.backendNodeId;
      if (!backendNodeId) {
        const error = new Error("File chooser did not expose its backing input node");
        error.code = "invalid_upload_target";
        throw error;
      }
      const metadata = await readNodeMetadata(this.cdp, backendNodeId);
      if (metadata.tag !== "input" || metadata.type !== "file") {
        const error = new Error("File chooser target is not a native file input");
        error.code = "invalid_upload_target";
        throw error;
      }
      return backendNodeId;
    } finally {
      await this.cdp
        .send("Page.setInterceptFileChooserDialog", { enabled: false })
        .catch(() => undefined);
    }
  }

  async setFileInputFiles(backendNodeId, files, mechanism) {
    await this.cdp.send("DOM.setFileInputFiles", {
      backendNodeId,
      files,
    });
    this.invalidate();
    return {
      ok: true,
      mechanism,
      files: files.map((file) => path.basename(file)),
    };
  }

  async captureSeries({ label, anchor, maxShots = 12 } = {}) {
    this.assertPageAvailable();
    const shots = Math.max(1, Math.min(60, Math.round(Number(maxShots) || 12)));
    // Series capture is a privileged Suno workflow. Its coordinate must be
    // derived from a current screenshot, never a reusable fixed coordinate.
    const anchorPoint = this.resolveVisualAnchor(anchor);
    const capture = await this.captureStore.begin(label);
    let stopReason = "max_shots";
    let reachedEnd = false;
    let lastImageSha256 = null;
    let noChangeCount = 0;
    try {
      for (let index = 0; index < shots; index += 1) {
        const metrics = await this.cdp.send("Page.getLayoutMetrics");
        const viewport =
          metrics.cssLayoutViewport || metrics.layoutViewport || {};
        const visual = metrics.cssVisualViewport || metrics.visualViewport || {};
        const width = Math.max(1, Number(viewport.clientWidth) || 1);
        const height = Math.max(1, Number(viewport.clientHeight) || 1);
        const pageY = Math.max(
          0,
          Number(visual.pageY) || Number(viewport.pageY) || 0,
        );

        const { data } = await this.cdp.send(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: false,
          },
          { timeoutMs: 30_000 },
        );
        // Suno 的 Magic Bar 会不断轮换提示语，整屏哈希即使轨道已到底也会变化。
        // 到底判定只观察左侧轨道编号/名称栏；完整 PNG 仍原样保存给用户。
        const stabilityRegion = {
          x: 0,
          y: Math.min(70, Math.max(0, height - 1)),
          width: Math.min(320, width),
          height: Math.max(1, height - Math.min(170, height - 1)),
          scale: 1,
        };
        const stabilityCapture = await this.cdp.send(
          "Page.captureScreenshot",
          {
            format: "png",
            captureBeyondViewport: false,
            clip: stabilityRegion,
          },
          { timeoutMs: 30_000 },
        );
        const stabilitySha256 = screenshotDigest(stabilityCapture.data);
        const shot = await this.captureStore.writeShot(capture, {
          dataBase64: data,
          pageY,
          viewportHeight: height,
          url: this.webContents.getURL(),
          stabilitySha256,
          stabilityRegion: {
            x: stabilityRegion.x,
            y: stabilityRegion.y,
            width: stabilityRegion.width,
            height: stabilityRegion.height,
          },
        });

        if (lastImageSha256 !== null) {
          noChangeCount = shot.stabilitySha256 === lastImageSha256
            ? noChangeCount + 1
            : 0;
          if (noChangeCount >= 2) {
            stopReason = "visual_stable_after_two_scrolls";
            reachedEnd = true;
            break;
          }
        }
        lastImageSha256 = shot.stabilitySha256;

        // 最后一屏不再滚
        if (index === shots - 1) {
          stopReason = "max_shots";
          break;
        }

        // 内层滚动：滚 wheel；非内层滚动：让 scroll() 内部跑完一次 page 滚动
        if (anchorPoint) {
          const deltaY = boundedScrollDelta({
            direction: "down",
            amount: "page",
            viewportHeight: height,
          });
          await this.cdp.send("Input.dispatchMouseEvent", {
            type: "mouseWheel",
            x: Math.round(width * anchorPoint.x),
            y: Math.round(height * anchorPoint.y),
            deltaX: 0,
            deltaY,
          });
          await delay(420 + Math.floor(Math.random() * 260));
        } else {
          const scrollResult = await this.scroll({
            direction: "down",
            amount: "page",
          });
          if (scrollResult.reachedEnd) {
            stopReason = "reached_end";
            reachedEnd = true;
            break;
          }
          if (scrollResult.steps === 0) {
            stopReason = "no_scroll_progress";
            reachedEnd = true;
            break;
          }
        }
      }
    } catch (error) {
      stopReason = `error:${error.code || "unknown"}`;
      // 仍然写出 manifest，但带 stopReason 标记
      const manifest = await this.captureStore.finish(capture, {
        reachedEnd,
        stopReason,
      });
      this.invalidate();
      throw Object.assign(error, { manifest });
    }

    const manifest = await this.captureStore.finish(capture, {
      reachedEnd,
      stopReason,
    });
    this.invalidate();
    return {
      captureId: manifest.captureId,
      label: manifest.label,
      dirName: manifest.dirName,
      shotCount: manifest.shotCount,
      reachedEnd: manifest.reachedEnd,
      stopReason: manifest.stopReason,
      shots: manifest.shots,
    };
  }

  downloadStatus({ downloadId, includeCompleted = false, principal } = {}) {
    if (downloadId) {
      const record = this.downloads.get(downloadId);
      if (!record || (principal && record.principal !== principal)) {
        const error = new Error(`Unknown downloadId: ${downloadId}`);
        error.code = "unknown_download";
        throw error;
      }
      return record;
    }
    const all = [];
    for (const record of this.downloads.values()) {
      if (principal && record.principal !== principal) continue;
      if (!includeCompleted && record.finishedAt) continue;
      all.push(record);
    }
    return { downloads: all, count: all.length };
  }

  close() {
    this.disarmSunoDownload();
    this.disarmMiniMaxDownload();
    this.cdp.detach();
  }
}

export { normalizeUrl };
