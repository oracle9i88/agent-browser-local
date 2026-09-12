export const PRODUCT_NAME = "Agent Browser Local";
export const VERSION = "0.3.0-beta.19";

export const CAPABILITIES = Object.freeze({
  STATUS: "browser.status",
  NAVIGATE: "browser.navigate",
  SNAPSHOT: "browser.snapshot",
  SCREENSHOT: "browser.screenshot.current",
  SCROLL: "browser.scroll",
  CAPTURE_SERIES: "browser.capture.series",
  DOWNLOAD_STATUS: "browser.download.status",
  MINIMAX_DOWNLOAD: "browser.download.minimax",
  CLICK: "browser.click.ref",
  CLICK_VISUAL: "browser.click.visual",
  FILL: "browser.fill.ref",
  UPLOAD: "browser.upload.ref",
  FINALIZE: "browser.finalize.ref",
  CREDITS_SUNO: "browser.credits.suno",
  HANDOFF: "browser.handoff",
});

// Finalize and Suno credits are deliberately opt-in per locally configured
// principal. They are not part of the capabilities created for a fresh
// installation.
export const DEFAULT_CAPABILITIES = Object.freeze(
  Object.values(CAPABILITIES).filter(
    (capability) =>
      ![
        CAPABILITIES.FINALIZE,
        CAPABILITIES.CREDITS_SUNO,
        CAPABILITIES.CAPTURE_SERIES,
        CAPABILITIES.DOWNLOAD_STATUS,
        CAPABILITIES.MINIMAX_DOWNLOAD,
      ].includes(capability),
  ),
);

export const CONFIRMATION_POLICY = "handoff-only";
