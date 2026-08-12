#!/usr/bin/env node

import { createConfig, defaultConfigPath } from "../src/config.mjs";

try {
  const { configPath, tokenPath, tokens } = await createConfig();
  console.log(`Created ${configPath}`);
  console.log(`Agent tokens saved with mode 0600: ${tokenPath}`);
  console.log(`Principals: ${Object.keys(tokens).join(", ")}`);
} catch (error) {
  if (error.code === "EEXIST") {
    console.error(`Config already exists: ${defaultConfigPath()}`);
    process.exit(2);
  }
  throw error;
}
