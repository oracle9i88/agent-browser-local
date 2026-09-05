import test from "node:test";
import assert from "node:assert/strict";

import { BrowserDaemon, DaemonError } from "../src/server/daemon.mjs";
import { CAPABILITIES, CONFIRMATION_POLICY } from "../src/constants.mjs";

function fixture() {
  const events = [];
  const controller = {
    handoff: null,
    status() {
      return {
        url: "https://suno.com/studio/song/abc",
        handoff: this.handoff,
      };
    },
    captureSeries: async () => ({
      captureId: "cap-1",
      label: "Tragic Grandeur",
      dirName: "Tragic Grandeur-20260904",
      shotCount: 4,
      reachedEnd: true,
      stopReason: "reached_end",
      shots: [],
    }),
    downloadStatus: () => ({
      downloads: [],
      count: 0,
    }),
  };
  const daemon = new BrowserDaemon({
    controller,
    config: {
      security: {
        uploadRoots: [],
        contributionTargets: [
          { origin: "https://suno.com", pathPrefixes: ["/studio"] },
        ],
      },
    },
    executor: { run: (task) => task() },
    audit: { record: async (event) => events.push(event) },
  });
  const fullIdentity = {
    principal: "codex",
    capabilities: [
      CAPABILITIES.CAPTURE_SERIES,
      CAPABILITIES.DOWNLOAD_STATUS,
    ],
    confirmationPolicy: CONFIRMATION_POLICY,
  };
  const limitedIdentity = {
    principal: "codex",
    capabilities: [CAPABILITIES.STATUS],
    confirmationPolicy: CONFIRMATION_POLICY,
  };
  return { controller, daemon, events, fullIdentity, limitedIdentity };
}

test("captureSeries without CAPTURE_SERIES capability returns 403", async () => {
  const { daemon, events, limitedIdentity } = fixture();
  await assert.rejects(
    daemon.dispatch(limitedIdentity, "browser.captureSeries", {
      label: "Tragic Grandeur",
    }),
    (error) =>
      error instanceof DaemonError &&
      error.status === 403 &&
      error.code === "capability_denied",
  );
  // 没产生 audit 事件（403 在 capability check 就拒了）
  assert.equal(events.length, 0);
});

test("captureSeries with CAPTURE_SERIES dispatches and audits", async () => {
  const { controller, daemon, events, fullIdentity } = fixture();
  const result = await daemon.dispatch(fullIdentity, "browser.captureSeries", {
    label: "Tragic Grandeur",
    maxShots: 4,
    anchor: { kind: "visual", screenshotId: "00000000-0000-4000-8000-000000000001", x: 180, y: 500 },
  });
  assert.equal(result.captureId, "cap-1");
  assert.equal(result.reachedEnd, true);
  const auditEvent = events.find((e) => e.event === "browser.captureSeries");
  assert.ok(auditEvent, "expected browser.captureSeries audit event");
  assert.equal(auditEvent.label, "Tragic Grandeur");
  assert.equal(auditEvent.shotCount, 4);
  assert.equal(auditEvent.reachedEnd, true);
});

test("downloadStatus without DOWNLOAD_STATUS capability returns 403", async () => {
  const { daemon, limitedIdentity } = fixture();
  await assert.rejects(
    daemon.dispatch(limitedIdentity, "browser.downloadStatus", {}),
    (error) =>
      error instanceof DaemonError &&
      error.status === 403 &&
      error.code === "capability_denied",
  );
});

test("downloadStatus with DOWNLOAD_STATUS returns record and audits", async () => {
  const { daemon, events, fullIdentity } = fixture();
  const result = await daemon.dispatch(fullIdentity, "browser.downloadStatus", {
    includeCompleted: true,
  });
  assert.equal(result.count, 0);
  const auditEvent = events.find((e) => e.event === "browser.downloadStatus");
  assert.ok(auditEvent, "expected browser.downloadStatus audit event");
  assert.equal(auditEvent.principal, "codex");
});

test("captureSeries rejects out-of-scope URL with contribution policy", async () => {
  const { daemon, fullIdentity } = fixture();
  // 控制器当前 URL 是 https://suno.com/studio/song/abc (已配置),
  // 但 navigate 也会改 URL，所以直接调用的 URL 应不通过 contribution check
  const noContributionDaemon = new BrowserDaemon({
    controller: {
      status: () => ({
        url: "https://evil.example.com",
        handoff: null,
      }),
    },
    config: {
      security: {
        uploadRoots: [],
        contributionTargets: [
          { origin: "https://suno.com", pathPrefixes: ["/studio"] },
        ],
      },
    },
    executor: { run: (task) => task() },
    audit: { record: async () => undefined },
  });
  await assert.rejects(
    noContributionDaemon.dispatch(fullIdentity, "browser.captureSeries", {
      label: "x",
    }),
    (error) => error instanceof DaemonError && error.status === 403,
  );
});

test("captureSeries rejects an allowed contribution page outside Suno Studio", async () => {
  const { fullIdentity } = fixture();
  const daemon = new BrowserDaemon({
    controller: {
      status: () => ({ url: "https://suno.com/create", handoff: null }),
      captureSeries: async () => ({ ok: true }),
    },
    config: {
      security: {
        uploadRoots: [],
        contributionTargets: [
          { origin: "https://suno.com", pathPrefixes: ["/create", "/studio"] },
        ],
      },
    },
    executor: { run: (task) => task() },
    audit: { record: async () => undefined },
  });
  await assert.rejects(
    daemon.dispatch(fullIdentity, "browser.captureSeries", { label: "x" }),
    (error) =>
      error instanceof DaemonError &&
      error.status === 403 &&
      error.code === "suno_studio_required",
  );
});

test("delegated Studio Multitrack click arms one Suno download permit", async () => {
  let armedFor = null;
  let clicked = false;
  const controller = {
    status: () => ({ url: "https://suno.com/studio/song/abc", handoff: null }),
    resolveRef: () => ({ node: { role: "menuitem", name: "Multitrack" } }),
    armSunoDownload: ({ principal }) => {
      armedFor = principal;
      return { permitId: "permit-1" };
    },
    disarmSunoDownload: () => undefined,
    clickRef: async () => { clicked = true; return { ok: true }; },
  };
  const events = [];
  const daemon = new BrowserDaemon({
    controller,
    config: {
      security: {
        uploadRoots: [],
        contributionTargets: [
          { origin: "https://suno.com", pathPrefixes: ["/studio"] },
        ],
      },
    },
    executor: { run: (task) => task() },
    audit: { record: async (entry) => events.push(entry) },
  });
  const identity = {
    principal: "codex",
    capabilities: [CAPABILITIES.CLICK, CAPABILITIES.FINALIZE],
    confirmationPolicy: CONFIRMATION_POLICY,
  };
  await daemon.dispatch(identity, "browser.click", { ref: "snapshot:1" });
  assert.equal(armedFor, "codex");
  assert.equal(clicked, true);
  assert.ok(events.some((entry) => entry.code === "studio_download_requires_finalize"));
});
