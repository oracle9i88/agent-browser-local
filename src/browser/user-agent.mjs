export function buildChromiumUserAgent({
  platform = process.platform,
  chromeVersion = process.versions.chrome,
} = {}) {
  if (!/^\d+(?:\.\d+){3}$/.test(String(chromeVersion || ""))) {
    throw new Error("A full Chromium version is required for the browser user agent");
  }
  const platformToken =
    platform === "darwin"
      ? "Macintosh; Intel Mac OS X 10_15_7"
      : platform === "win32"
        ? "Windows NT 10.0; Win64; x64"
        : "X11; Linux x86_64";
  return `Mozilla/5.0 (${platformToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

export function assertNoElectronBrand(userAgent) {
  if (/Electron\//i.test(String(userAgent || ""))) {
    throw new Error("Browser user agent must not expose the Electron runtime brand");
  }
  return userAgent;
}
