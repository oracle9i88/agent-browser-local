export const PRODUCT_NAME = "Agent Browser Local";
export const VERSION = "0.3.0";

export const CAPABILITIES = Object.freeze({
  STATUS: "browser.status",
  NAVIGATE: "browser.navigate",
  SNAPSHOT: "browser.snapshot",
  SCREENSHOT: "browser.screenshot.current",
  CLICK: "browser.click.ref",
  CLICK_VISUAL: "browser.click.visual",
  FILL: "browser.fill.ref",
  UPLOAD: "browser.upload.ref",
  HANDOFF: "browser.handoff",
});

export const DEFAULT_CAPABILITIES = Object.freeze(Object.values(CAPABILITIES));

export const CONFIRMATION_POLICY = "handoff-only";
