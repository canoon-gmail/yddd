/** API exposed by src/main/preload.ts. */
type FileFilter = { name: string; extensions: string[] };

interface YDDDApi {
  saveFile(req: { title: string; defaultPath: string; filters: FileFilter[]; data: string | Uint8Array }): Promise<string | null>;
  writeFile(filePath: string, data: string | Uint8Array): Promise<string>;
  openFile(req: { title: string; filters: FileFilter[]; binary: boolean }): Promise<{ path: string; data: string | Uint8Array } | null>;
  /** A text file's contents; null if it can't be read (moved, deleted...). */
  readFile(filePath: string): Promise<string | null>;
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
  readRecovery(): Promise<{ savedAt: number; filePath: string | null; data: string } | null>;
  clearRecovery(): Promise<void>;
  setTitle(title: string): void;
  setDirty(dirty: boolean): void;
  /** The menu's shortcuts as shown (command → Electron accelerator, "" = none); the renderer handles the keys. */
  setMenuKeys?(keys: Record<string, string>): void;
  closeNow(): void;
  onMenu(cb: (cmd: string) => void): void;
}

interface Window {
  yddd: YDDDApi;
}
