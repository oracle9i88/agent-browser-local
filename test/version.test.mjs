import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { VERSION } from "../src/constants.mjs";

test("runtime and package public preview versions stay aligned", async () => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(packageJson.version, "0.3.0-beta.1");
  assert.equal(VERSION, packageJson.version);
});
