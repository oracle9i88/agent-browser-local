import test from "node:test";
import assert from "node:assert/strict";

import {
  assertNoElectronBrand,
  buildChromiumUserAgent,
} from "../src/browser/user-agent.mjs";

test("compatibility user agent identifies as Chromium without Electron", () => {
  const userAgent = buildChromiumUserAgent({
    platform: "darwin",
    chromeVersion: "144.0.7559.110",
  });
  assert.match(userAgent, /Macintosh; Intel Mac OS X 10_15_7/);
  assert.match(userAgent, /Chrome\/144\.0\.7559\.110/);
  assert.doesNotMatch(userAgent, /Electron/i);
  assert.equal(assertNoElectronBrand(userAgent), userAgent);
});

test("rejects malformed Chromium versions and Electron-branded UA", () => {
  assert.throws(
    () => buildChromiumUserAgent({ platform: "darwin", chromeVersion: "144" }),
    /full Chromium version/,
  );
  assert.throws(
    () => assertNoElectronBrand("Chrome/144 Electron/43.3.0"),
    /must not expose/,
  );
});
