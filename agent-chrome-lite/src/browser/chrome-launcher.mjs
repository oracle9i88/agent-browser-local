import { spawn } from "node:child_process";

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

