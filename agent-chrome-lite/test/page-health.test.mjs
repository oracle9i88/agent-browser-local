import test from "node:test";
import assert from "node:assert/strict";

import {
  isMainFrameLoadFailure,
  PageHealthState,
  PageUnavailableError,
} from "../src/browser/page-health.mjs";

test("page faults fail closed without losing the recorded cause", () => {
  const health = new PageHealthState({ now: () => "2026-08-07T00:00:00.000Z" });
  health.fail("renderer_gone", { reason: "crashed", exitCode: 9 });

  assert.deepEqual(health.snapshot(), {
    state: "faulted",
    fault: {
      code: "renderer_gone",
      reason: "crashed",
      exitCode: 9,
      at: "2026-08-07T00:00:00.000Z",
    },
  });
  assert.throws(
    () => health.assertAvailable(),
    (error) =>
      error instanceof PageUnavailableError &&
      error.code === "page_unavailable" &&
      error.detail.fault.code === "renderer_gone",
  );
});

test("explicit page recovery restores availability", () => {
  const health = new PageHealthState();
  health.fail("page_unresponsive");
  assert.equal(health.recover(), true);
  assert.doesNotThrow(() => health.assertAvailable());
  assert.deepEqual(health.snapshot(), { state: "healthy", fault: null });
});

test("redirect abort is not classified as a page load failure", () => {
  assert.equal(isMainFrameLoadFailure({ errorCode: -3, isMainFrame: true }), false);
  assert.equal(isMainFrameLoadFailure({ errorCode: -105, isMainFrame: true }), true);
  assert.equal(isMainFrameLoadFailure({ errorCode: -105, isMainFrame: false }), false);
});
