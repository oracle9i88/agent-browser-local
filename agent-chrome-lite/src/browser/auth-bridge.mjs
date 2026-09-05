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

function normalizedDomain(value) {
  return String(value || "").toLowerCase().replace(/^\./, "");
}

function cookieUrl(cookie) {
  const domain = normalizedDomain(cookie.domain);
  const host = domain === "suno.com" || domain.endsWith(".suno.com") ? domain : "app.suno.ai";
  return `https://${host}${cookie.path || "/"}`;
}

function normalizeSameSite(value) {
  const normalized = String(value || "").toLowerCase();
  if (normalized === "strict") return "strict";
  if (normalized === "lax") return "lax";
  if (normalized === "none" || normalized === "no_restriction") return "no_restriction";
  return undefined;
}

export function selectSunoAuthCookies(cookies) {
  return (Array.isArray(cookies) ? cookies : [])
    .filter((cookie) => AUTH_DOMAINS.has(normalizedDomain(cookie.domain)))
    .filter((cookie) => AUTH_COOKIE_NAMES.has(String(cookie.name || "")))
    .filter((cookie) => typeof cookie.value === "string" && cookie.value.length > 0)
    .map((cookie) => {
      const normalized = {
        url: cookieUrl(cookie),
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

export async function importSunoAuthCookies({ cookies, cookieStore }) {
  if (!cookieStore || typeof cookieStore.set !== "function") {
    throw new Error("Electron cookie store is unavailable");
  }
  const selected = selectSunoAuthCookies(cookies);
  if (selected.length === 0) {
    const error = new Error("Chrome 中没有可同步的 Suno 登录会话；请确认 Google 登录已完成并停留在 Suno 页面");
    error.code = "suno_auth_cookie_not_found";
    throw error;
  }
  for (const cookie of selected) await cookieStore.set(cookie);
  return { count: selected.length };
}
