export const PRODUCT_NAME = "Agent Browser Local";
export const VERSION = "0.3.0-beta.9";

export const CAPABILITIES = Object.freeze({
  STATUS: "browser.status",
  NAVIGATE: "browser.navigate",
  SNAPSHOT: "browser.snapshot",
  SCREENSHOT: "browser.screenshot.current",
  CLICK: "browser.click.ref",
  CLICK_VISUAL: "browser.click.visual",
  FILL: "browser.fill.ref",
  UPLOAD: "browser.upload.ref",
  FINALIZE: "browser.finalize.ref",
  HANDOFF: "browser.handoff",
});

// Finalize is deliberately opt-in per locally configured principal. It is not
// part of the capabilities created for a fresh installation.
export const DEFAULT_CAPABILITIES = Object.freeze(
  Object.values(CAPABILITIES).filter(
    (capability) => capability !== CAPABILITIES.FINALIZE,
  ),
);

export const CONFIRMATION_POLICY = "handoff-only";
