import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  findChromeTargetForDomains,
  getChromeCookiesForUrls,
  listChromeTargets,
} from "../browser/chrome-cdp.mjs";

/**
 * Login-state migration (Plan A, audited wording):
 *
 * The CDP session bridge reads cookies at URL scope
 * (Network.getCookies{urls}). Chrome returns ALL cookies under those URLs,
 * so cookies whose names are not on the platform whitelist DO briefly enter
 * main-process memory; they are synchronously filtered on receipt and
 * immediately dropped. Authorized cookie plaintext values are handled inside
 * the Electron MAIN PROCESS only, then injected into the target agent space's
 * cookie store. Cookie values are never persisted, displayed, logged,
 * exported, sent to the renderer, the daemon API, audit logs or agent
 * snapshots.
 */

// Google identity domains must never be imported (hard deny, belt-and-braces
// on top of the structural allowlist: none of the offers contain them).
export const MIGRATION_DENIED_DOMAIN_SUFFIXES = Object.freeze([
  "google.com",
  "accounts.youtube.com",
]);

/**
 * Per-platform cookie whitelists. Whole-site imports are forbidden: only
 * these explicitly listed cookie names, on these explicitly listed domains,
 * may ever be pulled from Chrome. Names are proposals for Codex audit; the
 * requiredCookieNames gate the pre-sync login verification.
 */
export const MIGRATION_PLATFORM_OFFERS = Object.freeze([
  {
    platform: "suno",
    label: "Suno",
    startUrl: "https://app.suno.ai",
    domains: Object.freeze(["suno.com", "auth.suno.com", "app.suno.ai"]),
    requiredCookieNames: Object.freeze(["__client", "__session"]),
    cookieNames: Object.freeze([
      "__client",
      "__session",
      "__client_uat",
      "__clerk_db_jwt",
    ]),
  },
  {
    platform: "wechat-mp",
    label: "微信公众号",
    startUrl: "https://mp.weixin.qq.com",
    domains: Object.freeze(["mp.weixin.qq.com"]),
    requiredCookieNames: Object.freeze(["slave_sid"]),
    cookieNames: Object.freeze([
      "slave_user",
      "slave_sid",
      "pass_ticket",
      "data_bizuin",
      "bizuin",
    ]),
  },
  {
    platform: "douyin",
    label: "抖音创作者",
    startUrl: "https://creator.douyin.com",
    domains: Object.freeze(["douyin.com", "creator.douyin.com"]),
    requiredCookieNames: Object.freeze(["sessionid"]),
    cookieNames: Object.freeze([
      "sessionid",
      "sessionid_ss",
      "sid_tt",
      "sid_guard",
      "uid_tt",
      "ttwid",
    ]),
  },
  {
    platform: "xiaohongshu",
    label: "小红书",
    startUrl: "https://creator.xiaohongshu.com",
    domains: Object.freeze(["xiaohongshu.com", "creator.xiaohongshu.com"]),
    requiredCookieNames: Object.freeze(["web_session"]),
    cookieNames: Object.freeze(["web_session", "a1", "webId"]),
  },
  {
    platform: "kuaishou",
    label: "快手",
    startUrl: "https://cp.kuaishou.com",
    domains: Object.freeze(["kuaishou.com", "cp.kuaishou.com"]),
    requiredCookieNames: Object.freeze(["passToken"]),
    cookieNames: Object.freeze([
      "passToken",
      "userId",
      "kuaishou.server.webday7_st",
      "kuaishou.server.webday7_ph",
    ]),
  },
  {
    platform: "netease-music",
    label: "网易云音乐",
    startUrl: "https://music.163.com",
    domains: Object.freeze(["163.com", "music.163.com"]),
    requiredCookieNames: Object.freeze(["MUSIC_U"]),
    cookieNames: Object.freeze(["MUSIC_U", "NMTID", "NTES_SESS"]),
  },
]);

function normalizeDomain(value) {
  return String(value || "").toLowerCase().replace(/^\./, "").replace(/\.$/, "");
}

function isDeniedDomain(domain) {
  const host = normalizeDomain(domain);
  return MIGRATION_DENIED_DOMAIN_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

function hostMatchesDomain(hostname, domain) {
  const host = normalizeDomain(hostname);
  const base = normalizeDomain(domain);
  return host === base || host.endsWith(`.${base}`);
}

export function listMigrationOffers() {
  return MIGRATION_PLATFORM_OFFERS.map((offer) => ({
    platform: offer.platform,
    label: offer.label,
    startUrl: offer.startUrl,
    domains: [...offer.domains],
    cookieNames: [...offer.cookieNames],
    requiredCookieNames: [...offer.requiredCookieNames],
  }));
}

/**
 * The user selects individual domains in the wizard (constraint: 逐域勾选).
 * Selections must be an exact subset of the offer allowlist; Google identity
 * domains and anything unknown are rejected here (constraint: Agent 不得自行
 * 决定域名；向导白名单之外的域名无法进入流程).
 */
export function validateMigrationSelection(selectedDomains) {
  if (!Array.isArray(selectedDomains) || selectedDomains.length === 0) {
    throw sanitizedError("迁移向导：至少需要勾选一个域名", "empty_selection");
  }
  const allowlisted = new Set(
    MIGRATION_PLATFORM_OFFERS.flatMap((offer) => offer.domains).map(normalizeDomain),
  );
  const seen = new Set();
  for (const raw of selectedDomains) {
    const domain = normalizeDomain(raw);
    if (isDeniedDomain(domain)) {
      throw sanitizedError(
        `迁移向导：域名 ${domain} 属于身份认证域，永远禁止导入`,
        "denied_domain",
      );
    }
    if (!allowlisted.has(domain)) {
      throw sanitizedError(
        `迁移向导：域名 ${domain} 不在任何平台白名单中`,
        "unknown_domain",
      );
    }
    if (seen.has(domain)) {
      throw sanitizedError(`迁移向导：域名 ${domain} 重复选择`, "duplicate_domain");
    }
    seen.add(domain);
  }

  const selections = [];
  for (const offer of MIGRATION_PLATFORM_OFFERS) {
    const domains = offer.domains.filter((domain) => seen.has(normalizeDomain(domain)));
    if (domains.length > 0) selections.push({ offer, domains });
  }
  return selections;
}

function sanitizedError(message, code) {
  const error = new Error(message);
  error.code = `migration_${code}`;
  return error;
}

function cookieUrl(domain, cookiePath) {
  const host = normalizeDomain(domain);
  return `https://${host}${cookiePath && cookiePath.startsWith("/") ? cookiePath : "/"}`;
}

function normalizeCookieForInjection(cookie, selectedDomains) {
  const domain = normalizeDomain(cookie.domain);
  if (!selectedDomains.some((selected) => hostMatchesDomain(domain, selected))) return null;
  return {
    url: cookieUrl(domain, cookie.path),
    name: String(cookie.name),
    value: String(cookie.value),
    domain: cookie.domain,
    path: cookie.path || "/",
    secure: cookie.secure !== false,
    httpOnly: cookie.httpOnly === true,
    ...(normalizeSameSite(cookie.sameSite) ? { sameSite: normalizeSameSite(cookie.sameSite) } : {}),
    ...(Number.isFinite(cookie.expires) && cookie.expires > 0
      ? { expirationDate: cookie.expires }
      : {}),
  };
}

function normalizeSameSite(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "strict") return "strict";
  if (normalized === "lax") return "lax";
  if (normalized === "none" || normalized === "no_restriction") return "no_restriction";
  return undefined;
}

function defaultCdpAdapter(endpoint) {
  return {
    listTargets: () => listChromeTargets({ endpoint }),
    getCookiesForUrls: (target, urls) => getChromeCookiesForUrls(target, urls),
  };
}

/**
 * Pull cookies for one platform from the running Chrome instance over CDP.
 * NOTE (honest scope): Network.getCookies{urls} returns every cookie under
 * the selected URLs; non-whitelisted names briefly exist in main-process
 * memory and are synchronously discarded in the loop below. Only
 * whitelist-matching cookies are normalized and kept.
 * Returns { platform, domains, cookies } — cookies never leave this scope.
 */
async function collectPlatformCookies(offer, domains, cdp) {
  const targets = await cdp.listTargets();
  const target = findChromeTargetForDomains(targets, domains);
  if (!target) {
    throw sanitizedError(
      `迁移向导：Chrome 中没有打开 ${offer.label} 页面。请先在 Chrome 登录 ${offer.label} 并保留页面，再点开始同步`,
      `${offer.platform}_target_not_found`,
    );
  }
  const urls = domains.map((domain) => `https://${normalizeDomain(domain)}/`);
  const rawCookies = await cdp.getCookiesForUrls(target, urls);
  const nameAllowlist = new Set(offer.cookieNames);
  const injected = [];
  for (const cookie of Array.isArray(rawCookies) ? rawCookies : []) {
    if (!nameAllowlist.has(String(cookie.name))) continue;
    const normalized = normalizeCookieForInjection(cookie, domains);
    if (normalized) injected.push(normalized);
  }
  const missing = offer.requiredCookieNames.filter(
    (name) => !injected.some((cookie) => cookie.name === name),
  );
  if (missing.length > 0) {
    throw sanitizedError(
      `迁移向导：${offer.label} 同步前验证未通过（Chrome 中未找到登录会话 Cookie）。请确认已在 Chrome 中完成登录`,
      `${offer.platform}_precheck_failed`,
    );
  }
  return { platform: offer.platform, label: offer.label, domains, cookies: injected, targetUrl: target.url };
}

async function injectPlatformCookies(cookieStore, collected) {
  if (!cookieStore || typeof cookieStore.set !== "function" || typeof cookieStore.get !== "function" || typeof cookieStore.remove !== "function") {
    throw sanitizedError("迁移向导：Agent Cookie 存储不可用", "cookie_store_unavailable");
  }
  let injected = 0;
  for (const cookie of collected.cookies) {
    await cookieStore.set(cookie);
    injected += 1;
  }
  return injected;
}

async function verifyInjectedCookies(cookieStore, collected) {
  for (const cookie of collected.cookies) {
    const found = await cookieStore.get({ name: cookie.name, domain: cookie.domain });
    if (!Array.isArray(found) || found.length === 0) {
      throw sanitizedError(
        `迁移向导：${collected.label} 同步后验证未通过，已自动回滚`,
        `${collected.platform}_postcheck_failed`,
      );
    }
  }
}

export function createManifestStore(manifestDir, { manifestName = "manifest.json" } = {}) {
  const manifestPath = path.join(manifestDir, manifestName);
  async function load() {
    try {
      const raw = await readFile(manifestPath, "utf8");
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed?.entries) ? parsed : { entries: [] };
    } catch {
      return { entries: [] };
    }
  }
  async function save(document) {
    await mkdir(manifestDir, { recursive: true });
    const tempPath = path.join(manifestDir, `${manifestName}.${process.pid}.tmp`);
    await writeFile(tempPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(tempPath, manifestPath);
  }
  return { load, save, manifestPath };
}

function buildManifestEntry({ id, at, results, sourceProfile, space }) {
  return {
    id,
    at,
    sourceProfile: sourceProfile ? String(sourceProfile) : "",
    plan: "login-state-cdp",
    space: space && typeof space === "object"
      ? { id: String(space.id || ""), partition: String(space.partition || "") }
      : { id: "default", partition: "abl-space-default" },
    platforms: results.map((result) => ({
      platform: result.platform,
      label: result.label,
      domains: [...result.domains],
      injectedCount: result.injectedCount,
      injectedCookies: result.injectedCookies.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      })),
      verified: true,
    })),
  };
}

/**
 * Run one user-initiated login-state migration.
 *
 * Contract (Codex constraints 1-9):
 * - called only from the wizard's explicit "开始同步" action (IPC wiring);
 * - domains pre-validated against the offer allowlist + hard denylist;
 * - CDP reads are URL-scoped; cookies filtered by per-platform name whitelist;
 * - values live only in this function's scope, injected via the main-process
 *   cookie store, then dropped; summaries/manifest/errors carry counts,
 *   domains and cookie NAMES only.
 */
export async function runLoginMigration({
  selectedDomains,
  endpoint = process.env.ABL_CHROME_CDP_URL || "http://127.0.0.1:9222",
  cookieStore,
  manifestStore,
  space = null,
  cdp = defaultCdpAdapter(endpoint),
  sourceProfile = "",
  now = () => new Date().toISOString(),
} = {}) {
  const selections = validateMigrationSelection(selectedDomains);
  if (!manifestStore || typeof manifestStore.load !== "function" || typeof manifestStore.save !== "function") {
    throw sanitizedError("迁移向导：manifest 存储不可用", "manifest_store_unavailable");
  }

  // Pre-verify every platform BEFORE touching the agent cookie store, so a
  // partial failure can never leave a half-migrated profile (constraint 8).
  const collected = [];
  try {
    for (const { offer, domains } of selections) {
      collected.push(await collectPlatformCookies(offer, domains, cdp));
    }
  } catch (error) {
    for (const entry of collected) {
      entry.cookies = null;
    }
    throw error;
  }

  const injectedCookies = [];
  const results = [];
  try {
    for (const entry of collected) {
      const injectedCount = await injectPlatformCookies(cookieStore, entry);
      // Register for rollback BEFORE verifying, so a failed postcheck rolls
      // back everything injected so far (constraint 8).
      injectedCookies.push(...entry.cookies);
      await verifyInjectedCookies(cookieStore, entry);
      results.push({
        platform: entry.platform,
        label: entry.label,
        domains: entry.domains,
        injectedCount,
        injectedCookies: entry.cookies,
        targetUrl: entry.targetUrl,
      });
    }
  } catch (error) {
    // Auto-rollback anything already injected (constraint 8).
    await rollbackInjectedCookies(cookieStore, injectedCookies).catch(() => undefined);
    for (const entry of collected) {
      entry.cookies = null;
    }
    throw error;
  }

  const entry = buildManifestEntry({
    id: `migration-${Date.now()}-${randomUUID().slice(0, 8)}`,
    at: now(),
    results,
    sourceProfile,
    space,
  });
  const document_ = await manifestStore.load();
  document_.entries.push(entry);
  try {
    await manifestStore.save(document_);
  } catch (error) {
    // Without a persisted manifest there is no rollback record, so the only
    // safe outcome is a full rollback of everything injected (constraint 8).
    await rollbackInjectedCookies(cookieStore, injectedCookies).catch(() => undefined);
    for (const result of results) {
      result.injectedCookies = null;
    }
    for (const item of collected) {
      item.cookies = null;
    }
    injectedCookies.length = 0;
    throw sanitizedError(
      "迁移向导：迁移记录写入失败，已自动回滚本次同步的全部 Cookie",
      "manifest_save_failed",
    );
  }

  // Drop all cookie material (constraint 6).
  for (const result of results) {
    result.injectedCookies = null;
  }
  for (const item of collected) {
    item.cookies = null;
  }
  injectedCookies.length = 0;

  return {
    id: entry.id,
    platforms: results.map((result) => ({
      platform: result.platform,
      label: result.label,
      domains: [...result.domains],
      injectedCount: result.injectedCount,
      verified: true,
      startUrl: MIGRATION_PLATFORM_OFFERS.find((offer) => offer.platform === result.platform)?.startUrl,
    })),
  };
}

async function rollbackInjectedCookies(cookieStore, injectedCookies) {
  for (const cookie of injectedCookies) {
    await cookieStore.remove(cookieUrl(cookie.domain, cookie.path), cookie.name);
  }
}

/**
 * Roll back the latest (or a specific) migration by removing exactly the
 * cookies listed in the manifest. Only manifest-listed cookies are touched —
 * the rest of the agent profile is never modified (constraint 8).
 */
export async function rollbackLoginMigration({
  migrationId,
  cookieStore,
  manifestStore,
} = {}) {
  const document = await manifestStore.load();
  const entries = document.entries.filter((entry) => !entry.rolledBackAt);
  if (entries.length === 0) {
    throw sanitizedError("迁移向导：没有可回滚的迁移记录", "nothing_to_rollback");
  }
  const entry = migrationId
    ? entries.find((candidate) => candidate.id === migrationId)
    : entries[entries.length - 1];
  if (!entry) {
    throw sanitizedError("迁移向导：找不到指定的迁移记录", "migration_not_found");
  }
  if (!cookieStore || typeof cookieStore.remove !== "function") {
    throw sanitizedError("迁移向导：Agent Cookie 存储不可用", "cookie_store_unavailable");
  }
  let removed = 0;
  for (const platform of entry.platforms) {
    for (const cookie of platform.injectedCookies) {
      await cookieStore.remove(cookieUrl(cookie.domain, cookie.path), cookie.name);
      removed += 1;
    }
  }
  entry.rolledBackAt = new Date().toISOString();
  entry.removedCount = removed;
  await manifestStore.save(document);
  return {
    id: entry.id,
    removedCount: removed,
    space: entry.space,
    platforms: entry.platforms.map((platform) => ({
      platform: platform.platform,
      label: platform.label,
    })),
  };
}
