import test from "node:test";
import assert from "node:assert/strict";

import {
  boundedScrollDelta,
  documentEndState,
} from "../src/browser/controller.mjs";

test("scroll distance remains bounded to a human-sized step", () => {
  assert.equal(
    boundedScrollDelta({
      direction: "down",
      amount: "page",
      viewportHeight: 10_000,
    }),
    720,
  );
  assert.equal(
    boundedScrollDelta({
      direction: "up",
      amount: "small",
      viewportHeight: 100,
    }),
    -120,
  );
});

test("document geometry never claims an inner SPA container is already at bottom", () => {
  assert.deepEqual(
    documentEndState({ pageY: 0, viewportHeight: 864, contentHeight: 864 }),
    { scrollable: false, reachedEnd: false },
  );
  assert.deepEqual(
    documentEndState({ pageY: 1136, viewportHeight: 864, contentHeight: 2000 }),
    { scrollable: true, reachedEnd: true },
  );
});
