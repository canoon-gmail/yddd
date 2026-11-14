/** API exposed by src/main/preload.ts. */
type FileFilter = { name: string; extensions: string[] };

interface YDDDApi {
  saveFile(req: { title: string; defaultPath: string; filters: FileFilter[]; data: string | Uint8Array }): Promise<string | null>;
  writeFile(filePath: string, data: string | Uint8Array): Promise<string>;
  openFile(req: { title: string; filters: FileFilter[]; binary: boolean }): Promise<{ path: string; data: string | Uint8Array } | null>;
  /** A text file's contents; null if it can't be read (moved, deleted...). */
  readFile(filePath: string): Promise<string | null>;
  /** Objects copied with Ctrl+C, for any YDDD window (a file of YDDD's own, not the system clipboard). */
  clipWrite(data: string): Promise<void>;
  clipRead(): Promise<string | null>;
  /** The system's TrueType / OpenType fonts (for Text), and one's file contents (null: not listed / unreadable). */
  listFonts(): Promise<{ family: string; style: string; file: string }[]>;
  readFont(file: string): Promise<Uint8Array | null>;
  /** File → Open Recent: put a model first in the list / take it out / the list (newest first). */
  addRecent(filePath: string): Promise<void>;
  removeRecent(filePath: string): Promise<void>;
  recentFiles(): Promise<string[]>;
  confirm(message: string): Promise<boolean>;
  /** Message box with the given buttons; the clicked button's index (the last one on Esc). */
  ask(req: { message: string; detail?: string; buttons: string[] }): Promise<number>;
  /** Crash recovery: autosaved unsaved work (see App.autosave). */
  writeRecovery(rec: { savedAt: number; filePath: string | null; data: string }): Promise<void>;
  /** The newest unsaved work left by a copy of YDDD that isn't running any more (`file`: its recovery file; `more`: others left). */
  readRecovery(): Promise<{ savedAt: number; filePath: string | null; data: string; file: string; more: number } | null>;
  /** Recovered: that file becomes this copy's own recovery file. */
  adoptRecovery(file: string): Promise<void>;
  /** This copy's recovery file deleted — or `file`, a leftover discarded. */
  clearRecovery(file?: string): Promise<void>;
  setTitle(title: string): void;
  setDirty(dirty: boolean): void;
  /** The menu's shortcuts as shown (command → Electron accelerator, "" = none); the renderer handles the keys. */
  setMenuKeys?(keys: Record<string, string>): void;
  closeNow(): void;
  /** A (fresh) background kernel process: its channel comes as a "yddd-kernel-port" window message. */
  kernelStart(): void;
  /** The background kernel process died on its own. */
  onKernelGone(cb: (reason: string) => void): void;
  onMenu(cb: (cmd: string) => void): void;
  /** Open Recent → Clear Recent (YDDD's own menu bar). */
  clearRecent(): Promise<void>;
  /** The menu bar's system items: quit, reload, devtools, fullscreen, clear-recoveries. */
  appAction(act: string): void;
}

interface Window {
  yddd: YDDDApi;
}
