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

async function verifyInjectedCookies(cookieStore, collected) {
  for (const cookie of collected.cookies) {
    const found = await cookieStore.get({ name: cookie.name, domain: cookie.domain });
    if (!Array.isArray(found) || found.length === 0) {
      throw sanitizedError(
        `迁移向导：${collected.label} 同步后验证未通过`,
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

function buildManifestEntry({ id, at, collected, sourceProfile, space, status }) {
  return {
    id,
    at,
    status,
    sourceProfile: sourceProfile ? String(sourceProfile) : "",
    plan: "login-state-cdp",
    space: space && typeof space === "object"
      ? { id: String(space.id || ""), partition: String(space.partition || "") }
      : { id: "default", partition: "abl-space-default" },
    platforms: collected.map((item) => ({
      platform: item.platform,
      label: item.label,
      domains: [...item.domains],
      plannedCount: item.cookies.length,
      // names/domains/paths only — cookie values never enter the manifest
      cookies: item.cookies.map((cookie) => ({
        name: cookie.name,
        domain: cookie.domain,
        path: cookie.path,
      })),
    })),
  };
}

/**
 * Best-effort removal of injected cookies. NEVER throws per-cookie: every
 * failure is collected so the caller can escalate instead of silently
 * reporting a rollback that did not fully happen.
 */
async function rollbackInjectedCookies(cookieStore, injectedCookies) {
  let succeeded = 0;
  const failures = [];
  for (const cookie of injectedCookies) {
    try {
      await cookieStore.remove(cookieUrl(cookie.domain, cookie.path), cookie.name);
      succeeded += 1;
    } catch (error) {
      failures.push({
        name: cookie.name,
        domain: cookie.domain,
        reason: String(error?.message || error).slice(0, 160),
      });
    }
  }
  return { succeeded, failed: failures.length, failures };
}

/**
 * Detect cookies already present in the agent space that would be overwritten
 * by this migration (same name + overlapping domain). Cookie store set()
 * replaces silently, and remove()-based rollback would then DESTROY the
 * pre-existing login state — so conflicts must abort the migration before
 * anything is injected. Only names/domains are ever reported, never values.
 */
async function findConflictingCookies(cookieStore, collected) {
  const conflicts = [];
  for (const item of collected) {
    for (const cookie of item.cookies) {
      let existing = [];
      try {
        existing = (await cookieStore.get({ name: cookie.name })) || [];
      } catch {
        existing =
          (await cookieStore.get({ name: cookie.name, domain: cookie.domain })) || [];
      }
      const hit = (Array.isArray(existing) ? existing : []).find((candidate) => {
        const a = normalizeDomain(candidate.domain);
        const b = normalizeDomain(cookie.domain);
        return hostMatchesDomain(a, b) || hostMatchesDomain(b, a);
      });
      if (hit) {
        conflicts.push({ platform: item.platform, label: item.label, name: cookie.name, domain: normalizeDomain(cookie.domain) });
      }
    }
  }
  return conflicts;
}

/**
 * Run one user-initiated login-state migration.
 *
 * Write-ahead manifest: a `pending` entry (cookie names/domains/paths only,
 * never values) is persisted BEFORE any injection. A crash between injection
 * and commit therefore always leaves a recoverable record; startup recovery
 * (recoverPendingMigrations) removes leftover cookies from pending entries.
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

  // 1. Pre-verify every platform BEFORE touching the agent cookie store.
  const collected = [];
  try {
    for (const { offer, domains } of selections) {
      collected.push(await collectPlatformCookies(offer, domains, cdp));
    }
  } catch (error) {
    for (const item of collected) {
      item.cookies = null;
    }
    throw error;
  }

  // 1.5 Destructive-overwrite guard: if the target space already holds a
  // same-name cookie, abort BEFORE writing anything. Rollback removes
  // cookies; it must never destroy pre-existing login state.
  const conflicts = await findConflictingCookies(cookieStore, collected);
  if (conflicts.length > 0) {
    for (const item of collected) {
      item.cookies = null;
    }
    const preview = conflicts
      .slice(0, 5)
      .map((conflict) => `${conflict.label}：${conflict.name}@${conflict.domain}`)
      .join("；");
    throw sanitizedError(
      `迁移向导：Agent 中已有同名登录态（${preview}${conflicts.length > 5 ? " 等" : ""}），为避免覆盖丢失，本次未同步。请先回滚上次迁移或清理后再同步`,
      "cookie_conflict",
    );
  }

  // 2. Write-ahead: persist the pending manifest before any injection.
  const entry = buildManifestEntry({
    id: `migration-${Date.now()}-${randomUUID().slice(0, 8)}`,
    at: now(),
    collected,
    sourceProfile,
    space,
    status: "pending",
  });
  const document_ = await manifestStore.load();
  document_.entries.push(entry);
  try {
    await manifestStore.save(document_);
  } catch (error) {
    for (const item of collected) {
      item.cookies = null;
    }
    throw sanitizedError(
      "迁移向导：迁移记录写入失败，本次未注入任何 Cookie",
      "manifest_write_failed",
    );
  }

  // 3. Inject with per-cookie rollback registration, then verify.
  const ledger = [];
  const noteFailure = async (statusField) => {
    entry[statusField] = now();
    try {
      await manifestStore.save(document_);
    } catch {
      // The pending entry is already persisted; startup recovery will still
      // find and clean it. Nothing else to do here.
    }
  };
  try {
    for (const item of collected) {
      for (const cookie of item.cookies) {
        await cookieStore.set(cookie);
        // register immediately: a later set() failure must not orphan
        // earlier cookies of the same platform
        ledger.push(cookie);
      }
      await verifyInjectedCookies(cookieStore, item);
    }
  } catch (error) {
    const rollback = await rollbackInjectedCookies(cookieStore, ledger);
    for (const item of collected) {
      item.cookies = null;
    }
    ledger.length = 0;
    if (rollback.failed > 0) {
      entry.rollbackFailed = true;
      entry.rollbackFailures = rollback.failed;
      await noteFailure("failedAt");
      throw sanitizedError(
        `迁移向导：同步失败，且自动回滚未完全完成（残留 ${rollback.failed} 项；下次启动时会自动继续清理）`,
        "rollback_failed",
      );
    }
    entry.status = "rolled_back";
    await noteFailure("rolledBackAt");
    // rethrow sanitized errors as-is; wrap raw store errors so no low-level
    // detail (possibly cookie metadata) escapes into the renderer
    if (error?.code?.startsWith("migration_")) throw error;
    throw sanitizedError("迁移向导：同步失败，已自动回滚本次同步的全部 Cookie", "inject_failed");
  }

  // 4. Commit.
  entry.status = "committed";
  entry.committedAt = now();
  try {
    await manifestStore.save(document_);
  } catch (error) {
    const rollback = await rollbackInjectedCookies(cookieStore, ledger);
    for (const item of collected) {
      item.cookies = null;
    }
    ledger.length = 0;
    if (rollback.failed > 0) {
      entry.rollbackFailed = true;
      entry.rollbackFailures = rollback.failed;
      entry.status = "pending";
      await noteFailure("failedAt");
      throw sanitizedError(
        `迁移向导：迁移状态写入失败，自动回滚未完全完成（残留 ${rollback.failed} 项；下次启动时会自动继续清理）`,
        "rollback_failed",
      );
    }
    entry.status = "rolled_back";
    await noteFailure("rolledBackAt");
    throw sanitizedError(
      "迁移向导：迁移状态写入失败，已自动回滚本次同步的全部 Cookie",
      "manifest_commit_failed",
    );
  }

  // Drop all cookie material (constraint 6) — counts captured first.
  const plannedCounts = collected.map((item) => item.cookies.length);
  for (const item of collected) {
    item.cookies = null;
  }
  ledger.length = 0;

  return {
    id: entry.id,
    platforms: collected.map((item, index) => ({
      platform: item.platform,
      label: item.label,
      domains: [...item.domains],
      injectedCount: plannedCounts[index],
      verified: true,
      startUrl: MIGRATION_PLATFORM_OFFERS.find((offer) => offer.platform === item.platform)?.startUrl,
    })),
  };
}
/**
 * Roll back the latest (or a specific) migration by removing exactly the
 * cookies listed in the manifest. Only manifest-listed cookies are touched —
 * the rest of the agent profile is never modified (constraint 8).
 * Removal failures are escalated (migration_rollback_failed), never silently
 * swallowed; the entry stays eligible for startup recovery.
 */
export async function rollbackLoginMigration({
  migrationId,
  cookieStore,
  manifestStore,
} = {}) {
  const document = await manifestStore.load();
  const entries = document.entries.filter(
    (entry) => !entry.rolledBackAt && entry.status !== "rolled_back",
  );
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
  const listed = [];
  for (const platform of entry.platforms) {
    for (const cookie of platform.cookies || platform.injectedCookies || []) {
      listed.push(cookie);
    }
  }
  const rollback = await rollbackInjectedCookies(cookieStore, listed);
  entry.removedCount = rollback.succeeded;
  if (rollback.failed > 0) {
    entry.rollbackFailed = true;
    entry.rollbackFailures = rollback.failed;
    try {
      await manifestStore.save(document);
    } catch {
      // pending record stays on disk; startup recovery will retry
    }
    throw sanitizedError(
      `迁移向导：回滚未完全完成（${rollback.failed} 项未能移除；下次启动时会自动继续清理）`,
      "rollback_failed",
    );
  }
  entry.rolledBackAt = new Date().toISOString();
  entry.status = "rolled_back";
  await manifestStore.save(document);
  return {
    id: entry.id,
    removedCount: rollback.succeeded,
    space: entry.space,
    platforms: entry.platforms.map((platform) => ({
      platform: platform.platform,
      label: platform.label,
    })),
  };
}

/**
 * Startup recovery: pending entries are either unfinished migrations or
 * migrations whose rollback did not fully complete. Remove every listed
 * cookie (removal is idempotent) and mark the entry recovered. Entries only
 * ever list cookies that passed the conflict guard (i.e. genuinely new
 * cookies), so recovery can never destroy pre-existing login state.
 * Returns a counts-only summary safe for logs.
 */
export async function recoverPendingMigrations({
  cookieStore,
  manifestStore,
  now = () => new Date().toISOString(),
} = {}) {
  if (!cookieStore || typeof cookieStore.remove !== "function") {
    throw sanitizedError("迁移向导：Agent Cookie 存储不可用", "cookie_store_unavailable");
  }
  const document = await manifestStore.load();
  const pending = document.entries.filter(
    (entry) => entry.status === "pending" || (!entry.status && !entry.rolledBackAt && !entry.committedAt),
  );
  let removed = 0;
  let failed = 0;
  for (const entry of pending) {
    const listed = [];
    for (const platform of entry.platforms || []) {
      for (const cookie of platform.cookies || platform.injectedCookies || []) {
        listed.push(cookie);
      }
    }
    const rollback = await rollbackInjectedCookies(cookieStore, listed);
    removed += rollback.succeeded;
    failed += rollback.failed;
    if (rollback.failed === 0) {
      entry.status = "rolled_back";
      entry.recoveredAt = now();
      entry.removedCount = rollback.succeeded;
    } else {
      entry.rollbackFailed = true;
      entry.rollbackFailures = rollback.failed;
    }
  }
  if (pending.length > 0) {
    try {
      await manifestStore.save(document);
    } catch {
      // keep retrying on next startup
    }
  }
  return { entries: pending.length, removed, failed };
}
