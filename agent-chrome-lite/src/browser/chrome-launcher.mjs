import { spawn } from "node:child_process";
import path from "node:path";

function runDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with code ${code}`));
    });
    child.unref();
  });
}

function startDetached(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

function bridgePort(endpoint) {
  const parsed = new URL(String(endpoint || "http://127.0.0.1:9222"));
  if (
    parsed.protocol !== "http:" ||
    !new Set(["127.0.0.1", "localhost", "[::1]"]).has(parsed.hostname)
  ) {
    throw new Error("Chrome session bridge endpoint must be loopback HTTP");
  }
  return Number(parsed.port || 80);
}

/**
 * Start a real Chrome instance with a dedicated persistent profile and a
 * loopback-only DevTools endpoint. Modern Chrome ignores remote-debugging on
 * its default profile, so attaching to an already-running everyday profile is
 * not reliable. The user signs in once in this separate Chrome profile; only
 * explicitly selected platform cookies are later imported into Agent Space.
 */
export async function openChromeSessionBridge({
  url = "https://suno.com/",
  endpoint = "http://127.0.0.1:9222",
  profileDir,
  platform = process.platform,
} = {}) {
  const parsedUrl = new URL(url);
  if (
    parsedUrl.protocol !== "https:" ||
    !(parsedUrl.hostname === "suno.com" || parsedUrl.hostname.endsWith(".suno.com"))
  ) {
    throw new Error("Chrome session bridge only opens an HTTPS Suno URL");
  }
  if (!profileDir || !path.isAbsolute(profileDir)) {
    throw new Error("Chrome session bridge requires an absolute profile directory");
  }
  const args = [
    `--remote-debugging-address=127.0.0.1`,
    `--remote-debugging-port=${bridgePort(endpoint)}`,
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    parsedUrl.href,
  ];
  if (platform === "darwin") {
    await startDetached(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      args,
    );
    return { browser: "Google Chrome", profile: "dedicated", endpoint };
  }
  if (platform === "win32") {
    const executable = `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`;
    await startDetached(executable, args);
    return { browser: "Google Chrome", profile: "dedicated", endpoint };
  }
  await startDetached("google-chrome", args);
  return { browser: "Google Chrome", profile: "dedicated", endpoint };
}

/**
 * Launch the user's normal Chrome profile without copying cookies into the
 * Electron profile. Auth state therefore stays owned by Chrome, where Google
 * expects a real browser identity.
 */
export async function openInChrome(url, { platform = process.platform } = {}) {
  if (platform === "darwin") {
    await runDetached("/usr/bin/open", ["-a", "Google Chrome", url]);
    return { browser: "Google Chrome", method: "open" };
  }

  if (platform === "win32") {
    const candidates = [
      `${process.env.PROGRAMFILES || "C:\\Program Files"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)"}\\Google\\Chrome\\Application\\chrome.exe`,
      `${process.env.LOCALAPPDATA || ""}\\Google\\Chrome\\Application\\chrome.exe`,
    ];
    let lastError;
    for (const executable of candidates) {
      try {
        await runDetached(executable, [url]);
        return { browser: "Google Chrome", method: "executable" };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("Google Chrome executable was not found");
  }

  let lastError;
  for (const executable of ["google-chrome", "google-chrome-stable", "chromium"]) {
    try {
      await runDetached(executable, [url]);
      return { browser: executable, method: "executable" };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("A Chrome-compatible browser was not found");
}
