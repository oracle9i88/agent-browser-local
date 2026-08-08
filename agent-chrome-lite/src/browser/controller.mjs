import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { CdpSession } from "./cdp-session.mjs";
import {
  isMainFrameLoadFailure,
  PageHealthState,
} from "./page-health.mjs";
import { readNodeMetadata, SnapshotStore } from "./snapshot.mjs";
import { isContributionUrlAllowed } from "../security/contribution-policy.mjs";

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
  if (handoff?.detail?.code === "outside_contribution_scope") return "clear";
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

export class BrowserController extends EventEmitter {
  constructor(webContents, config, { allowFileUrls = false } = {}) {
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
      } else if (transition === "clear") {
        this.clearHandoff();
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
    return {
      title: this.webContents.getTitle(),
      url: this.webContents.getURL(),
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
    const backendNodeId = hit.backendNodeId;
    if (!backendNodeId) throw new Error("No DOM node exists at the visual point");
    const metadata = await readNodeMetadata(this.cdp, backendNodeId);
    const ax = await this.cdp.send("Accessibility.getPartialAXTree", {
      backendNodeId,
      fetchRelatives: false,
    });
    const axNode = ax.nodes?.[0];
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
    await this.cdp.send("DOM.focus", { backendNodeId });
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
      await this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true });
      try {
        const opened = this.cdp.waitFor("Page.fileChooserOpened", 8000);
        await this.clickRef(ref);
        const event = await opened;
        fileInputBackendNodeId = event.backendNodeId;
        if (!fileInputBackendNodeId) {
          const error = new Error("File chooser did not expose its backing input node");
          error.code = "invalid_upload_target";
          throw error;
        }
        const metadata = await readNodeMetadata(this.cdp, fileInputBackendNodeId);
        if (metadata.tag !== "input" || metadata.type !== "file") {
          const error = new Error("File chooser target is not a native file input");
          error.code = "invalid_upload_target";
          throw error;
        }
      } finally {
        await this.cdp
          .send("Page.setInterceptFileChooserDialog", { enabled: false })
          .catch(() => undefined);
      }
    }

    await this.cdp.send("DOM.setFileInputFiles", {
      backendNodeId: fileInputBackendNodeId,
      files,
    });
    this.invalidate();
    return {
      ok: true,
      mechanism,
      files: files.map((file) => path.basename(file)),
    };
  }

  close() {
    this.cdp.detach();
  }
}

export { normalizeUrl };
