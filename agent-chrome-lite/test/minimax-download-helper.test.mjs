import test from "node:test";
import assert from "node:assert/strict";

import { selectNoWatermarkRef } from "../skills/minimax-download/scripts/download-open-menu.mjs";

test("MiniMax helper selects exactly one fresh no-watermark menu ref", () => {
  const snapshot = { controls: [
    { ref: "fresh:1", name: "MP3(无水印)" },
    { ref: "fresh:2", name: "MP3(有水印)" },
  ] };
  assert.equal(selectNoWatermarkRef(snapshot), "fresh:1");
  assert.throws(() => selectNoWatermarkRef({ controls: [snapshot.controls[1]] }), /found 0/);
  assert.throws(() => selectNoWatermarkRef({ controls: [snapshot.controls[0], snapshot.controls[0]] }), /found 2/);
});
