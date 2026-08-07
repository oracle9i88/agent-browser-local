const READ_ONLY_PATH = /\/(?:interaction|comments?|subscriber|followers?|fans?|audience|data-analysis|data-center|dashboard|profit|income|stats?|analytics?|insights?|search|feed|explore)(?:\/|$)/i;

function matchesPathPrefix(pathname, prefix) {
  if (prefix === "/") return true;
  const normalized = prefix.endsWith("/") ? prefix.slice(0, -1) : prefix;
  return pathname === normalized || pathname.startsWith(`${normalized}/`);
}

function matchesRequiredSearchParams(url, target) {
  const rules = target.requiredSearchParams;
  if (!rules) return true;
  return Object.entries(rules).every(([name, allowedValues]) => {
    const values = Array.isArray(allowedValues) ? allowedValues : [allowedValues];
    return values.includes(url.searchParams.get(name));
  });
}

export function isReadOnlyPlatformPath(pathname) {
  return READ_ONLY_PATH.test(String(pathname || ""));
}

export function isContributionUrlAllowed(config, value) {
  if (value === "about:blank") return true;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (isReadOnlyPlatformPath(url.pathname)) return false;
  return (config.security.contributionTargets || []).some((target) => {
    if (url.origin !== target.origin) return false;
    const prefixes = Array.isArray(target.pathPrefixes) ? target.pathPrefixes : ["/"];
    return (
      prefixes.some((prefix) => matchesPathPrefix(url.pathname, prefix)) &&
      matchesRequiredSearchParams(url, target)
    );
  });
}

export function assertContributionUrl(config, value) {
  if (!isContributionUrlAllowed(config, value)) {
    const error = new Error(
      "URL is outside the daemon's local contribution target allowlist",
    );
    error.code = "outside_contribution_scope";
    throw error;
  }
}
