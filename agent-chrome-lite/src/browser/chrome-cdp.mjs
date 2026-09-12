import WebSocket from "ws";

export function normalizeEndpoint(value) {
  const raw = String(value || "http://127.0.0.1:9222").replace(/\/$/, "");
  const endpoint = new URL(raw);
  if (
    endpoint.protocol !== "http:" ||
    !new Set(["127.0.0.1", "localhost", "[::1]"]).has(endpoint.hostname)
  ) {
    const error = new Error("Chrome CDP endpoint must be loopback HTTP");
    error.code = "unsafe_chrome_cdp_endpoint";
    throw error;
  }
  return endpoint;
}

async function readJson(url, { timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Chrome DevTools HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function listChromeTargets({ endpoint, timeoutMs = 1500 } = {}) {
  const base = normalizeEndpoint(endpoint);
  const url = new URL("/json/list", base);
  let targets;
  try {
    targets = await readJson(url, { timeoutMs });
  } catch {
    const error = new Error(
      "Chrome 会话桥未运行。请先在迁移向导中点‘打开 Suno Chrome 会话桥’，并在该 Chrome 窗口登录 Suno。",
    );
    error.code = "chrome_cdp_unavailable";
    throw error;
  }
  return Array.isArray(targets) ? targets : [];
}

function sendCommand(socket, method, params = {}, { timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const id = Math.floor(Math.random() * 2 ** 31);
    const timer = setTimeout(() => finish(new Error(`Chrome CDP timeout: ${method}`)), timeoutMs);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const onMessage = (payload) => {
      let message;
      try {
        message = JSON.parse(String(payload));
      } catch {
        return;
      }
      if (message.id !== id) return;
      socket.off("message", onMessage);
      if (message.error) finish(new Error(message.error.message || "Chrome CDP command failed"));
      else finish(null, message.result || {});
    };
    socket.on("message", onMessage);
    socket.send(JSON.stringify({ id, method, params }), (error) => {
      if (error) {
        socket.off("message", onMessage);
        finish(error);
      }
    });
  });
}

export async function getChromeCookies(target, { timeoutMs = 5000 } = {}) {
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target has no debugger endpoint");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome CDP connection timeout")), timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  try {
    const result = await sendCommand(socket, "Network.getAllCookies", {}, { timeoutMs });
    return Array.isArray(result.cookies) ? result.cookies : [];
  } finally {
    socket.close();
  }
}

function hostnameOf(value) {
  try {
    return new URL(String(value || "")).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return "";
  }
}

/**
 * Pick the open Chrome tab whose URL host matches any of the given domains
 * (suffix match, so creator.douyin.com matches domain douyin.com).
 */
export function findChromeTargetForDomains(targets, domains) {
  const list = (Array.isArray(domains) ? domains : []).map((domain) =>
    String(domain || "").toLowerCase().replace(/^\./, ""),
  );
  if (list.length === 0) return null;
  return (
    (Array.isArray(targets) ? targets : []).find((target) => {
      const hostname = hostnameOf(target?.url);
      return list.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`));
    }) || null
  );
}

/**
 * Read cookies scoped to the given URLs at the protocol level
 * (Network.getCookies{urls}), so non-authorized cookies are never pulled
 * into memory in the first place. Used by the login-state migration only.
 */
export async function getChromeCookiesForUrls(
  target,
  urls,
  { timeoutMs = 5000 } = {},
) {
  if (!target?.webSocketDebuggerUrl) throw new Error("Chrome target has no debugger endpoint");
  const requestedUrls = (Array.isArray(urls) ? urls : []).filter(
    (url) => typeof url === "string" && url.startsWith("https://"),
  );
  if (requestedUrls.length === 0) return [];
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Chrome CDP connection timeout")), timeoutMs);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  try {
    const result = await sendCommand(
      socket,
      "Network.getCookies",
      { urls: requestedUrls },
      { timeoutMs },
    );
    return Array.isArray(result.cookies) ? result.cookies : [];
  } finally {
    socket.close();
  }
}

export function isSunoTarget(target) {
  try {
    const hostname = new URL(String(target?.url || "")).hostname.toLowerCase();
    return hostname === "suno.com" || hostname.endsWith(".suno.com") || hostname === "app.suno.ai";
  } catch {
    return false;
  }
}

export async function readSunoCookiesFromChrome(options = {}) {
  const targets = await listChromeTargets(options);
  const target = targets.find((candidate) => isSunoTarget(candidate));
  if (!target) {
    const error = new Error("Chrome 中没有打开 Suno 页面；请完成 Google 登录后保留 Suno 页面，再点同步认证");
    error.code = "suno_target_not_found";
    throw error;
  }
  return {
    targetUrl: target.url,
    cookies: await getChromeCookies(target, options),
  };
}

export function isGenSparkTarget(target) {
  try {
    const hostname = new URL(String(target?.url || "")).hostname.toLowerCase();
    return hostname === "genspark.ai" || hostname.endsWith(".genspark.ai");
  } catch {
    return false;
  }
}

export async function readGenSparkCookiesFromChrome(options = {}) {
  const targets = await listChromeTargets(options);
  const target = targets.find(isGenSparkTarget);
  if (!target) {
    const error = new Error("Chrome 中没有打开 GenSpark 页面；请完成 Google 登录后保留 GenSpark 页面，再点同步认证");
    error.code = "genspark_target_not_found";
    throw error;
  }
  return {
    targetUrl: target.url,
    cookies: await getChromeCookiesForUrls(
      target,
      ["https://www.genspark.ai/", "https://genspark.ai/"],
      options,
    ),
  };
}
