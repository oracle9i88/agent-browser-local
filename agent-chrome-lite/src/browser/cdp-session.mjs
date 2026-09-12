export class CdpSession {
  constructor(
    webContents,
    { commandTimeoutMs = 15_000, onFault = () => undefined } = {},
  ) {
    this.webContents = webContents;
    this.commandTimeoutMs = commandTimeoutMs;
    this.onFault = onFault;
    this.childTargets = new Map();
    this.trackingTargets = false;
    this.onTargetMessage = (_event, method, params) => {
      if (method === "Target.attachedToTarget" && params?.sessionId) {
        this.childTargets.set(params.sessionId, params.targetInfo);
      } else if (method === "Target.targetInfoChanged" && params?.targetInfo) {
        for (const [sessionId, info] of this.childTargets) {
          if (info?.targetId === params.targetInfo.targetId) {
            this.childTargets.set(sessionId, params.targetInfo);
          }
        }
      } else if (method === "Target.detachedFromTarget") {
        this.childTargets.delete(params?.sessionId);
      }
    };
  }

  async attach() {
    if (this.webContents.isDestroyed()) {
      throw new Error("Browser content is not available");
    }
    if (!this.webContents.debugger.isAttached()) {
      this.webContents.debugger.attach("1.3");
    }
    await Promise.all([
      this.send("DOM.enable"),
      this.send("Page.enable"),
      this.send("Accessibility.enable"),
    ]);
  }

  async attachedFrames() {
    if (!this.trackingTargets) {
      this.webContents.debugger.on("message", this.onTargetMessage);
      this.trackingTargets = true;
    }
    await this.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    if (this.childTargets.size === 0) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return [...this.childTargets]
      .filter(([, info]) => info?.type === "iframe")
      .map(([sessionId, info]) => ({ sessionId, url: info.url }));
  }

  async send(method, params = {}, { timeoutMs = this.commandTimeoutMs, sessionId } = {}) {
    if (!this.webContents.debugger.isAttached()) await this.attach();
    let timer;
    try {
      return await Promise.race([
        this.webContents.debugger.sendCommand(method, params, sessionId),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const error = new Error(`Timed out running CDP command ${method}`);
            error.code = "cdp_command_timeout";
            error.detail = { method, timeoutMs };
            this.onFault(error);
            reject(error);
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  waitFor(method, timeoutMs = 8000) {
    return new Promise((resolve, reject) => {
      const onMessage = (_event, incomingMethod, params) => {
        if (incomingMethod !== method) return;
        cleanup();
        resolve(params || {});
      };
      const timer = setTimeout(() => {
        cleanup();
        const error = new Error(`Timed out waiting for CDP event ${method}`);
        error.code = "cdp_event_timeout";
        reject(error);
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.webContents.debugger.removeListener("message", onMessage);
      };
      this.webContents.debugger.on("message", onMessage);
    });
  }

  detach() {
    if (this.trackingTargets) {
      this.webContents.debugger.removeListener("message", this.onTargetMessage);
    }
    this.childTargets.clear();
    this.trackingTargets = false;
    if (!this.webContents.isDestroyed() && this.webContents.debugger.isAttached()) {
      this.webContents.debugger.detach();
    }
  }
}
