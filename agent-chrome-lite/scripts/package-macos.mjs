import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(
  await readFile(path.join(projectDir, "package.json"), "utf8"),
);
const bundleVersion = packageJson.version.split("-")[0];
const productName = "Agent Browser Local";
const bundleId = "app.agentbrowser.local";
const bundleName = `${productName}.app`;
const sourceApp = path.join(
  projectDir,
  "node_modules",
  "electron",
  "dist",
  "Electron.app",
);
const outputDir = path.join(projectDir, "dist");
const outputApp = path.join(outputDir, bundleName);
const outputArchive = path.join(
  outputDir,
  `${productName}-${packageJson.version}-mac.zip`,
);
const outputManifest = path.join(outputDir, "release-manifest.json");
const contentsDir = path.join(outputApp, "Contents");
const resourcesDir = path.join(contentsDir, "Resources");
const runtimeAppDir = path.join(resourcesDir, "app");
const plistPath = path.join(contentsDir, "Info.plist");
const iconSource = path.join(projectDir, "assets", "app-icon.svg");

function run(command, args, { allowFailure = false } = {}) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `${command} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return result;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

await mkdir(outputDir, { recursive: true });
await rm(outputApp, { recursive: true, force: true });
run("/usr/bin/ditto", [sourceApp, outputApp]);

await rm(path.join(resourcesDir, "default_app.asar"), { force: true });
await mkdir(path.join(runtimeAppDir, "node_modules"), { recursive: true });
await cp(path.join(projectDir, "src"), path.join(runtimeAppDir, "src"), {
  recursive: true,
});
await cp(
  path.join(projectDir, "node_modules", "ws"),
  path.join(runtimeAppDir, "node_modules", "ws"),
  { recursive: true },
);

const runtimePackage = {
  name: packageJson.name,
  version: packageJson.version,
  private: true,
  type: "module",
  main: "src/main.mjs",
};
await writeFile(
  path.join(runtimeAppDir, "package.json"),
  `${JSON.stringify(runtimePackage, null, 2)}\n`,
);

const iconTempDir = await mkdtemp(path.join(os.tmpdir(), "agent-browser-icon-"));
try {
  run("/usr/bin/qlmanage", ["-t", "-s", "1024", "-o", iconTempDir, iconSource]);
  const sourcePng = path.join(iconTempDir, "app-icon.svg.png");
  const iconsetDir = path.join(iconTempDir, "AgentBrowser.iconset");
  await mkdir(iconsetDir, { recursive: true });
  const iconSizes = [
    [16, "icon_16x16.png"],
    [32, "icon_16x16@2x.png"],
    [32, "icon_32x32.png"],
    [64, "icon_32x32@2x.png"],
    [128, "icon_128x128.png"],
    [256, "icon_128x128@2x.png"],
    [256, "icon_256x256.png"],
    [512, "icon_256x256@2x.png"],
    [512, "icon_512x512.png"],
    [1024, "icon_512x512@2x.png"],
  ];
  for (const [size, fileName] of iconSizes) {
    run("/usr/bin/sips", [
      "-z",
      String(size),
      String(size),
      sourcePng,
      "--out",
      path.join(iconsetDir, fileName),
    ]);
  }
  run("/usr/bin/iconutil", [
    "-c",
    "icns",
    iconsetDir,
    "-o",
    path.join(resourcesDir, "AgentBrowser.icns"),
  ]);
  await rm(path.join(resourcesDir, "electron.icns"), { force: true });
} finally {
  await rm(iconTempDir, { recursive: true, force: true });
}

const oldExecutable = path.join(contentsDir, "MacOS", "Electron");
const newExecutable = path.join(contentsDir, "MacOS", productName);
await rename(oldExecutable, newExecutable);

const plistBuddy = "/usr/libexec/PlistBuddy";
const plistValues = [
  ["CFBundleDisplayName", productName],
  ["CFBundleExecutable", productName],
  ["CFBundleIdentifier", bundleId],
  ["CFBundleIconFile", "AgentBrowser.icns"],
  ["CFBundleName", productName],
  ["CFBundleShortVersionString", bundleVersion],
  ["CFBundleVersion", bundleVersion],
  ["LSApplicationCategoryType", "public.app-category.productivity"],
];
for (const [key, value] of plistValues) {
  run(plistBuddy, ["-c", `Set :${key} ${value}`, plistPath]);
}
run(plistBuddy, ["-c", "Delete :ElectronAsarIntegrity", plistPath], {
  allowFailure: true,
});
for (const key of [
  "NSAppTransportSecurity",
  "NSAudioCaptureUsageDescription",
  "NSBluetoothAlwaysUsageDescription",
  "NSBluetoothPeripheralUsageDescription",
  "NSCameraUsageDescription",
  "NSMicrophoneUsageDescription",
]) {
  run(plistBuddy, ["-c", `Delete :${key}`, plistPath], {
    allowFailure: true,
  });
}

run("/usr/bin/codesign", [
  "--force",
  "--deep",
  "--sign",
  "-",
  "--timestamp=none",
  outputApp,
]);
await rm(outputArchive, { force: true });
run("/usr/bin/ditto", [
  "-c",
  "-k",
  "--sequesterRsrc",
  "--keepParent",
  outputApp,
  outputArchive,
]);
const archiveInfo = await stat(outputArchive);
const archiveSha256 = await sha256(outputArchive);
await writeFile(
  outputManifest,
  `${JSON.stringify(
    {
      product: productName,
      version: packageJson.version,
      bundleId,
      archive: path.basename(outputArchive),
      archiveBytes: archiveInfo.size,
      archiveSha256,
      signing: "ad-hoc",
      notarized: false,
    },
    null,
    2,
  )}\n`,
);

console.log(
  JSON.stringify(
    {
      ok: true,
      app: outputApp,
      archive: outputArchive,
      manifest: outputManifest,
      archiveSha256,
      version: packageJson.version,
      signing: "ad-hoc",
      icon: "AgentBrowser.icns",
      declaredDevicePermissions: [],
      runtimeDependencies: ["ws"],
    },
    null,
    2,
  ),
);
