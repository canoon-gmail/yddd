/** API exposed by src/main/preload.ts. */
type FileFilter = { name: string; extensions: string[] };

interface Y3DApi {
  saveFile(req: { title: string; defaultPath: string; filters: FileFilter[]; data: string | Uint8Array }): Promise<string | null>;
  writeFile(filePath: string, data: string | Uint8Array): Promise<string>;
  openFile(req: { title: string; filters: FileFilter[]; binary: boolean }): Promise<{ path: string; data: string | Uint8Array } | null>;
  confirm(message: string): Promise<boolean>;
  /** Message box with the given buttons; the clicked button's index (the last one on Esc). */
  ask(req: { message: string; detail?: string; buttons: string[] }): Promise<number>;
  /** Crash recovery: autosaved unsaved work (see App.autosave). */
  writeRecovery(rec: { savedAt: number; filePath: string | null; data: string }): Promise<void>;
  readRecovery(): Promise<{ savedAt: number; filePath: string | null; data: string } | null>;
  clearRecovery(): Promise<void>;
  setTitle(title: string): void;
  setDirty(dirty: boolean): void;
  closeNow(): void;
  onMenu(cb: (cmd: string) => void): void;
}

interface Window {
  y3d: Y3DApi;
}
