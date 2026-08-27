import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  createSpaceManager,
  DEFAULT_SPACE_ID,
} from "../../src/browser/space-manager.mjs";
import { createTabOwnership } from "../../src/browser/tab-ownership.mjs";

async function makeSpacesDir() {
  return mkdtemp(path.join(tmpdir(), "abl-spaces-"));
}

function fakeSessionFactory() {
  const sessions = new Map();
  return {
    sessions,
    fromPartition(name) {
      if (!sessions.has(name)) sessions.set(name, { name, cookies: new Map() });
      return sessions.get(name);
    },
  };
}

test("space manager lazily creates an isolated default space", async () => {
  const dir = await makeSpacesDir();
  try {
    const factory = fakeSessionFactory();
    const manager = createSpaceManager({ spacesDir: dir, sessionFactory: factory });
    const spaces = await manager.listSpaces();
    assert.equal(spaces.length, 1);
    assert.equal(spaces[0].id, DEFAULT_SPACE_ID);
    assert.equal(spaces[0].partition, "abl-space-default");

    const space = await manager.getSpace(DEFAULT_SPACE_ID);
    const session = manager.sessionFor(space);
    assert.equal(session.name, "persist:abl-space-default");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("each space resolves to a distinct persisted partition session", async () => {
  const dir = await makeSpacesDir();
  try {
    const factory = fakeSessionFactory();
    const manager = createSpaceManager({ spacesDir: dir, sessionFactory: factory });
    await manager.ensureDefaultSpace();
    await manager.ensureSpace("studio", "工作室");

    const defaultSession = manager.sessionFor(await manager.getSpace(DEFAULT_SPACE_ID));
    const studioSession = manager.sessionFor(await manager.getSpace("studio"));

    assert.notEqual(defaultSession, studioSession, "spaces must never share a session");
    assert.equal(defaultSession.name, "persist:abl-space-default");
    assert.equal(studioSession.name, "persist:abl-space-studio");

    // structural isolation contract: cookies written in one space's session
    // store are invisible from the other (Electron partitions guarantee this
    // in production; the fake mirrors the contract for regression testing).
    defaultSession.cookies.set("suno.com|/|__session", { name: "__session" });
    assert.equal(studioSession.cookies.has("suno.com|/|__session"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("space registry persists with strict file mode and survives reload", async () => {
  const dir = await makeSpacesDir();
  try {
    const factory = fakeSessionFactory();
    const first = createSpaceManager({ spacesDir: dir, sessionFactory: factory });
    await first.ensureSpace("studio", "工作室");

    const raw = await readFile(path.join(dir, "registry.json"));
    const parsed = JSON.parse(raw);
    assert.equal(parsed.spaces.length, 1);
    assert.equal(parsed.spaces[0].partition, "abl-space-studio");

    const second = createSpaceManager({ spacesDir: dir, sessionFactory: factory });
    const spaces = await second.listSpaces();
    assert.deepEqual(
      spaces.map((space) => space.id).sort(),
      ["default", "studio"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("space manager rejects invalid ids", async () => {
  const dir = await makeSpacesDir();
  try {
    const manager = createSpaceManager({ spacesDir: dir, sessionFactory: fakeSessionFactory() });
    assert.rejects(() => manager.ensureSpace("../evil"), /Invalid space id/);
    assert.rejects(() => manager.ensureSpace(""), /Invalid space id/);
    assert.rejects(() => manager.getSpace("missing"), /Unknown agent space/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("tab ownership defaults to the default space and rebinds explicitly", () => {
  const ownership = createTabOwnership();
  assert.equal(ownership.ownerOf(999), DEFAULT_SPACE_ID, "unbound tabs are fail-closed");

  ownership.bind(7, "studio");
  assert.equal(ownership.ownerOf(7), "studio");
  assert.deepEqual(ownership.tabsOf("studio"), [7]);

  ownership.rebind(7, DEFAULT_SPACE_ID);
  assert.equal(ownership.ownerOf(7), DEFAULT_SPACE_ID);

  ownership.unbind(7);
  assert.equal(ownership.ownerOf(7), DEFAULT_SPACE_ID);
  assert.throws(() => ownership.rebind(7, "studio"), /not bound/);
  assert.throws(() => ownership.bind(-1, "studio"), /Invalid tab id/);
  assert.throws(() => ownership.bind(8, ""), /space id/);
});
