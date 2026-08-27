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
  const { store } = await makeManifestStore();
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
    /已自动回滚/,
  );
  assert.equal(cookieStore.jar.size, 0, "injected cookies must be rolled back");
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
