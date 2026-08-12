import { isContributionUrlAllowed } from "./contribution-policy.mjs";

const REMOTE_SCHEMES = new Set(["http:", "https:", "ws:", "wss:"]);
const LOCAL_DOCUMENT_SCHEMES = new Set(["about:", "blob:", "data:"]);

function normalizedHostname(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
}

export function isPrivateNetworkHostname(value) {
  const hostname = normalizedHostname(value);
  if (!hostname) return false;
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname === "::" ||
    hostname === "::1" ||
    hostname === "0:0:0:0:0:0:0:1" ||
    (hostname.includes(":") &&
      (/^f[cd]/i.test(hostname) || /^fe[89ab]/i.test(hostname)))
  ) {
    return true;
  }

  if (hostname.startsWith("::ffff:")) {
    const tail = hostname.slice("::ffff:".length);
    if (tail.includes(".")) return isPrivateNetworkHostname(tail);
    const groups = tail.split(":");
    if (groups.length === 2 && groups.every((group) => /^[0-9a-f]{1,4}$/i.test(group))) {
      const high = Number.parseInt(groups[0], 16);
      const low = Number.parseInt(groups[1], 16);
      return isPrivateNetworkHostname(
        `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`,
      );
    }
  }

  const parts = hostname.split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d+$/.test(part))) {
    return false;
  }
  const octets = parts.map(Number);
  if (octets.some((part) => part < 0 || part > 255)) return false;
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

export function classifyPageRequest(details, config) {
  const rawUrl = String(details?.url || "");
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return {
      allowed: false,
      code: "invalid_outbound_url",
      reason: "页面请求使用了无效 URL。",
    };
  }

  if (LOCAL_DOCUMENT_SCHEMES.has(url.protocol)) {
    return { allowed: true, localOnly: true };
  }
  if (!REMOTE_SCHEMES.has(url.protocol)) {
    return {
      allowed: false,
      code: "unsafe_outbound_scheme",
      reason: `页面不得访问 ${url.protocol || "unknown"} 协议。`,
    };
  }
  if (url.username || url.password) {
    return {
      allowed: false,
      code: "embedded_credentials_blocked",
      reason: "页面不得在网络地址中携带账号或密码。",
    };
  }
  if (isPrivateNetworkHostname(url.hostname)) {
    return {
      allowed: false,
      code: "private_network_blocked",
      reason: "不可信页面不得访问本机、回环或私有网络服务。",
    };
  }

  const mainFrame = details?.resourceType === "mainFrame";
  if (
    mainFrame &&
    ["http:", "https:"].includes(url.protocol) &&
    !isContributionUrlAllowed(config, url.href)
  ) {
    return {
      allowed: true,
      requiresHandoff: true,
      code: "outside_contribution_scope",
      reason: "页面离开投稿范围，自动化必须暂停并交给用户。",
    };
  }
  return { allowed: true };
}

export function installNetworkEgressPolicy({
  browserSession,
  config,
  onBlocked = () => undefined,
  onMainFrameEscape = () => undefined,
}) {
  const protectedWebContentsIds = new Set();

  browserSession.webRequest.onBeforeRequest(
    { urls: ["<all_urls>"] },
    (details, callback) => {
      if (!protectedWebContentsIds.has(details.webContentsId)) {
        callback({ cancel: false });
        return;
      }
      const decision = classifyPageRequest(details, config);
      if (!decision.allowed) {
        onBlocked(decision, details);
        callback({ cancel: true });
        return;
      }
      if (decision.requiresHandoff) {
        onMainFrameEscape(decision, details);
      }
      callback({ cancel: false });
    },
  );

  browserSession.setPermissionRequestHandler(
    (_webContents, _permission, callback) => callback(false),
  );
  browserSession.setPermissionCheckHandler?.(() => false);
  browserSession.setDevicePermissionHandler?.(() => false);
  browserSession.setDisplayMediaRequestHandler?.((_request, callback) =>
    callback({}),
  );

  return Object.freeze({
    register(webContents) {
      protectedWebContentsIds.add(webContents.id);
      webContents.once("destroyed", () => {
        protectedWebContentsIds.delete(webContents.id);
      });
    },
    isRegistered(webContents) {
      return protectedWebContentsIds.has(webContents.id);
    },
  });
}
