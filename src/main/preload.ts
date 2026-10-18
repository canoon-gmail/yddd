import { contextBridge, ipcRenderer } from "electron";

type FileFilter = { name: string; extensions: string[] };

contextBridge.exposeInMainWorld("y3d", {
  saveFile: (req: { title: string; defaultPath: string; filters: FileFilter[]; data: string | Uint8Array }) =>
    ipcRenderer.invoke("save-file", req) as Promise<string | null>,
  writeFile: (filePath: string, data: string | Uint8Array) =>
    ipcRenderer.invoke("write-file", filePath, data) as Promise<string>,
  openFile: (req: { title: string; filters: FileFilter[]; binary: boolean }) =>
    ipcRenderer.invoke("open-file", req) as Promise<{ path: string; data: string | Uint8Array } | null>,
  confirm: (message: string) => ipcRenderer.invoke("confirm", message) as Promise<boolean>,
  ask: (req: { message: string; detail?: string; buttons: string[] }) => ipcRenderer.invoke("ask", req) as Promise<number>,
  writeRecovery: (rec: { savedAt: number; filePath: string | null; data: string }) => ipcRenderer.invoke("recovery-write", rec) as Promise<void>,
  readRecovery: () => ipcRenderer.invoke("recovery-read") as Promise<{ savedAt: number; filePath: string | null; data: string } | null>,
  clearRecovery: () => ipcRenderer.invoke("recovery-clear") as Promise<void>,
  setTitle: (title: string) => ipcRenderer.send("set-title", title),
  setDirty: (dirty: boolean) => ipcRenderer.send("set-dirty", dirty),
  closeNow: () => ipcRenderer.send("close-now"),
  onMenu: (cb: (cmd: string) => void) => {
    ipcRenderer.on("menu", (_e, cmd: string) => cb(cmd));
  },
});
