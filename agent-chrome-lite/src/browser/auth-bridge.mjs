const AUTH_COOKIE_NAMES = new Set([
  "__session",
  "__session_Jnxw-muT",
  "__client",
  "__client_Jnxw-muT",
  "sessionid",
  "__client_uat",
  "__client_uat_Jnxw-muT",
  "clerk_active_context",
  "suno_session_recoverable",
]);

const AUTH_DOMAINS = new Set(["suno.com", "auth.suno.com", "app.suno.ai"]);

// GenSpark 会话：实测为自管会话（非 Clerk），httpOnly 的 c2 是会话 Cookie，
// from_auth 为 OAuth 回跳标记；按域过滤后仍只允许白名单名。
const GENSPARK_AUTH_DOMAINS = new Set(["genspark.ai", "www.genspark.ai"]);
const GENSPARK_AUTH_COOKIE_NAMES = new Set([
  "c2",
  "from_auth",
  "g_state",
]);

function normalizedDomain(value) {
  return String(value || "").toLowerCase().replace(/^\./, "");
}

function cookieUrl(cookie) {
  const domain = normalizedDomain(cookie.domain);
  const host = domain === "suno.com" || domain.endsWith(".suno.com") ? domain : "app.suno.ai";
  return `https://${host}${cookie.path || "/"}`;
}

function gensparkCookieUrl(cookie) {
  const domain = normalizedDomain(cookie.domain);
  const host = domain === "genspark.ai" || domain.endsWith(".genspark.ai") ? domain : "www.genspark.ai";
  return `https://${host}${cookie.path || "/"}`;
}

function normalizeSameSite(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "strict") return "strict";
  if (normalized === "lax") return "lax";
  if (normalized === "none" || normalized === "no_restriction") return "no_restriction";
  return undefined;
}

function selectAuthCookies(cookies, { domains, names, urlFor }) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => domains.has(normalizedDomain(cookie.domain)))
    .filter((cookie) => names.has(String(cookie.name || "")))
    .filter((cookie) => typeof cookie.value === "string" && cookie.value.length > 0)
    .map((cookie) => {
      const normalized = {
        url: urlFor(cookie),
        name: String(cookie.name),
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path || "/",
        secure: cookie.secure !== false,
        httpOnly: cookie.httpOnly === true,
      };
      const sameSite = normalizeSameSite(cookie.sameSite);
      if (sameSite) normalized.sameSite = sameSite;
      if (Number.isFinite(cookie.expires) && cookie.expires > 0) {
        normalized.expirationDate = cookie.expires;
      }
      return normalized;
    });
}

export function selectSunoAuthCookies(cookies) {
  return selectAuthCookies(cookies, {
    domains: AUTH_DOMAINS,
    names: AUTH_COOKIE_NAMES,
    urlFor: cookieUrl,
  });
}

export function selectGenSparkAuthCookies(cookies) {
  return selectAuthCookies(cookies, {
    domains: GENSPARK_AUTH_DOMAINS,
    names: GENSPARK_AUTH_COOKIE_NAMES,
    urlFor: gensparkCookieUrl,
  });
}

async function importAuthCookies({ cookies, cookieStore, select, emptyCode, emptyMessage }) {
  if (!cookieStore || typeof cookieStore.set !== "function") {
    throw new Error("Electron cookie store is unavailable");
  }
  const selected = select(cookies);
  if (selected.length === 0) {
    const error = new Error(emptyMessage);
    error.code = emptyCode;
    throw error;
  }
  for (const cookie of selected) await cookieStore.set(cookie);
  return { count: selected.length };
}

export async function importSunoAuthCookies({ cookies, cookieStore }) {
  return importAuthCookies({
    cookies,
    cookieStore,
    select: selectSunoAuthCookies,
    emptyCode: "suno_auth_cookie_not_found",
    emptyMessage: "Chrome 中没有可同步的 Suno 登录会话；请确认 Google 登录已完成并停留在 Suno 页面",
  });
}

export async function importGenSparkAuthCookies({ cookies, cookieStore }) {
  return importAuthCookies({
    cookies,
    cookieStore,
    select: selectGenSparkAuthCookies,
    emptyCode: "genspark_auth_cookie_not_found",
    emptyMessage: "Chrome 中没有可同步的 GenSpark 登录会话；请确认 Google 登录已完成并停留在 GenSpark 页面",
  });
}
