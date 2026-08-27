import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  defaultChromeUserDataURL,
  detectChromeProfiles,
} from "../../src/profile/chrome-profile-detector.mjs";

async function makeFixtureRoot() {
  return mkdtemp(path.join(tmpdir(), "abl-chrome-profile-"));
}

const LOCAL_STATE = JSON.stringify({
  profile: {
    info_cache: {
      Default: { name: "个人", user_name: "owner@example.com" },
      "Profile 1": { name: "工作室", user_name: "studio@example.com" },
    },
  },
});

test("detector resolves platform default roots without touching them", () => {
  const darwin = defaultChromeUserDataURL({
    platform: "darwin",
    homeDir: "/home/tester",
  });
  assert.equal(
    darwin,
    path.join("/home/tester", "Library", "Application Support", "Google", "Chrome"),
  );
  const win32 = defaultChromeUserDataURL({
    platform: "win32",
    homeDir: "/home/tester",
  });
  assert.equal(
    win32,
    path.join("/home/tester", "AppData", "Local", "Google", "Chrome", "User Data"),
  );
  const linux = defaultChromeUserDataURL({
    platform: "linux",
    homeDir: "/home/tester",
  });
  assert.equal(linux, path.join("/home/tester", ".config", "google-chrome"));
});

test("detector lists profiles read-only with display names and lock state", async () => {
  const root = await makeFixtureRoot();
  try {
    await mkdir(path.join(root, "Default"), { recursive: true });
    await mkdir(path.join(root, "Profile 1"), { recursive: true });
    await mkdir(path.join(root, "System Profile"), { recursive: true });
    await writeFile(path.join(root, "Local State"), LOCAL_STATE, "utf8");
    await writeFile(path.join(root, "SingletonSocket"), "", "utf8");

    const before = {
      localState: await readFile(path.join(root, "Local State")),
      mtimeMs: (await stat(path.join(root, "Local State"))).mtimeMs,
    };

    const detected = await detectChromeProfiles({ rootPath: root });

    assert.equal(detected.available, true);
    assert.equal(detected.chromeRunning, true);
    assert.deepEqual(
      detected.profiles.map((profile) => profile.dirName),
      ["Default", "Profile 1"],
      "System Profile must not be offered",
    );
    assert.equal(detected.profiles[0].displayName, "个人");
    assert.equal(detected.profiles[0].userName, "owner@example.com");
    assert.equal(detected.profiles[0].knownToLocalState, true);
    assert.equal(detected.profiles[1].displayName, "工作室");

    const after = await readFile(path.join(root, "Local State"));
    assert.deepEqual(before.localState, after, "Local State must stay untouched");
    const afterStat = await stat(path.join(root, "Local State"));
    assert.equal(afterStat.mtimeMs, before.mtimeMs, "detection must not modify the source tree");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("detector reports unavailable root and never throws for missing dirs", async () => {
  const missing = path.join(tmpdir(), `abl-missing-${Date.now()}`);
  const detected = await detectChromeProfiles({ rootPath: missing });
  assert.equal(detected.available, false);
  assert.equal(detected.chromeRunning, false);
  assert.deepEqual(detected.profiles, []);
  assert.ok(detected.warnings.length > 0);
});

test("detector degrades gracefully when Local State is unreadable", async () => {
  const root = await makeFixtureRoot();
  try {
    await mkdir(path.join(root, "Default"), { recursive: true });
    await mkdir(path.join(root, "Profile 2"), { recursive: true });
    await writeFile(path.join(root, "Local State"), "{not json", "utf8");

    const detected = await detectChromeProfiles({ rootPath: root });

    assert.equal(detected.available, true);
    assert.equal(detected.chromeRunning, false);
    assert.deepEqual(
      detected.profiles.map((profile) => profile.dirName),
      ["Default", "Profile 2"],
    );
    assert.equal(detected.profiles[0].displayName, "Default");
    assert.equal(detected.profiles[0].knownToLocalState, false);
    assert.ok(detected.warnings.some((warning) => warning.includes("Local State")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
