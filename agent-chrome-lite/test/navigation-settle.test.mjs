import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

import {
  BrowserController,
  contributionScopeTransition,
  isExpectedNavigationAbort,
  waitForNavigationQuiet,
} from "../src/browser/controller.mjs";

test("only Chromium redirect aborts are treated as expected", () => {
  assert.equal(isExpectedNavigationAbort({ code: "ERR_ABORTED" }), true);
  assert.equal(isExpectedNavigationAbort({ errno: -3 }), true);
  assert.equal(
    isExpectedNavigationAbort({ message: "Failed to load: ERR_ABORTED (-3)" }),
    true,
  );
  assert.equal(isExpectedNavigationAbort({ code: "ERR_NAME_NOT_RESOLVED" }), false);
});

test("status lazily clears stale outside-scope handoff on the final allowed URL", () => {
  const webContents = new EventEmitter();
  webContents.getURL = () =>
    "https://channels.weixin.qq.com/platform/post/create";
  webContents.getTitle = () => "视频号助手";
  webContents.isLoading = () => false;
  webContents.navigationHistory = {
    canGoBack: () => true,
    canGoForward: () => false,
  };
  const config = {
    security: {
      maxSnapshotControls: 180,
      maxSnapshotHints: 80,
      contributionTargets: [
        {
          origin: "https://channels.weixin.qq.com",
          pathPrefixes: ["/platform/post/create"],
        },
      ],
    },
  };
  const controller = new BrowserController(webContents, config);
  controller.handoff = {
    required: true,
    detail: { code: "outside_contribution_scope" },
  };

  assert.equal(controller.status().handoff, null);
  controller.handoff = {
    required: true,
    detail: { code: "manual_auth_surface_requires_handoff" },
  };
  assert.equal(
    controller.status().handoff.detail.code,
    "manual_auth_surface_requires_handoff",
  );
});

test("navigation settle waits through a delayed redirect activity", async () => {
  let now = 0;
  let activityAt = 0;
  let loading = false;
  const waits = [];

  const settled = await waitForNavigationQuiet({
    isLoading: () => loading,
    lastActivityAt: () => activityAt,
    quietMs: 300,
    timeoutMs: 2000,
    now: () => now,
    wait: async (ms) => {
      waits.push(ms);
      now += ms;
      if (now === 200) {
        activityAt = now;
        loading = true;
      }
      if (now === 300) loading = false;
    },
  });

  assert.equal(settled, true);
  assert.equal(now, 500);
  assert.equal(waits.length, 5);
});

test("navigation settle fails closed after its bounded timeout", async () => {
  let now = 0;
  const settled = await waitForNavigationQuiet({
    isLoading: () => true,
    lastActivityAt: () => 0,
    quietMs: 300,
    timeoutMs: 500,
    now: () => now,
    wait: async (ms) => {
      now += ms;
    },
  });
  assert.equal(settled, false);
  assert.equal(now, 500);
});

test("SPA transition into an allowed contribution page clears only outside-scope handoff", () => {
  const config = {
    security: {
      contributionTargets: [
        {
          origin: "https://creator.douyin.com",
          pathPrefixes: ["/creator-micro/content/upload"],
        },
      ],
    },
  };
  const outside = {
    required: true,
    detail: { code: "outside_contribution_scope" },
  };
  const auth = {
    required: true,
    detail: { code: "manual_auth_surface_requires_handoff" },
  };

  assert.equal(
    contributionScopeTransition(
      config,
      "https://creator.douyin.com/creator-micro/content/upload",
      outside,
    ),
    "clear",
  );
  assert.equal(
    contributionScopeTransition(
      config,
      "https://creator.douyin.com/creator-micro/content/upload",
      auth,
    ),
    "unchanged",
  );
  assert.equal(
    contributionScopeTransition(
      config,
      "https://creator.douyin.com/creator-micro/home",
      null,
    ),
    "handoff",
  );
});
