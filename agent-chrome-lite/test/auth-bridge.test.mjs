import test from "node:test";
import assert from "node:assert/strict";

import { selectSunoAuthCookies } from "../src/browser/auth-bridge.mjs";

test("only allowlisted Suno auth cookies cross the browser boundary", () => {
  const selected = selectSunoAuthCookies([
    { domain: ".suno.com", name: "__client", value: "secret", path: "/", secure: true, httpOnly: true },
    { domain: "auth.suno.com", name: "__session", value: "session", path: "/", secure: true },
    { domain: ".suno.com", name: "ajs_anonymous_id", value: "tracking", path: "/" },
    { domain: ".google.com", name: "SID", value: "google-secret", path: "/" },
  ]);
  assert.deepEqual(selected.map((cookie) => cookie.name), ["__client", "__session"]);
  assert.equal(selected[0].url, "https://suno.com/");
  assert.equal(selected[0].httpOnly, true);
});

test("rejects empty or foreign cookie sets", () => {
  assert.deepEqual(selectSunoAuthCookies([]), []);
  assert.deepEqual(selectSunoAuthCookies([{ domain: ".suno.com", name: "SID", value: "x" }]), []);
});
