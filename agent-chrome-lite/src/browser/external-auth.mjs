const GOOGLE_AUTH_HOSTS = new Set([
  "accounts.google.com",
  "accounts.googleusercontent.com",
  "oauth2.googleapis.com",
]);

const SUNO_AUTH_HOSTS = new Set(["suno.com", "www.suno.com", "app.suno.ai"]);
const AUTH_PATH = /\/(?:auth|login|signin|sign-in|oauth)(?:\/|$)/i;

function normalizeHostname(hostname) {
  return String(hostname || "").toLowerCase().replace(/\.$/, "");
}

/**
 * Google treats embedded OAuth user agents differently from a normal browser.
 * Keep this classifier deliberately narrow: only known authentication hosts
 * are eligible for an external-browser handoff, never an arbitrary URL.
 */
export function classifyExternalAuthUrl(value) {
  let url;
  try {
    url = new URL(String(value || ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const hostname = normalizeHostname(url.hostname);
  if (GOOGLE_AUTH_HOSTS.has(hostname)) {
    return {
      provider: "google",
      url: url.href,
      displayUrl: `${url.origin}${url.pathname}`,
    };
  }
  if (SUNO_AUTH_HOSTS.has(hostname) && AUTH_PATH.test(url.pathname)) {
    return {
      provider: "suno",
      url: url.href,
      displayUrl: `${url.origin}${url.pathname}`,
    };
  }
  return null;
}

export function isExternalAuthUrl(value) {
  return Boolean(classifyExternalAuthUrl(value));
}
