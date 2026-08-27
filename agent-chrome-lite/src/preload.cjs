const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("agentBrowser", {
  status: () => ipcRenderer.invoke("browser:status"),
  navigate: (url) => ipcRenderer.invoke("browser:navigate", url),
  back: () => ipcRenderer.invoke("browser:back"),
  forward: () => ipcRenderer.invoke("browser:forward"),
  reload: () => ipcRenderer.invoke("browser:reload"),
  recover: () => ipcRenderer.invoke("browser:recover"),
  openExternalAuth: () => ipcRenderer.invoke("browser:open-external-auth"),
  syncExternalAuth: () => ipcRenderer.invoke("browser:sync-external-auth"),
  clearHandoff: () => ipcRenderer.invoke("browser:clear-handoff"),
  migrationDetect: () => ipcRenderer.invoke("migration:detect"),
  migrationOffers: () => ipcRenderer.invoke("migration:offers"),
  migrationRun: (domains) => ipcRenderer.invoke("migration:run", domains),
  migrationRollback: (migrationId) =>
    ipcRenderer.invoke("migration:rollback", migrationId),
  onState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("browser:state", listener);
    return () => ipcRenderer.removeListener("browser:state", listener);
  },
});
