import test from "node:test";
import assert from "node:assert/strict";

import {
  classifyExternalAuthUrl,
  isExternalAuthUrl,
} from "../src/browser/external-auth.mjs";

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

