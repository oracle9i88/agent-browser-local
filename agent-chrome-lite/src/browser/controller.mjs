import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
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

const DEFAULT_DOWNLOADS_DIR = path.join(os.homedir(), "Downloads");

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
    this.handoff = null;
    this.lastNavigationActivityAt = Date.now();

    const runtimeDir =
      capturesDir || path.join(os.homedir(), ".agent-browser-local", "captures");
    this.captureStore = new CaptureStore(runtimeDir);
    this.downloadsDir = downloadsDir || DEFAULT_DOWNLOADS_DIR;
    this.downloads = new Map(); // downloadId → record
    this.downloadCounter = 0;

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
      this.invalidate();
      reconcileContributionScope(url);
    });
    webContents.on("did-navigate-in-page", (_event, url) => {
      this.lastNavigationActivityAt = Date.now();
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

    // 接管 session 下载事件。Suno Studio 的"Get Stems"走的是普通 download，
    // 默认会弹系统保存对话框。改写 setSavePath 直接写到 ~/Downloads。
    // Browser.downloadWillBegin / Browser.downloadProgress 由 session 层的
    // 'will-download' 事件触发（Electron 不直接转 CDP 事件）。
    // 部分单元测试用裸 EventEmitter 模拟 webContents，没有 .session 接口，
    // 这里做防御性检查。
    if (webContents.session && typeof webContents.session.on === "function") {
      webContents.session.on("will-download", (_event, item, _webContents) => {
        this.handleWillDownload(item).catch(() => undefined);
      });
    }
  }

  async handleWillDownload(item) {
    this.downloadCounter += 1;
    const downloadId = `dl_${this.downloadCounter}_${randomUUID().slice(0, 8)}`;
    const suggestedFilename = item.getFilename() || "";
    const safeName = sanitizeCaptureLabel(suggestedFilename).slice(0, 128) ||
      `download-${Date.now()}`;
    const savePath = path.join(this.downloadsDir, safeName);
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
    };
    this.downloads.set(downloadId, record);
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
      finalize(state === "completed" ? "completed" : "failed", state);
    });
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

  async resolveVisualPoint({ screenshotId, x, y }) {
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
    const editable = await resolveEditableFromSemanticHint(
      this.cdp,
      hitBackendNodeId,
      "",
    ).catch(() => null);
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

  async clickRef(ref) {
    const { backendNodeId } = this.resolveRef(ref);
    await this.cdp.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
    await delay(220);
    const { quads } = await this.cdp.send("DOM.getContentQuads", {
      backendNodeId,
    });
    const point = pointFromQuads(quads);
    if (!point) throw new Error("Target has no clickable viewport geometry");
    await this.clickPoint(point);
    return { ok: true };
  }

  async clickVisual(point) {
    await this.clickPoint(point);
    return { ok: true };
  }

  async scroll({ direction, amount, anchor }) {
    this.assertPageAvailable();
    const maxSteps = amount === "bottom" ? 12 : 1;
    const anchorPoint = parseAnchor(anchor); // throws on CSS/XPath, returns null otherwise
    let steps = 0;
    let totalDeltaY = 0;
    let reachedEnd = false;
    let documentScrollRangeObserved = false;
    let innerLastScrollY = null;
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

      // 内层容器模式：用 layout metrics 滚动后的 pageY 对比判断是否到底。
      // 文档几何无法证明内层容器边界；连续两次无位移即认为到顶/到底。
      if (isInner) {
        const postMetrics = await this.cdp.send("Page.getLayoutMetrics");
        const postVisual = postMetrics.cssVisualViewport || postMetrics.visualViewport || {};
        const postPageY = Math.max(
          0,
          Number(postVisual.pageY) || 0,
        );
        if (innerLastScrollY !== null && postPageY === innerLastScrollY) {
          reachedEnd = true;
          break;
        }
        innerLastScrollY = postPageY;
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

  async clickPoint({ x, y }) {
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      button: "none",
    });
    await delay(90);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x,
      y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await delay(75);
    await this.cdp.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x,
      y,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
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
    return this.fillFocused(value);
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
    const anchorPoint = parseAnchor(anchor); // throws on CSS/XPath
    const capture = await this.captureStore.begin(label);
    let stopReason = "max_shots";
    let reachedEnd = false;
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

        const { data } = await this.cdp.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: false,
        });
        await this.captureStore.writeShot(capture, {
          dataBase64: data,
          pageY,
          viewportHeight: height,
          url: this.webContents.getURL(),
        });

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
          const post = await this.cdp.send("Page.getLayoutMetrics");
          const postVisual =
            post.cssVisualViewport || post.visualViewport || {};
          const postY = Math.max(
            0,
            Number(postVisual.pageY) || 0,
          );
          if (postY === pageY) {
            stopReason = "no_scroll_progress";
            reachedEnd = true;
            break;
          }
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

  downloadStatus({ downloadId, includeCompleted = false } = {}) {
    if (downloadId) {
      const record = this.downloads.get(downloadId);
      if (!record) {
        const error = new Error(`Unknown downloadId: ${downloadId}`);
        error.code = "unknown_download";
        throw error;
      }
      return record;
    }
    const all = [];
    for (const record of this.downloads.values()) {
      if (!includeCompleted && record.finishedAt) continue;
      all.push(record);
    }
    return { downloads: all, count: all.length };
  }

  close() {
    this.cdp.detach();
  }
}

export { normalizeUrl };
