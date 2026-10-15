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
  setTitle: (title: string) => ipcRenderer.send("set-title", title),
  onMenu: (cb: (cmd: string) => void) => {
    ipcRenderer.on("menu", (_e, cmd: string) => cb(cmd));
  },
});
