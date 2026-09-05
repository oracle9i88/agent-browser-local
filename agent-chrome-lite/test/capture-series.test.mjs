import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  availableDownloadPath,
  BrowserController,
  isSunoStudioUrl,
  sanitizeDownloadFilename,
} from "../src/browser/controller.mjs";
import { CaptureStore, sanitizeCaptureLabel } from "../src/browser/capture-store.mjs";
import { CAPABILITIES } from "../src/constants.mjs";

test("sanitizeCaptureLabel strips path separators and trims junk", () => {
  assert.equal(sanitizeCaptureLabel("Tragic Grandeur"), "Tragic Grandeur");
  assert.equal(sanitizeCaptureLabel("../../etc/passwd"), "etc-passwd");
  assert.equal(sanitizeCaptureLabel(""), "");
  assert.equal(sanitizeCaptureLabel("歌曲/名:Tragic?"), "歌曲-名-Tragic");
  assert.ok(sanitizeCaptureLabel("a".repeat(200)).length <= 64);
});

test("CaptureStore lays out per-song folder with manifest", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "abl-capture-"));
  try {
    const store = new CaptureStore(dir);
    const capture = await store.begin("Tragic Grandeur");
    await store.writeShot(capture, {
      dataBase64: Buffer.from("png-bytes-1").toString("base64"),
      pageY: 0,
      viewportHeight: 864,
      url: "https://example.test/song",
    });
    await store.writeShot(capture, {
      dataBase64: Buffer.from("png-bytes-2").toString("base64"),
      pageY: 864,
      viewportHeight: 864,
      url: "https://example.test/song",
    });
    const manifest = await store.finish(capture, {
      reachedEnd: true,
      stopReason: "reached_end",
    });
    assert.equal(manifest.shotCount, 2);
    assert.equal(manifest.reachedEnd, true);
    assert.equal(manifest.stopReason, "reached_end");
    assert.equal(manifest.label, "Tragic Grandeur");
    assert.ok(manifest.dirName.startsWith("Tragic Grandeur-"));
    assert.equal(manifest.shots[0].file, "shot-01.png");
    assert.equal(manifest.shots[1].file, "shot-02.png");

    const files = await readdir(capture.dir);
    assert.deepEqual(files.sort(), ["manifest.json", "shot-01.png", "shot-02.png"]);
    const shotSize = (await stat(path.join(capture.dir, "shot-01.png"))).size;
    assert.ok(shotSize > 0);
    const parsedManifest = JSON.parse(
      await readFile(path.join(capture.dir, "manifest.json"), "utf8"),
    );
    assert.equal(parsedManifest.shotCount, 2);
    assert.equal(parsedManifest.shots[0].stabilitySha256, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function makeFakeCdp({ scrolls }) {
  const handlers = {};
  return {
    handlers,
    async send(method, params = {}) {
      if (method === "Page.getLayoutMetrics") {
        const entry = scrolls.shift() || { scrollY: 0 };
        return {
          cssLayoutViewport: { clientWidth: 1280, clientHeight: 864 },
          cssVisualViewport: { clientWidth: 1280, clientHeight: 864, pageY: entry.scrollY },
          cssContentSize: { width: 1280, height: 8000 },
        };
      }
      if (method === "Page.captureScreenshot") {
        return { data: Buffer.from("screenshot").toString("base64") };
      }
      if (method === "Input.dispatchMouseEvent") {
        return {};
      }
      return {};
    },
    async attach() {},
    detach() {},
    waitFor() {
      return Promise.resolve({});
    },
  };
}

test("captureSeries uses a fresh visual anchor and requires two stable frames", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "abl-capture-controller-"));
  try {
    const webContents = new EventEmitter();
    webContents.session = new EventEmitter();
    webContents.getURL = () => "https://suno.com/studio/song";
    webContents.getTitle = () => "song";
    webContents.isLoading = () => false;
    webContents.isDestroyed = () => true;
    webContents.debugger = { isAttached: () => false };
    webContents.navigationHistory = {
      canGoBack: () => false,
      canGoForward: () => false,
    };
    const fakeCdp = makeFakeCdp({
      scrolls: [
        { scrollY: 0 }, // shot 1: metrics before screenshot
        { scrollY: 720 }, // post first scroll check
        { scrollY: 1440 }, // post second scroll check
        { scrollY: 2160 }, // scroll loop bottom check
      ],
    });
    const config = {
      security: {
        maxSnapshotControls: 10,
        maxSnapshotHints: 5,
        contributionTargets: [
          { origin: "https://example.test", pathPrefixes: ["/"] },
        ],
      },
    };
    const controller = new BrowserController(webContents, config, {
      capturesDir: dir,
    });
    controller.cdp = fakeCdp;
    controller.screenshotState = {
      screenshotId: "00000000-0000-4000-8000-000000000001",
      url: webContents.getURL(),
      width: 1280,
      height: 864,
      createdAt: Date.now(),
    };

    const result = await controller.captureSeries({
      label: "Tragic Grandeur",
      maxShots: 5,
      anchor: {
        kind: "visual",
        screenshotId: controller.screenshotState.screenshotId,
        x: 230,
        y: 430,
      },
    });
    assert.equal(result.shotCount, 3);
    assert.equal(result.stopReason, "visual_stable_after_two_scrolls");
    assert.equal(result.reachedEnd, true);

    const folders = await readdir(dir);
    assert.equal(folders.length, 1);
    const innerFiles = await readdir(path.join(dir, folders[0]));
    assert.ok(innerFiles.includes("manifest.json"));
    const manifest = JSON.parse(
      await readFile(path.join(dir, folders[0], "manifest.json"), "utf8"),
    );
    assert.equal(manifest.shots[0].stabilityRegion.width, 320);
    assert.equal(manifest.shots[0].stabilitySha256.length, 64);
    controller.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureSeries rejects a reusable fixed-coordinate anchor", async () => {
  const webContents = new EventEmitter();
  webContents.session = new EventEmitter();
  webContents.getURL = () => "https://suno.com/studio/song";
  webContents.getTitle = () => "song";
  webContents.isLoading = () => false;
  webContents.isDestroyed = () => true;
  webContents.debugger = { isAttached: () => false };
  webContents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  const controller = new BrowserController(webContents, {
    security: { maxSnapshotControls: 10, maxSnapshotHints: 5, contributionTargets: [] },
  });
  await assert.rejects(
    controller.captureSeries({
      label: "x",
      anchor: { kind: "coords", x: 0.18, y: 0.5 },
    }),
    (error) => error.code === "stale_visual_ref",
  );
  controller.close();
});

test("download permit is one-shot, Suno-Studio-only and preserves extensions", async () => {
  const webContents = new EventEmitter();
  webContents.id = 42;
  webContents.session = new EventEmitter();
  webContents.getURL = () => "https://suno.com/studio/song/abc";
  webContents.getTitle = () => "song";
  webContents.isLoading = () => false;
  webContents.isDestroyed = () => true;
  webContents.debugger = { isAttached: () => false };
  webContents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  const controller = new BrowserController(webContents, {
    security: { maxSnapshotControls: 10, maxSnapshotHints: 5, contributionTargets: [] },
  }, { downloadsDir: "/tmp" });
  const permit = controller.armSunoDownload({ principal: "codex" });
  assert.ok(permit.permitId);

  const item = new EventEmitter();
  item.getFilename = () => "../My Stems.wav";
  item.getReceivedBytes = () => 0;
  item.getTotalBytes = () => 123;
  let savePath = null;
  item.setSavePath = (value) => { savePath = value; };
  const handled = await controller.handleWillDownload(item, { id: 42 });
  assert.equal(handled.handled, true);
  assert.match(savePath, /My Stems(?: \(\d+\))?\.wav$/);

  const second = new EventEmitter();
  second.getFilename = () => "second.zip";
  let secondPath = null;
  second.setSavePath = (value) => { secondPath = value; };
  const ignored = await controller.handleWillDownload(second, { id: 42 });
  assert.equal(ignored.handled, false);
  assert.equal(secondPath, null);
  controller.close();
});

test("download helpers reject non-Studio URLs and avoid overwriting", () => {
  assert.equal(isSunoStudioUrl("https://suno.com/studio/abc"), true);
  assert.equal(isSunoStudioUrl("https://suno.com/create"), false);
  assert.equal(isSunoStudioUrl("https://evil.example/studio"), false);
  assert.equal(sanitizeDownloadFilename("../../stems.wav"), "stems.wav");
  const candidate = availableDownloadPath(
    "/tmp",
    "stems.wav",
    (value) => value.endsWith("stems.wav"),
  );
  assert.equal(candidate, "/tmp/stems (2).wav");
});

test("controller rejects CSS anchor as a security boundary", async () => {
  const webContents = new EventEmitter();
  webContents.session = new EventEmitter();
  webContents.getURL = () => "https://example.test";
  webContents.getTitle = () => "t";
  webContents.isLoading = () => false;
  webContents.isDestroyed = () => true;
  webContents.debugger = { isAttached: () => false };
  webContents.navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
  };
  const config = {
    security: {
      maxSnapshotControls: 10,
      maxSnapshotHints: 5,
      contributionTargets: [
        { origin: "https://example.test", pathPrefixes: ["/"] },
      ],
    },
  };
  const controller = new BrowserController(webContents, config, {});
  controller.cdp = {
    send: async (method) => (method === "Page.getLayoutMetrics" ? {
      cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
      cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageY: 0 },
      cssContentSize: { width: 800, height: 600 },
    } : {}),
    async attach() {},
    detach() {},
    waitFor() { return Promise.resolve({}); },
  };
  await assert.rejects(
    controller.scroll({
      direction: "down",
      amount: "page",
      anchor: { kind: "css", selector: ".left-rail" },
    }),
    /CSS\/XPath selectors are not allowed/,
  );
  controller.close();
});

test("downloadStatus lists in-progress downloads and resolves single by id", () => {
  const webContents = new EventEmitter();
  webContents.session = new EventEmitter();
  webContents.getURL = () => "https://example.test";
  webContents.getTitle = () => "t";
  webContents.isLoading = () => false;
  webContents.navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
  };
  webContents.isDestroyed = () => true;
  webContents.debugger = { isAttached: () => false };
  const config = {
    security: {
      maxSnapshotControls: 10,
      maxSnapshotHints: 5,
      contributionTargets: [
        { origin: "https://example.test", pathPrefixes: ["/"] },
      ],
    },
  };
  const controller = new BrowserController(webContents, config, {});
  controller.downloads.set("dl_alpha", {
    downloadId: "dl_alpha",
    filename: "stems.wav",
    savePath: "/tmp/stems.wav",
    state: "completed",
    finishedAt: Date.now(),
    receivedBytes: 1024,
    totalBytes: 1024,
    principal: "codex",
  });
  controller.downloads.set("dl_beta", {
    downloadId: "dl_beta",
    filename: "drums.wav",
    savePath: "/tmp/drums.wav",
    state: "in_progress",
    finishedAt: null,
    receivedBytes: 512,
    totalBytes: 2048,
    principal: "codex",
  });

  const all = controller.downloadStatus({ principal: "codex" });
  assert.equal(all.count, 1);
  assert.equal(all.downloads[0].downloadId, "dl_beta");

  const allIncluding = controller.downloadStatus({ includeCompleted: true, principal: "codex" });
  assert.equal(allIncluding.count, 2);

  const single = controller.downloadStatus({ downloadId: "dl_alpha", principal: "codex" });
  assert.equal(single.filename, "stems.wav");

  assert.throws(
    () => controller.downloadStatus({ downloadId: "dl_missing" }),
    /Unknown downloadId/,
  );
  assert.throws(
    () => controller.downloadStatus({ downloadId: "dl_alpha", principal: "claude" }),
    /Unknown downloadId/,
  );
  controller.close();
});

test("successful Suno download finishes with a null error", async () => {
  const webContents = new EventEmitter();
  const session = new EventEmitter();
  webContents.session = session;
  webContents.id = 7;
  webContents.getURL = () => "https://suno.com/studio";
  webContents.getTitle = () => "Suno Studio";
  webContents.isLoading = () => false;
  webContents.navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
  };
  webContents.isDestroyed = () => true;
  webContents.debugger = { isAttached: () => false };
  const config = {
    security: {
      maxSnapshotControls: 10,
      maxSnapshotHints: 5,
      contributionTargets: [{ origin: "https://suno.com", pathPrefixes: ["/studio"] }],
    },
  };
  const controller = new BrowserController(webContents, config, {
    downloadsDir: "/tmp",
  });
  controller.armSunoDownload({ principal: "codex" });
  const item = new EventEmitter();
  item.getFilename = () => "single-track.wav";
  item.getReceivedBytes = () => 4096;
  item.getTotalBytes = () => 4096;
  item.setSavePath = () => {};

  await controller.handleWillDownload(item, webContents);
  item.emit("done", {}, "completed");

  const result = controller.downloadStatus({ includeCompleted: true, principal: "codex" });
  assert.equal(result.count, 1);
  assert.equal(result.downloads[0].state, "completed");
  assert.equal(result.downloads[0].error, null);
  controller.close();
});

test("scroll with anchor tracks inner container zero-displacement as end", async () => {
  const webContents = new EventEmitter();
  webContents.session = new EventEmitter();
  webContents.getURL = () => "https://example.test";
  webContents.getTitle = () => "t";
  webContents.isLoading = () => false;
  webContents.isDestroyed = () => true;
  webContents.debugger = { isAttached: () => false };
  webContents.navigationHistory = {
    canGoBack: () => false,
    canGoForward: () => false,
  };
  const config = {
    security: {
      maxSnapshotControls: 10,
      maxSnapshotHints: 5,
      contributionTargets: [
        { origin: "https://example.test", pathPrefixes: ["/"] },
      ],
    },
  };
  const controller = new BrowserController(webContents, config, {});
  let yBefore = 0;
  let callIndex = 0;
  controller.cdp = {
    send: async (method) => {
      if (method === "Page.getLayoutMetrics") {
        callIndex += 1;
        // 第一次滚动后位置变化，第二次滚动后位置不变 -> 到底
        const y = callIndex <= 2 ? 200 : yBefore;
        yBefore = y;
        return {
          cssLayoutViewport: { clientWidth: 800, clientHeight: 600 },
          cssVisualViewport: { clientWidth: 800, clientHeight: 600, pageY: y },
          cssContentSize: { width: 800, height: 600 },
        };
      }
      return {};
    },
    async attach() {},
    detach() {},
    waitFor() { return Promise.resolve({}); },
  };

  const result = await controller.scroll({
    direction: "down",
    amount: "bottom",
    anchor: { kind: "coords", x: 0.2, y: 0.5 },
  });
  assert.equal(result.anchor.kind, "coords");
  assert.equal(result.anchor.x, 0.2);
  assert.equal(result.reachedEnd, true);
  controller.close();
});
