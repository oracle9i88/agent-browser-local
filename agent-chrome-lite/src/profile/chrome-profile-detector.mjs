import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const LOCK_MARKERS = [
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "lockfile",
];

const PROFILE_DIR_PATTERN = /^(Default|Profile \d+)$/;

/**
 * Resolve the default Chrome user-data directory for the current platform.
 * The detector only ever reads from this tree; it never writes, renames or
 * deletes anything inside the user's Chrome profile (audit constraint C1).
 */
export function defaultChromeUserDataURL({
  platform = process.platform,
  homeDir = os.homedir(),
} = {}) {
  if (platform === "darwin") {
    return path.join(
      homeDir,
      "Library",
      "Application Support",
      "Google",
      "Chrome",
    );
  }
  if (platform === "win32") {
    return path.join(
      homeDir,
      "AppData",
      "Local",
      "Google",
      "Chrome",
      "User Data",
    );
  }
  return path.join(homeDir, ".config", "google-chrome");
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

async function readProfileInfoCache(rootPath) {
  try {
    const raw = await readFile(path.join(rootPath, "Local State"), "utf8");
    const parsed = JSON.parse(raw);
    const cache = parsed?.profile?.info_cache;
    return cache && typeof cache === "object" ? cache : null;
  } catch {
    return null;
  }
}

function sortProfileDirNames(dirNames) {
  return [...dirNames].sort((a, b) => {
    if (a === "Default") return -1;
    if (b === "Default") return 1;
    return a.localeCompare(b, undefined, { numeric: true });
  });
}

/**
 * Enumerate local Chrome profiles in a strictly read-only fashion.
 *
 * Returns display metadata only: directory names, display names and whether
 * Chrome appears to be running. No cookie stores, no credential files and no
 * profile content is read, copied or transmitted by this module.
 */
export async function detectChromeProfiles(
  { rootPath = defaultChromeUserDataURL() } = { rootPath: undefined },
) {
  const result = {
    rootPath,
    available: false,
    chromeRunning: false,
    profiles: [],
    warnings: [],
  };

  if (!(await pathExists(rootPath))) {
    result.warnings.push("未找到 Chrome 用户数据目录");
    return result;
  }
  result.available = true;

  const lockChecks = await Promise.all(
    LOCK_MARKERS.map((marker) => pathExists(path.join(rootPath, marker))),
  );
  result.chromeRunning = lockChecks.some(Boolean);

  const infoCache = await readProfileInfoCache(rootPath);
  if (!infoCache) {
    result.warnings.push("无法读取 Local State，仅显示配置目录名");
  }

  const dirEntries = await readdir(rootPath, { withFileTypes: true });
  const profileDirNames = sortProfileDirNames(
    dirEntries
      .filter((entry) => entry.isDirectory() && PROFILE_DIR_PATTERN.test(entry.name))
      .map((entry) => entry.name),
  );

  for (const dirName of profileDirNames) {
    const info = infoCache?.[dirName] || {};
    result.profiles.push({
      dirName,
      displayName:
        typeof info.name === "string" && info.name ? info.name : dirName,
      userName: typeof info.user_name === "string" ? info.user_name : "",
      profileDir: path.join(rootPath, dirName),
      knownToLocalState: Boolean(infoCache?.[dirName]),
    });
  }

  return result;
}
