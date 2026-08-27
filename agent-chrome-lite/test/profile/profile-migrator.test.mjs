import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MIGRATION_DENIED_DOMAIN_SUFFIXES,
  MIGRATION_PLATFORM_OFFERS,
  createManifestStore,
  listMigrationOffers,
  rollbackLoginMigration,
  runLoginMigration,
  validateMigrationSelection,
} from "../../src/profile/profile-migrator.mjs";
import { findChromeTargetForDomains } from "../../src/browser/chrome-cdp.mjs";

const SECRET = "SECRET-COOKIE-VALUE-DO-NOT-LEAK";

function makeCookieStore() {
  const jar = new Map();
  return {
    jar,
    async set(cookie) {
      jar.set(`${cookie.domain}|${cookie.path}|${cookie.name}`, { ...cookie });
    },
    async get(filter) {
      return [...jar.values()].filter(
        (cookie) =>
          (!filter?.name || cookie.name === filter.name) &&
          (!filter?.domain || cookie.domain === filter.domain),
      );
    },
    async remove(url, name) {
      for (const [key, cookie] of jar) {
        if (cookie.name === name && `https://${cookie.domain.replace(/^\./, "")}${cookie.path}` === url) {
          jar.delete(key);
          return;
        }
      }
    },
  };
}

function fakeCdp({ domain, names, targetUrl }) {
  return {
    listTargets: async () => [
      { url: targetUrl || `https://${domain}/home`, title: "t" },
    ],
    getCookiesForUrls: async (_target, urls) => {
      if (!urls.every((url) => url.startsWith("https://"))) {
        throw new Error("urls must be https");
      }
      return names.map((name, index) => ({
        name,
        value: `${SECRET}-${index}`,
        domain: `.${domain}`,
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
        expires: Math.floor(Date.now() / 1000) + 86400,
      }));
    },
  };
}

async function makeManifestStore() {
  const dir = await mkdtemp(path.join(tmpdir(), "abl-migration-"));
  return { store: createManifestStore(dir), dir };
}

function cdpFor(offer, extraNames = []) {
  return fakeCdp({
    domain: offer.domains[0],
    names: [...offer.requiredCookieNames, ...extraNames],
    targetUrl: `https://${offer.domains[0]}/console`,
  });
}

test("offers never contain google identity domains (constraint 3)", () => {
  const offers = JSON.stringify(listMigrationOffers());
  for (const suffix of MIGRATION_DENIED_DOMAIN_SUFFIXES) {
    assert.ok(!offers.includes(suffix), `offers must not contain ${suffix}`);
  }
});

test("selection validation rejects google domains, unknown domains and empty input", () => {
  assert.throws(
    () => validateMigrationSelection(["accounts.google.com"]),
    /身份认证域/,
  );
  assert.throws(() => validateMigrationSelection(["google.com"]), /身份认证域/);
  assert.throws(
    () => validateMigrationSelection(["accounts.youtube.com"]),
    /身份认证域/,
  );
  assert.throws(
    () => validateMigrationSelection(["evil.example.com"]),
    /白名单/,
  );
  assert.throws(() => validateMigrationSelection([]), /至少/);
  assert.throws(() => validateMigrationSelection(["suno.com", "suno.com"]), /重复/);
});

test("selection validation accepts a subset of allowlisted domains", () => {
  const selections = validateMigrationSelection(["suno.com", "music.163.com"]);
  assert.equal(selections.length, 2);
  assert.equal(selections[0].offer.platform, "suno");
  assert.deepEqual(selections[0].domains, ["suno.com"]);
  assert.equal(selections[1].offer.platform, "netease-music");
});

test("cdp target matcher suffix-matches platform domains", () => {
  const targets = [
    { url: "https://www.google.com/" },
    { url: "https://creator.douyin.com/console" },
  ];
  const found = findChromeTargetForDomains(targets, ["douyin.com"]);
  assert.equal(found.url, "https://creator.douyin.com/console");
  assert.equal(findChromeTargetForDomains(targets, ["kuaishou.com"]), null);
});

test("migration filters by name whitelist and returns value-free summary", async () => {
  const { store, dir } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  const offer = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "douyin");
  const summary = await runLoginMigration({
    selectedDomains: ["douyin.com"],
    cookieStore,
    manifestStore: store,
    cdp: cdpFor(offer, ["unlisted_cookie_name"]),
  });

  assert.equal(summary.platforms[0].platform, "douyin");
  assert.equal(summary.platforms[0].verified, true);
  // unlisted name must have been dropped by the whitelist
  assert.equal(summary.platforms[0].injectedCount, offer.requiredCookieNames.length);

  const serialized = JSON.stringify(summary);
  assert.ok(!serialized.includes(SECRET), "summary must never contain cookie values");

  const stored = JSON.stringify(await readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.ok(!stored.includes(SECRET), "manifest must never contain cookie values");

  for (const cookie of cookieStore.jar.values()) {
    assert.ok(offer.cookieNames.includes(cookie.name), "only whitelisted names injected");
  }
});

test("pre-sync verification fails when required login cookies are absent", async () => {
  const { store } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  const offer = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  const cdp = fakeCdp({
    domain: "suno.com",
    names: ["__client_uat"],
    targetUrl: "https://suno.com/",
  });

  await assert.rejects(
    () =>
      runLoginMigration({
        selectedDomains: ["suno.com"],
        cookieStore,
        manifestStore: store,
        cdp,
      }),
    /同步前验证未通过/,
  );
  assert.equal(cookieStore.jar.size, 0, "nothing may be injected when precheck fails");
});

test("pre-sync verification fails when the platform tab is not open in chrome", async () => {
  const { store } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  const cdp = {
    listTargets: async () => [{ url: "https://example.com/" }],
    getCookiesForUrls: async () => [],
  };
  await assert.rejects(
    () =>
      runLoginMigration({
        selectedDomains: ["music.163.com"],
        cookieStore,
        manifestStore: store,
        cdp,
      }),
    /没有打开 网易云音乐/,
  );
});

test("post-sync verification failure triggers automatic rollback (constraint 8)", async () => {
  const { store, dir } = await makeManifestStore();
  const offer = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  const cookieStore = makeCookieStore();
  // a store whose get() always returns empty → postcheck always fails
  const brokenStore = {
    set: cookieStore.set.bind(cookieStore),
    get: async () => [],
    remove: cookieStore.remove.bind(cookieStore),
  };
  await assert.rejects(
    () =>
      runLoginMigration({
        selectedDomains: ["suno.com"],
        cookieStore: brokenStore,
        manifestStore: store,
        cdp: cdpFor(offer),
      }),
    /同步后验证未通过/,
  );
  assert.equal(cookieStore.jar.size, 0, "injected cookies must be rolled back");
  const raw = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(raw.entries[0].status, "rolled_back");
});

test("mid-injection failure rolls back earlier cookies of the same platform", async () => {
  const { store, dir } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  const offer = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  let setCalls = 0;
  const flakyStore = {
    set: async (cookie) => {
      setCalls += 1;
      if (setCalls === 2) throw new Error("injected store broke");
      await cookieStore.set(cookie);
    },
    get: cookieStore.get.bind(cookieStore),
    remove: cookieStore.remove.bind(cookieStore),
  };
  await assert.rejects(
    () =>
      runLoginMigration({
        selectedDomains: ["suno.com"],
        cookieStore: flakyStore,
        manifestStore: store,
        cdp: cdpFor(offer),
      }),
    /同步/,
  );
  assert.equal(setCalls, 2);
  assert.equal(cookieStore.jar.size, 0, "the first injected cookie must not survive");
  const raw = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(raw.entries[0].status, "rolled_back");
});

test("rollback failure is escalated, not swallowed; entry flagged for recovery", async () => {
  const { store, dir } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  const offer = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  const removeBrokeStore = {
    set: cookieStore.set.bind(cookieStore),
    get: async () => [],
    remove: async () => {
      throw new Error("store locked");
    },
  };
  await assert.rejects(
    () =>
      runLoginMigration({
        selectedDomains: ["suno.com"],
        cookieStore: removeBrokeStore,
        manifestStore: store,
        cdp: cdpFor(offer),
      }),
    (error) => error.code === "migration_rollback_failed" && /回滚未完全完成/.test(error.message),
  );
  assert.equal(cookieStore.jar.size, offer.requiredCookieNames.length, "residual cookies must be reported honestly");
  const raw = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(raw.entries[0].rollbackFailed, true);
  assert.equal(raw.entries[0].status, "pending");
});

test("pending manifest entries are recovered on startup", async () => {
  const { store, dir } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  // seed a residue cookie left by a crashed migration, plus a pending record
  await cookieStore.set({
    url: "https://suno.com/",
    name: "__session",
    value: "residue",
    domain: ".suno.com",
    path: "/",
  });
  // an unrelated pre-existing cookie that recovery must never touch
  await cookieStore.set({
    url: "https://music.163.com/",
    name: "MUSIC_U",
    value: "user-real-session",
    domain: ".163.com",
    path: "/",
  });
  const document = await store.load();
  document.entries.push({
    id: "migration-crashed",
    at: "2026-01-01T00:00:00.000Z",
    status: "pending",
    rollbackFailed: true,
    space: { id: "default", partition: "abl-space-default" },
    platforms: [
      {
        platform: "suno",
        label: "Suno",
        domains: ["suno.com"],
        cookies: [{ name: "__session", domain: ".suno.com", path: "/" }],
      },
    ],
  });
  await store.save(document);

  const { recoverPendingMigrations } = await import("../../src/profile/profile-migrator.mjs");
  const summary = await recoverPendingMigrations({
    cookieStore,
    manifestStore: store,
  });
  assert.equal(summary.entries, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.failed, 0);
  assert.equal(cookieStore.jar.size, 1, "residue must be cleaned up");
  const untouched = [...cookieStore.jar.values()].find(
    (cookie) => cookie.name === "MUSIC_U",
  );
  assert.equal(
    untouched?.value,
    "user-real-session",
    "recovery must only clean manifest-listed cookies, never unrelated ones",
  );
  const raw = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.equal(raw.entries[0].status, "rolled_back");
  assert.ok(raw.entries[0].recoveredAt);
});

test("committed manifest save failure rolls everything back (constraint 8)", async () => {
  const real = await makeManifestStore();
  const cookieStore = makeCookieStore();
  const offer = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  let saveCalls = 0;
  const flakySaveStore = {
    load: real.store.load,
    save: async (doc) => {
      saveCalls += 1;
      if (saveCalls === 2) throw new Error("disk full on commit");
      return real.store.save(doc);
    },
  };
  await assert.rejects(
    () =>
      runLoginMigration({
        selectedDomains: ["suno.com"],
        cookieStore,
        manifestStore: flakySaveStore,
        cdp: cdpFor(offer),
      }),
    /已自动回滚/,
  );
  assert.equal(cookieStore.jar.size, 0);
  const raw = JSON.parse(await readFile(path.join(real.dir, "manifest.json"), "utf8"));
  assert.equal(raw.entries[0].status, "rolled_back");
});

test("pending manifest write failure means nothing was injected", async () => {
  const cookieStore = makeCookieStore();
  const failingStore = {
    load: async () => ({ entries: [] }),
    save: async () => {
      throw new Error("disk full");
    },
  };
  const offer = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  await assert.rejects(
    () =>
      runLoginMigration({
        selectedDomains: ["suno.com"],
        cookieStore,
        manifestStore: failingStore,
        cdp: cdpFor(offer),
      }),
    /未注入任何 Cookie/,
  );
  assert.equal(cookieStore.jar.size, 0, "write-ahead failure must happen before injection");
});

test("manifest records the target space and rollback reports removedCount", async () => {
  const { store, dir } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  const suno = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  const space = { id: "default", partition: "abl-space-default" };

  await runLoginMigration({
    selectedDomains: ["suno.com"],
    cookieStore,
    manifestStore: store,
    cdp: cdpFor(suno),
    space,
  });

  const raw = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
  assert.deepEqual(raw.entries[0].space, space);

  const rolledBack = await rollbackLoginMigration({ cookieStore, manifestStore: store });
  assert.equal(typeof rolledBack.removedCount, "number");
  assert.ok(rolledBack.removedCount > 0);
  assert.deepEqual(rolledBack.space, space);
});

test("existing cookie conflicts abort the migration without overwriting (round-3 P0)", async () => {
  const { store, dir } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  const offer = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  // pre-existing login state that must never be overwritten
  await cookieStore.set({
    url: "https://suno.com/",
    name: "__client",
    value: "OLD-PRE-EXISTING",
    domain: ".suno.com",
    path: "/",
  });

  await assert.rejects(
    () =>
      runLoginMigration({
        selectedDomains: ["suno.com"],
        cookieStore,
        manifestStore: store,
        cdp: cdpFor(offer),
      }),
    (error) =>
      error.code === "migration_cookie_conflict" &&
      /已有同名登录态/.test(error.message) &&
      /请先回滚上次迁移或清理后再同步/.test(error.message),
  );

  const survivor = [...cookieStore.jar.values()].find(
    (cookie) => cookie.name === "__client",
  );
  assert.ok(survivor, "pre-existing cookie must survive");
  assert.equal(survivor.value, "OLD-PRE-EXISTING", "old value must be intact");
  assert.equal(cookieStore.jar.size, 1, "nothing else may be injected");
  const raw = await readFile(path.join(dir, "manifest.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch((error) => {
      if (error.code === "ENOENT") return { entries: [] }; // abort pre-write: no record at all
      throw error;
    });
  assert.equal(raw.entries.length, 0, "abort must happen before the write-ahead record");
});

test("same cookie name on an unrelated domain is not a conflict", async () => {
  const { store } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  await cookieStore.set({
    url: "https://other.example/",
    name: "__client",
    value: "unrelated-site-session",
    domain: ".other.example",
    path: "/",
  });
  const offer = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  const summary = await runLoginMigration({
    selectedDomains: ["suno.com"],
    cookieStore,
    manifestStore: store,
    cdp: cdpFor(offer),
  });
  assert.equal(summary.platforms[0].verified, true);
  const unrelated = [...cookieStore.jar.values()].find(
    (cookie) => cookie.domain === ".other.example",
  );
  assert.equal(unrelated.value, "unrelated-site-session");
});

test("rollback removes exactly the manifest-listed cookies", async () => {
  const { store } = await makeManifestStore();
  const cookieStore = makeCookieStore();
  const suno = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "suno");
  const netease = MIGRATION_PLATFORM_OFFERS.find((candidate) => candidate.platform === "netease-music");

  const first = await runLoginMigration({
    selectedDomains: ["suno.com"],
    cookieStore,
    manifestStore: store,
    cdp: cdpFor(suno),
  });
  await runLoginMigration({
    selectedDomains: ["music.163.com", "163.com"],
    cookieStore,
    manifestStore: store,
    cdp: cdpFor(netease),
  });

  const rolledBack = await rollbackLoginMigration({ cookieStore, manifestStore: store });
  assert.equal(rolledBack.id !== first.id, true, "latest migration is rolled back by default");
  assert.equal(rolledBack.platforms[0].platform, "netease-music");

  const remaining = [...cookieStore.jar.values()].map((cookie) => cookie.name);
  assert.deepEqual(remaining.sort(), [...suno.requiredCookieNames].sort());

  const specific = await rollbackLoginMigration({
    migrationId: first.id,
    cookieStore,
    manifestStore: store,
  });
  assert.equal(specific.platforms[0].platform, "suno");
  assert.equal(cookieStore.jar.size, 0);

  await assert.rejects(
    () => rollbackLoginMigration({ cookieStore, manifestStore: store }),
    /没有可回滚/,
  );
});
