/** API exposed by src/main/preload.ts. */
type FileFilter = { name: string; extensions: string[] };

interface Y3DApi {
  saveFile(req: { title: string; defaultPath: string; filters: FileFilter[]; data: string | Uint8Array }): Promise<string | null>;
  writeFile(filePath: string, data: string | Uint8Array): Promise<string>;
  openFile(req: { title: string; filters: FileFilter[]; binary: boolean }): Promise<{ path: string; data: string | Uint8Array } | null>;
  confirm(message: string): Promise<boolean>;
  setTitle(title: string): void;
  onMenu(cb: (cmd: string) => void): void;
}

interface Window {
  y3d: Y3DApi;
}
