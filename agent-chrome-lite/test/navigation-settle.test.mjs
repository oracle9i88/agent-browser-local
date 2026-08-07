import test from "node:test";
import assert from "node:assert/strict";

import {
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
