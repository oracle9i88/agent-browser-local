import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WorkspaceRouter } from "../../src/browser/workspace-router.mjs";
import { recoverPendingMigrations, rollbackLoginMigration } from "../../src/profile/profile-migrator.mjs";

function fixture() {
  const router = new WorkspaceRouter();
  for (const id of ["default", "music"]) {
    const controller = new EventEmitter();
    controller.status = () => ({ url: `https://${id}.example` });
    controller.invalidate = () => { controller.invalidated = true; };
    controller.navigate = async (url) => ({ id, url });
    router.add({ space: { id, label: id }, controller });
  }
  return router;
}

test("stable controller facade follows workspace and invalidates stale refs", async () => {
  const router = fixture();
  const facade = router.controller;
  router.select("music");
  assert.equal(facade.status().spaceId, "music");
  assert.equal(router.active().controller.invalidated, true);
  assert.deepEqual(await facade.navigate("x"), { id: "music", url: "x" });
});

test("in-flight and queued request lifetime blocks retargeting and competing agents", async () => {
  const router = fixture();
  let finish;
  const pending = router.run(() => new Promise((resolve) => { finish = resolve; }));
  assert.throws(() => router.select("music"), { code: "workspace_busy" });
  await assert.rejects(router.run(() => {}), { code: "workspace_busy" });
  finish();
  await pending;
  router.select("music");
  await assert.rejects(router.run(() => {}, "default"), { code: "workspace_changed" });
});

test("failed operation releases workspace lock", async () => {
  const router = fixture();
  await assert.rejects(router.run(() => { throw new Error("fault"); }));
  router.select("music");
  assert.equal(router.activeId, "music");
});

test("background page state cannot overwrite foreground; downloads keep source space", () => {
  const router = fixture();
  let states = 0;
  let download;
  router.controller.on("state", () => states++);
  router.controller.on("download", (record) => { download = record; });
  router.entries.get("music").controller.emit("state");
  assert.equal(states, 0);
  router.entries.get("default").controller.emit("state");
  assert.equal(states, 1);
  router.entries.get("music").controller.emit("download", { downloadId: "d" });
  assert.equal(download.spaceId, "music");
});

function manifestFixture() {
  const entries = ["default", "music"].map((id) => ({
    id, status: "pending", space: { id }, platforms: [{ platform: "suno", label: "Suno", cookies: [{ name: "session", domain: "suno.com", path: "/" }] }],
  }));
  return { document: { entries }, load: async () => ({ entries }), save: async () => {} };
}

test("startup recovery removes each record only from its owning cookie store", async () => {
  const manifest = manifestFixture();
  const removed = [];
  const result = await recoverPendingMigrations({
    cookieStore: { remove: async () => { throw new Error("wrong fallback store"); } },
    cookieStoreForSpace: async ({ id }) => ({ remove: async () => removed.push(id) }),
    manifestStore: manifest,
  });
  assert.deepEqual(removed, ["default", "music"]);
  assert.equal(result.removed, 2);
});

test("rollback cannot select another workspace migration, even with explicit id", async () => {
  const manifest = manifestFixture();
  let removed = 0;
  await assert.rejects(rollbackLoginMigration({
    migrationId: "music", spaceId: "default", manifestStore: manifest,
    cookieStore: { remove: async () => removed++ },
  }), { code: "migration_migration_not_found" });
  assert.equal(removed, 0);
  await rollbackLoginMigration({ spaceId: "default", manifestStore: manifest, cookieStore: { remove: async () => removed++ } });
  assert.equal(removed, 1);
  assert.equal(manifest.document.entries[1].status, "pending");
});
