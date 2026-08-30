const PAGE_HEALTHY = "healthy";

function cleanDetail(detail = {}) {
  return Object.fromEntries(
    Object.entries(detail).filter(([, value]) => value !== undefined),
  );
}

export class PageUnavailableError extends Error {
  constructor(fault) {
    super("The page renderer is unavailable; user recovery is required");
    this.code = "page_unavailable";
    this.detail = { fault };
  }
}

export class PageHealthState {
  constructor({ now = () => new Date().toISOString() } = {}) {
    this.now = now;
    this.state = PAGE_HEALTHY;
    this.fault = null;
  }

  fail(code, detail = {}) {
    this.state = "faulted";
    this.fault = Object.freeze({
      code,
      ...cleanDetail(detail),
      at: this.now(),
    });
    return this.snapshot();
  }

  recover() {
    const changed = this.state !== PAGE_HEALTHY;
    this.state = PAGE_HEALTHY;
    this.fault = null;
    return changed;
  }

  assertAvailable() {
    if (this.state !== PAGE_HEALTHY) {
      throw new PageUnavailableError(this.fault);
    }
  }

  snapshot() {
    return {
      state: this.state,
      fault: this.fault,
    };
  }
}

export function isMainFrameLoadFailure({ errorCode, isMainFrame }) {
  return Boolean(isMainFrame) && Number(errorCode) !== -3;
}
