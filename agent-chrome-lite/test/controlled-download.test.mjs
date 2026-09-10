import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { BrowserController } from "../src/browser/controller.mjs";
import { assertAllowedDownloadPath } from "../src/config.mjs";
import { CAPABILITIES, CONFIRMATION_POLICY } from "../src/constants.mjs";
import {
  DOWNLOAD_REGISTRY,
  downloadSourcesFor,
  mergeDownloadSources,
  removeDownloadSources,
} from "../src/security/platform-registry.mjs";
import { BrowserDaemon, DaemonError } from "../src/server/daemon.mjs";

test("download registry registers musopen origins and rejects unknown ids", () => {
  const sources = downloadSourcesFor(["musopen"]);
  assert.deepEqual(
    sources.map((s) => s.origin).sort(),
    ["https://dl.musopen.org", "https://musopen.org"],
  );
  assert.ok(sources.every((s) => s.source === "musopen"));
  assert.equal(DOWNLOAD_REGISTRY.musopen.label.includes("Musopen"), true);
  assert.throws(() => downloadSourcesFor(["unknown_source"]), /Unknown download source/);
});

test("download source merge keeps local entries and removal is origin-scoped", () => {
  const local = [{ origin: "https://files.example.org" }];
  const merged = mergeDownloadSources(local, ["musopen"]);
  assert.equal(merged.length, 3);
  const removed = removeDownloadSources(merged, ["musopen"]);
  assert.deepEqual(removed, local);
});

test("assertAllowedDownloadPath enforces roots, existence and overwrite", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "abl-dl-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "abl-dl-outside-"));
  try {
    const ok = await assertAllowedDownloadPath(path.join(root, "a.mp3"), [root]);
    assert.equal(ok.filename, "a.mp3");
    assert.equal(ok.overwrite, false);

    await assert.rejects(
      assertAllowedDownloadPath(path.join(outside, "a.mp3"), [root]),
      (error) => error.code === "download_path_outside_roots",
    );
    await assert.rejects(
      assertAllowedDownloadPath("relative/a.mp3", [root]),
      (error) => error.code === "invalid_download_path",
    );
    await assert.rejects(
      assertAllowedDownloadPath(path.join(root, "missing-dir", "a.mp3"), [root]),
      (error) => error.code === "invalid_download_path",
    );

    await writeFile(path.join(root, "b.mp3"), "existing");
    await assert.rejects(
      assertAllowedDownloadPath(path.join(root, "b.mp3"), [root]),
      (error) => error.code === "download_target_exists",
    );
    const replaced = await assertAllowedDownloadPath(path.join(root, "b.mp3"), [root], {
      overwrite: true,
    });
    assert.equal(replaced.overwrite, true);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

function daemonFixture({ controllerOverrides = {}, downloadRoots = [] } = {}) {
  const events = [];
  const controller = {
    handoff: null,
    status() {
      return { url: "https://musopen.org/music/", handoff: this.handoff };
    },
    setHandoff(reason, detail) {
      this.handoff = { required: true, reason, detail };
      return this.handoff;
    },
    clearHandoff() {
      this.handoff = null;
    },
    controlledCalls: [],
    controlledResult: {
      downloadId: "dl_1_abcd",
      state: "in_progress",
      savePath: "/tmp/x.mp3",
      filename: "x.mp3",
      started: true,
    },
    controlledDownload: async function (args) {
      this.controlledCalls.push(args);
      return this.controlledResult;
    },
    ...controllerOverrides,
  };
  const daemon = new BrowserDaemon({
    controller,
    config: {
      security: {
        uploadRoots: [],
        contributionTargets: [],
        downloadSources: [
          { origin: "https://musopen.org" },
          { origin: "https://dl.musopen.org" },
        ],
        downloadRoots,
        downloadMinIntervalMs: 1000,
      },
    },
    executor: { run: (task) => task() },
    audit: { record: async (event) => events.push(event) },
  });
  const identity = {
    principal: "codex",
    capabilities: [CAPABILITIES.DOWNLOAD_FILE, CAPABILITIES.DOWNLOAD_STATUS],
    confirmationPolicy: CONFIRMATION_POLICY,
  };
  return { controller, daemon, events, identity };
}

test("browser.download requires the locally granted capability", async () => {
  const { daemon, identity, controller } = daemonFixture();
  identity.capabilities = [];
  await assert.rejects(
    daemon.dispatch(identity, "browser.download", {
      url: "https://dl.musopen.org/a.mp3",
      savePath: "/tmp/a.mp3",
    }),
    (error) => error.code === "capability_denied",
  );
  assert.equal(controller.controlledCalls.length, 0);
});

test("browser.download rejects origins outside the download allowlist", async () => {
  const { daemon, identity, controller } = daemonFixture();
  for (const url of [
    "https://evil.example.org/a.mp3",
    "http://dl.musopen.org/a.mp3",
    "https://127.0.0.1/a.mp3",
    "https://user:pass@dl.musopen.org/a.mp3",
    "notaurl",
  ]) {
    await assert.rejects(
      daemon.dispatch(identity, "browser.download", { url, savePath: "/tmp/a.mp3" }),
      (error) =>
        error instanceof DaemonError &&
        ["download_source_not_allowed", "invalid_download_url"].includes(error.code),
    );
  }
  assert.equal(controller.controlledCalls.length, 0);
});

test("browser.download rejects paths outside download roots and existing files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "abl-dl-daemon-"));
  try {
    const { daemon, identity, controller } = daemonFixture({ downloadRoots: [root] });
    await assert.rejects(
      daemon.dispatch(identity, "browser.download", {
        url: "https://dl.musopen.org/a.mp3",
        savePath: "/etc/a.mp3",
      }),
      (error) => error.code === "download_path_outside_roots",
    );
    await writeFile(path.join(root, "dup.mp3"), "x");
    await assert.rejects(
      daemon.dispatch(identity, "browser.download", {
        url: "https://dl.musopen.org/a.mp3",
        savePath: path.join(root, "dup.mp3"),
      }),
      (error) => error.code === "download_target_exists",
    );
    assert.equal(controller.controlledCalls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser.download dispatches an audited paced download", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "abl-dl-daemon-"));
  try {
    const { daemon, identity, controller, events } = daemonFixture({
      downloadRoots: [root],
    });
    const savePath = path.join(root, "opus.mp3");
    const result = await daemon.dispatch(identity, "browser.download", {
      url: "https://dl.musopen.org/files/opus.mp3?sig=secret",
      savePath,
    });
    assert.equal(result.downloadId, "dl_1_abcd");
    assert.equal(controller.controlledCalls.length, 1);
    const call = controller.controlledCalls[0];
    assert.equal(call.url, "https://dl.musopen.org/files/opus.mp3?sig=secret");
    assert.equal(call.savePath, path.join(await realpath(root), "opus.mp3"));
    assert.equal(call.principal, "codex");
    const event = events.find((entry) => entry.event === "browser.download");
    assert.equal(event.url, "https://dl.musopen.org/files/opus.mp3");
    assert.equal(event.filename, "opus.mp3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser.download enforces the minimum interval between downloads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "abl-dl-daemon-"));
  try {
    const { daemon, identity } = daemonFixture({ downloadRoots: [root] });
    const startedAt = Date.now();
    await daemon.dispatch(identity, "browser.download", {
      url: "https://dl.musopen.org/1.mp3",
      savePath: path.join(root, "1.mp3"),
    });
    await daemon.dispatch(identity, "browser.download", {
      url: "https://dl.musopen.org/2.mp3",
      savePath: path.join(root, "2.mp3"),
    });
    assert.ok(Date.now() - startedAt >= 1000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("browser.download surfaces download_not_started as a 502 failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "abl-dl-daemon-"));
  try {
    const { daemon, identity } = daemonFixture({
      downloadRoots: [root],
      controllerOverrides: {
        controlledResult: {
          downloadId: "dl_1_abcd",
          state: "failed",
          started: false,
        },
      },
    });
    await assert.rejects(
      daemon.dispatch(identity, "browser.download", {
        url: "https://dl.musopen.org/a.mp3",
        savePath: path.join(root, "a.mp3"),
      }),
      (error) => error.status === 502 && error.code === "download_not_started",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function fakeWebContents(url = "https://musopen.org/music/") {
  const webContents = new EventEmitter();
  webContents.session = new EventEmitter();
  webContents.getURL = () => url;
  webContents.getTitle = () => "t";
  webContents.isLoading = () => false;
  webContents.isDestroyed = () => true;
  webContents.debugger = { isAttached: () => false };
  webContents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
  return webContents;
}

function fakeDownloadItem(itemUrl) {
  const item = new EventEmitter();
  item.getURL = () => itemUrl;
  item.getFilename = () => path.basename(new URL(itemUrl).pathname);
  item.getReceivedBytes = () => item.received || 0;
  item.getTotalBytes = () => item.total || -1;
  item.canResume = () => Boolean(item.resumable);
  item.resume = () => {
    item.resumed = (item.resumed || 0) + 1;
  };
  item.setSavePath = (value) => {
    item.savePath = value;
  };
  return item;
}

function controllerConfig() {
  return {
    security: { maxSnapshotControls: 10, maxSnapshotHints: 5, contributionTargets: [] },
  };
}

test("controlledDownload arms once, pins savePath and reports completion", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "abl-dl-controller-"));
  try {
    const webContents = fakeWebContents();
    webContents.session.downloadURL = (url) => {
      const item = fakeDownloadItem(url);
      queueMicrotask(() => {
        webContents.session.emit("will-download", {}, item, webContents);
        item.emit("updated", {}, "progressing");
        item.received = 100;
        item.total = 100;
        item.emit("done", {}, "completed");
      });
    };
    const controller = new BrowserController(webContents, controllerConfig(), {});
    const events = [];
    controller.on("download", (entry) => events.push(entry));

    const savePath = path.join(dir, "opus.mp3");
    const result = await controller.controlledDownload({
      url: "https://dl.musopen.org/files/opus.mp3?sig=x",
      savePath,
      filename: "opus.mp3",
      principal: "codex",
    });
    assert.equal(result.started, true);
    const record = controller.downloadStatus({
      downloadId: result.downloadId,
      principal: "codex",
    });
    assert.equal(record.state, "completed");
    assert.equal(record.receivedBytes, 100);
    assert.equal(record.savePath, savePath);
    assert.deepEqual(
      events.map((entry) => entry.event),
      ["browser.download.started", "browser.download.completed"],
    );

    // 一次性：同一 URL 第二次 will-download 不被接管
    const stray = fakeDownloadItem("https://dl.musopen.org/files/opus.mp3?sig=x");
    const handled = await controller.handleWillDownload(stray, webContents);
    assert.equal(handled.handled, false);
    assert.equal(stray.savePath, undefined);
    controller.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("controlledDownload resumes interrupted transfers within the cap", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "abl-dl-controller-"));
  try {
    const webContents = fakeWebContents();
    webContents.session.downloadURL = (url) => {
      const item = fakeDownloadItem(url);
      item.resumable = true;
      queueMicrotask(() => {
        webContents.session.emit("will-download", {}, item, webContents);
        item.emit("updated", {}, "interrupted");
        item.emit("updated", {}, "interrupted");
        item.emit("updated", {}, "progressing");
        item.received = 50;
        item.emit("done", {}, "completed");
      });
    };
    const controller = new BrowserController(webContents, controllerConfig(), {});
    const result = await controller.controlledDownload({
      url: "https://dl.musopen.org/a.mp3",
      savePath: path.join(dir, "a.mp3"),
      filename: "a.mp3",
      principal: "codex",
    });
    const record = controller.downloadStatus({
      downloadId: result.downloadId,
      principal: "codex",
    });
    assert.equal(record.state, "completed");
    assert.equal(record.resumeAttempts, 2);
    controller.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("controlledDownload reports interrupted as failed without a duplicate copy", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "abl-dl-controller-"));
  try {
    const webContents = fakeWebContents();
    webContents.session.downloadURL = (url) => {
      const item = fakeDownloadItem(url);
      queueMicrotask(() => {
        webContents.session.emit("will-download", {}, item, webContents);
        item.emit("done", {}, "interrupted");
      });
    };
    const controller = new BrowserController(webContents, controllerConfig(), {});
    const savePath = path.join(dir, "a.mp3");
    const result = await controller.controlledDownload({
      url: "https://dl.musopen.org/a.mp3",
      savePath,
      filename: "a.mp3",
      principal: "codex",
    });
    const record = controller.downloadStatus({
      downloadId: result.downloadId,
      principal: "codex",
    });
    assert.equal(record.state, "failed");
    assert.equal(record.error, "interrupted");
    assert.equal(record.savePath, savePath);
    controller.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("controlledDownload fails cleanly when the session cannot download", async () => {
  // 无 downloadURL 的 session（防御路径）应同步报错，且不留待办。
  const webContents = fakeWebContents();
  const controller = new BrowserController(webContents, controllerConfig(), {});
  await assert.rejects(
    controller.controlledDownload({
      url: "https://dl.musopen.org/a.mp3",
      savePath: "/tmp/a.mp3",
      filename: "a.mp3",
      principal: "codex",
    }),
    (error) => error.code === "download_unsupported",
  );
  assert.equal(controller.controlledDownloadPending.size, 0);
  controller.close();
});

test("controlledDownload rejects double-arming the same URL", async () => {
  const webContents = fakeWebContents();
  webContents.session.downloadURL = () => {};
  const controller = new BrowserController(webContents, controllerConfig(), {
    downloadStartTimeoutMs: 60,
  });
  const first = controller.controlledDownload({
    url: "https://dl.musopen.org/a.mp3",
    savePath: "/tmp/a.mp3",
    filename: "a.mp3",
    principal: "codex",
  });
  await assert.rejects(
    controller.controlledDownload({
      url: "https://dl.musopen.org/a.mp3?other=query",
      savePath: "/tmp/b.mp3",
      filename: "b.mp3",
      principal: "codex",
    }),
    (error) => error.code === "download_already_pending",
  );
  const result = await first;
  assert.equal(result.started, false);
  assert.equal(result.state, "failed");
  assert.equal(result.error, "download_not_started");
  controller.close();
});
