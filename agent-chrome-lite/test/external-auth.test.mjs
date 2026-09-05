import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyExternalAuthUrl,
  isExternalAuthUrl,
} from "../src/browser/external-auth.mjs";
import { normalizeEndpoint } from "../src/browser/chrome-cdp.mjs";
import { openChromeSessionBridge } from "../src/browser/chrome-launcher.mjs";

test("classifies Google OAuth URLs for external Chrome handoff", () => {
  const result = classifyExternalAuthUrl(
    "https://accounts.google.com/o/oauth2/v2/auth?client_id=redacted&state=opaque",
  );
  assert.equal(result.provider, "google");
  assert.equal(result.displayUrl, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(result.url.includes("state=opaque"), true);
});

test("classifies Suno login URLs but not ordinary Suno pages", () => {
  assert.equal(
    classifyExternalAuthUrl("https://suno.com/login?next=%2Fcreate").provider,
    "suno",
  );
  assert.equal(isExternalAuthUrl("https://suno.com/create"), false);
  assert.equal(isExternalAuthUrl("https://app.suno.ai/oauth/callback"), true);
});

test("never opens arbitrary or unsafe URLs externally", () => {
  for (const value of [
    "https://example.com/login",
    "http://accounts.google.com/login",
    "javascript:alert(1)",
    "not a url",
  ]) {
    assert.equal(isExternalAuthUrl(value), false, value);
  }
});

test("Chrome session bridge accepts only a loopback CDP endpoint", () => {
  assert.equal(normalizeEndpoint("http://127.0.0.1:9222").port, "9222");
  assert.throws(
    () => normalizeEndpoint("https://example.com:9222"),
    /loopback HTTP/,
  );
});

test("Chrome session bridge refuses non-Suno URLs before launching", async () => {
  await assert.rejects(
    openChromeSessionBridge({
      url: "https://example.com/",
      profileDir: "/tmp/agent-browser-bridge-test",
    }),
    /only opens an HTTPS Suno URL/,
  );
});
