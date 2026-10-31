import { contextBridge, ipcRenderer } from "electron";

type FileFilter = { name: string; extensions: string[] };

contextBridge.exposeInMainWorld("yddd", {
  saveFile: (req: { title: string; defaultPath: string; filters: FileFilter[]; data: string | Uint8Array }) =>
    ipcRenderer.invoke("save-file", req) as Promise<string | null>,
  writeFile: (filePath: string, data: string | Uint8Array) =>
    ipcRenderer.invoke("write-file", filePath, data) as Promise<string>,
  openFile: (req: { title: string; filters: FileFilter[]; binary: boolean }) =>
    ipcRenderer.invoke("open-file", req) as Promise<{ path: string; data: string | Uint8Array } | null>,
  readFile: (filePath: string) => ipcRenderer.invoke("read-file", filePath) as Promise<string | null>,
  listFonts: () => ipcRenderer.invoke("fonts-list") as Promise<{ family: string; style: string; file: string }[]>,
  readFont: (file: string) => ipcRenderer.invoke("font-read", file) as Promise<Uint8Array | null>,
  addRecent: (filePath: string) => ipcRenderer.invoke("recent-add", filePath) as Promise<void>,
  removeRecent: (filePath: string) => ipcRenderer.invoke("recent-remove", filePath) as Promise<void>,
  recentFiles: () => ipcRenderer.invoke("recent-list") as Promise<string[]>,
  confirm: (message: string) => ipcRenderer.invoke("confirm", message) as Promise<boolean>,
  ask: (req: { message: string; detail?: string; buttons: string[] }) => ipcRenderer.invoke("ask", req) as Promise<number>,
  writeRecovery: (rec: { savedAt: number; filePath: string | null; data: string }) => ipcRenderer.invoke("recovery-write", rec) as Promise<void>,
  readRecovery: () => ipcRenderer.invoke("recovery-read") as Promise<{ savedAt: number; filePath: string | null; data: string; file: string; more: number } | null>,
  adoptRecovery: (file: string) => ipcRenderer.invoke("recovery-adopt", file) as Promise<void>,
  clearRecovery: (file?: string) => ipcRenderer.invoke("recovery-clear", file) as Promise<void>,
  setTitle: (title: string) => ipcRenderer.send("set-title", title),
  setDirty: (dirty: boolean) => ipcRenderer.send("set-dirty", dirty),
  closeNow: () => ipcRenderer.send("close-now"),
  setMenuKeys: (keys: Record<string, string>) => ipcRenderer.send("menu-keys", keys),
  onMenu: (cb: (cmd: string) => void) => {
    ipcRenderer.on("menu", (_e, cmd: string) => cb(cmd));
  },
});
