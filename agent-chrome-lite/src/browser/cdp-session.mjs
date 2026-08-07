export class CdpSession {
  constructor(webContents) {
    this.webContents = webContents;
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

  async send(method, params = {}) {
    if (!this.webContents.debugger.isAttached()) await this.attach();
    return this.webContents.debugger.sendCommand(method, params);
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
    if (!this.webContents.isDestroyed() && this.webContents.debugger.isAttached()) {
      this.webContents.debugger.detach();
    }
  }
}
