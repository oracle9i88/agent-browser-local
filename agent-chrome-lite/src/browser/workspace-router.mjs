import { EventEmitter } from "node:events";

// One daemon, multiple persistent controllers. Never retarget an in-flight
// request (including requests waiting in the human-paced executor).
export class WorkspaceRouter extends EventEmitter {
  constructor() {
    super();
    this.entries = new Map();
    this.activeId = null;
    this.busy = false;
    this.controller = new Proxy(this, {
      get: (target, key) => {
        if (key === "on") return target.on.bind(target);
        if (key === "status") return () => target.status();
        const controller = target.active()?.controller;
        const value = controller?.[key];
        return typeof value === "function" ? value.bind(controller) : value;
      },
    });
  }

  add(entry) {
    if (this.entries.has(entry.space.id)) throw new Error("Workspace already open");
    this.entries.set(entry.space.id, entry);
    if (!this.activeId) this.activeId = entry.space.id;
    for (const event of ["state", "handoff"]) {
      entry.controller.on(event, (payload) => {
        if (this.activeId === entry.space.id) this.emit(event,
          event === "handoff" ? { ...payload, spaceId: entry.space.id } : this.status());
      });
    }
    entry.controller.on("download", (record) => {
      this.emit("download", { ...record, spaceId: entry.space.id, sourceUrl: entry.controller.status().url });
    });
  }

  active() { return this.entries.get(this.activeId); }

  status() {
    return {
      ...this.active().controller.status(),
      spaceId: this.activeId,
      spaces: [...this.entries.values()].map(({ space }) => ({ id: space.id, label: space.label })),
    };
  }

  select(id) {
    if (this.busy) throw Object.assign(new Error("正在执行操作，请稍后切换工作空间"), { code: "workspace_busy", status: 409 });
    if (!this.entries.has(id)) throw new Error("Unknown workspace");
    this.activeId = id;
    this.active().controller.invalidate();
    return this.active();
  }

  async run(task, expectedSpaceId) {
    if (this.busy) throw Object.assign(new Error("浏览器正在执行其他操作，请稍后重试"), { code: "workspace_busy", status: 409 });
    if (expectedSpaceId && expectedSpaceId !== this.activeId) {
      throw Object.assign(new Error("工作空间已切换，请重新获取状态和 Snapshot"), { code: "workspace_changed", status: 409 });
    }
    this.busy = true;
    try { return await task(); }
    finally { this.busy = false; }
  }
}
