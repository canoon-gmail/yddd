import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, type MenuItemConstructorOptions } from "electron";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const RENDERER_DIR = path.join(__dirname, "..", "renderer");
// Test runs keep their own settings / storage: they can run next to the user's open YDDD and leave its settings alone.
if (process.env.YDDD_TEST) app.setPath("userData", path.join(process.env.YDDD_TEST, "user-data"));
const DEV_URL = process.env.VITE_DEV_SERVER_URL;
// No usable GPU (a VM, missing drivers): let WebGL fall back to Chromium's software renderer (SwiftShader)
// instead of failing. A working GPU is still used. "Unsafe" is about untrusted web pages; YDDD only loads its own code.
app.commandLine.appendSwitch("enable-unsafe-swiftshader");

// A privileged custom scheme lets the renderer fetch() the OpenCascade .wasm
// (file:// does not support fetch / streaming wasm compilation).
protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

function registerAppProtocol(): void {
  protocol.handle("app", async (req) => {
    const { pathname } = new URL(req.url);
    const rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    const file = path.normalize(path.join(RENDERER_DIR, rel));
    if (!file.startsWith(RENDERER_DIR)) return new Response("Forbidden", { status: 403 });
    try {
      const data = await readFile(file);
      const type = MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      return new Response(data, { headers: { "content-type": type } });
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
}

let win: BrowserWindow | null = null;

function send(cmd: string): void {
  win?.webContents.send("menu", cmd);
}

// ---------------------------------------------------------------- File → Open Recent

const RECENT_MAX = 10;
/** Recently opened / saved models, newest first (a test run uses its own list, so it never touches the user's). */
let recent: string[] = [];

function recentFile(): string {
  return process.env.YDDD_TEST ? path.join(process.env.YDDD_TEST, "recent.json") : path.join(app.getPath("userData"), "recent.json");
}

function loadRecent(): void {
  try {
    const list = JSON.parse(readFileSync(recentFile(), "utf8")) as unknown;
    recent = Array.isArray(list) ? list.filter((p): p is string => typeof p === "string").slice(0, RECENT_MAX) : [];
  } catch {
    recent = [];
  }
}

function setRecent(list: string[]): void {
  recent = list.slice(0, RECENT_MAX);
  void writeFile(recentFile(), JSON.stringify(recent)).catch(() => {});
  buildMenu();
}

type FontFile = { family: string; style: string; file: string };

/** The system's fonts from fontconfig (Linux). */
function fcFonts(): Promise<FontFile[]> {
  return new Promise((resolve) => {
    execFile("fc-list", ["--format", "%{family[0]}\t%{style[0]}\t%{file}\n"], { maxBuffer: 16 << 20 }, (err, out) => {
      if (err) return resolve([]);
      resolve(out.split("\n").map((l) => l.split("\t")).filter((f) => f.length === 3).map(([family, style, file]) => ({ family, style, file })));
    });
  });
}

/**
 * The system's fonts on Windows: the Fonts registry keys (all users, then this user's own), whose entries read
 * "Arial Bold Italic (TrueType)    REG_SZ    arialbi.ttf" — the style words split off the end of the name.
 */
async function windowsFonts(): Promise<FontFile[]> {
  const dir = path.join(process.env.WINDIR ?? "C:\\Windows", "Fonts");
  const query = (key: string) => new Promise<string>((resolve) => execFile("reg", ["query", key], { maxBuffer: 16 << 20 }, (err, out) => resolve(err ? "" : out)));
  const KEY = "\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts";
  const out = (await query("HKLM" + KEY)) + (await query("HKCU" + KEY));
  const STYLE = /^(Regular|Bold|Italic|Oblique|Light|Semilight|SemiLight|Semibold|SemiBold|Demibold|ExtraBold|Black|Heavy|Thin|ExtraLight|Medium|Condensed|Narrow)$/;
  const fonts: FontFile[] = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s+(.+?)\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/.exec(line);
    if (!m || m[1].includes("&")) continue; // (a collection: "Cambria & Cambria Math")
    const words = m[1].replace(/\s*\((TrueType|OpenType)\)$/i, "").split(/\s+/);
    let cut = words.length;
    while (cut > 1 && STYLE.test(words[cut - 1])) cut--;
    const file = path.isAbsolute(m[2]) ? m[2] : path.join(dir, m[2]);
    fonts.push({ family: words.slice(0, cut).join(" "), style: words.slice(cut).join(" ") || "Regular", file });
  }
  return fonts;
}

/** "name.yddd   ~/folder" for the menu ("&" doubled: it marks a mnemonic). */
function recentLabel(file: string): string {
  const home = os.homedir();
  const dir = path.dirname(file);
  const shown = dir === home ? "~" : dir.startsWith(home + path.sep) ? "~" + dir.slice(home.length) : dir;
  return `${path.basename(file)}   ${shown}`.replace(/&/g, "&&");
}

/** The renderer's shortcuts for the menu to show (command → accelerator, "" = none; see keymap.ts). */
let menuKeys: Record<string, string> = {};

function buildMenu(): void {
  // The renderer handles the keys (they can be changed with "/"): the menu only shows them.
  const item = (label: string, cmd: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator: (cmd in menuKeys ? menuKeys[cmd] : accelerator) || undefined,
    registerAccelerator: false,
    click: () => send(cmd),
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: "&File",
      submenu: [
        item("New", "file.new", "CmdOrCtrl+N"),
        item("Open…", "file.open", "CmdOrCtrl+O"),
        item("Open Picture…", "file.openPicture"),
        {
          label: "Open Recent",
          submenu: recent.length
            ? [
                ...recent.map((file, i): MenuItemConstructorOptions => ({
                  label: recentLabel(file),
                  accelerator: i < 9 ? `CmdOrCtrl+Shift+${i + 1}` : undefined,
                  click: () => send(`file.openRecent:${file}`),
                })),
                { type: "separator" },
                { label: "Clear Recent", click: () => setRecent([]) },
              ]
            : [{ label: "No recent files", enabled: false }],
        },
        item("Save", "file.save", "CmdOrCtrl+S"),
        item("Save As…", "file.saveAs", "CmdOrCtrl+Shift+S"),
        { type: "separator" },
        item("Import STEP…", "file.importStep"),
        item("Import STL…", "file.importStl"),
        item("Export STEP…", "file.exportStep"),
        item("Export STL…", "file.exportStl", "CmdOrCtrl+Shift+E"),
        item("Export 3MF… (Bambu Studio, PrusaSlicer, Cura)", "file.export3mf"),
        item("Save View as Image…", "file.exportImage", "CmdOrCtrl+P"),
        { type: "separator" },
        item("Settings…", "file.settings"),
        { type: "separator" },
        { role: "quit" },
      ],
    },
    {
      label: "&Edit",
      submenu: [
        item("Undo", "edit.undo", "CmdOrCtrl+Z"),
        item("Redo", "edit.redo", "CmdOrCtrl+R"),
        { type: "separator" },
        item("Duplicate", "edit.duplicate", "CmdOrCtrl+D"),
        item("Repeat Last", "xf.repeat", "Shift+R"),
        item("Delete", "edit.delete", "Delete"),
        item("Select All", "edit.selectAll", "CmdOrCtrl+A"),
        { type: "separator" },
        item("Group", "edit.group", "CmdOrCtrl+G"),
        item("Ungroup", "edit.ungroup", "CmdOrCtrl+Shift+G"),
        item("Hide", "edit.hide", "CmdOrCtrl+H"),
        { type: "separator" },
        item("Clear All Guides", "edit.clearGuides"),
      ],
    },
    {
      label: "&View",
      submenu: [
        item("Fit All", "view.fit", "Home"),
        item("Top", "view.top"),
        item("Front", "view.front"),
        item("Right", "view.right"),
        item("Isometric", "view.iso"),
        { type: "separator" },
        item("Clear Recent Tools", "view.clearRecent"),
        { type: "separator" },
        { label: "Reload", click: (_m, w) => (w as BrowserWindow | undefined)?.webContents.reload() }, // no shortcut: Ctrl+R is Redo
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "&Macro",
      submenu: [
        item("Box from Face…", "macro.box"),
        { label: "Box Lid", submenu: [item("Inside Lip…", "macro.lidIn"), item("Over the Box…", "macro.lidOver")] },
        item("Dividers…", "macro.dividers"),
        { type: "separator" },
        item("Battery Case…", "macro.battery"),
        item("Gridfinity Bin…", "macro.gridfinity"),
        item("Gridfinity Baseplate…", "macro.baseplate"),
        item("Gear…", "macro.gear"),
        { type: "separator" },
        item("Random…", "macro.random"),
      ],
    },
    {
      label: "&Help",
      submenu: [item("Shortcuts: Search & Change…", "help.keys", "/"), item("Keyboard Shortcuts", "help.shortcuts", "F1"), item("Bird House", "help.birdhouse"), item("Cable Storage Box", "help.cablebox"), item("House", "help.house"), item("Planter", "help.planter"), item("Propeller", "help.propeller")],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

interface SaveRequest {
  title: string;
  defaultPath: string;
  filters: Electron.FileFilter[];
  data: string | Uint8Array;
}
interface OpenRequest {
  title: string;
  filters: Electron.FileFilter[];
  binary: boolean;
}

function registerIpc(): void {
  ipcMain.on("menu-keys", (_e, keys: Record<string, string>) => {
    menuKeys = keys;
    buildMenu();
  });

  ipcMain.handle("save-file", async (_e, req: SaveRequest) => {
    if (!win) return null;
    const res = await dialog.showSaveDialog(win, {
      title: req.title,
      defaultPath: req.defaultPath,
      filters: req.filters,
    });
    if (res.canceled || !res.filePath) return null;
    await writeFile(res.filePath, req.data);
    return res.filePath;
  });

  ipcMain.handle("write-file", async (_e, filePath: string, data: string | Uint8Array) => {
    await writeFile(filePath, data);
    return filePath;
  });

  ipcMain.handle("open-file", async (_e, req: OpenRequest) => {
    if (!win) return null;
    const res = await dialog.showOpenDialog(win, {
      title: req.title,
      filters: req.filters,
      properties: ["openFile"],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    const filePath = res.filePaths[0];
    const buf = await readFile(filePath);
    return { path: filePath, data: req.binary ? new Uint8Array(buf) : buf.toString("utf8") };
  });

  ipcMain.handle("read-file", async (_e, filePath: string) => {
    try {
      return await readFile(filePath, "utf8");
    } catch {
      return null;
    }
  });

  // Text tool fonts: the system's TrueType / OpenType files (fontconfig), and reading one of them.
  let fontFiles = new Set<string>();
  ipcMain.handle("fonts-list", async () => {
    const fonts = (process.platform === "win32" ? await windowsFonts() : await fcFonts()).filter((f) => /\.(ttf|otf)$/i.test(f.file));
    fontFiles = new Set(fonts.map((f) => f.file));
    return fonts;
  });
  ipcMain.handle("font-read", async (_e, file: string) => {
    if (!fontFiles.has(file)) return null; // (only the listed fonts)
    try {
      return new Uint8Array(await readFile(file));
    } catch {
      return null;
    }
  });

  ipcMain.handle("recent-add", (_e, filePath: string) => setRecent([filePath, ...recent.filter((p) => p !== filePath)]));
  ipcMain.handle("recent-remove", (_e, filePath: string) => setRecent(recent.filter((p) => p !== filePath)));
  ipcMain.handle("recent-list", () => recent);

  ipcMain.handle("confirm", async (_e, message: string) => {
    if (!win) return false;
    const res = await dialog.showMessageBox(win, {
      type: "question",
      buttons: ["Discard changes", "Cancel"],
      defaultId: 1,
      cancelId: 1,
      message,
    });
    return res.response === 0;
  });

  ipcMain.handle("ask", async (_e, req: { message: string; detail?: string; buttons: string[] }) => {
    if (!win) return -1;
    if (process.env.YDDD_TEST) return 0; // unattended: take the first (default) answer
    const res = await dialog.showMessageBox(win, { type: "question", message: req.message, detail: req.detail, buttons: req.buttons, defaultId: 0, cancelId: req.buttons.length - 1 });
    return res.response;
  });

  // Crash recovery: the renderer autosaves unsaved work here; it's offered on the next start.
  ipcMain.handle("recovery-write", async (_e, rec: { savedAt: number; filePath: string | null; data: string }) => {
    const file = recoveryFile();
    await writeFile(file + ".tmp", JSON.stringify(rec)); // never leave a half-written file
    await rename(file + ".tmp", file);
  });
  ipcMain.handle("recovery-read", async () => {
    try {
      return JSON.parse(await readFile(recoveryFile(), "utf8")) as { savedAt: number; filePath: string | null; data: string };
    } catch {
      return null;
    }
  });
  ipcMain.handle("recovery-clear", () => clearRecovery());

  ipcMain.on("set-title", (_e, title: string) => win?.setTitle(title));

  // Renderer reports whether the model has unsaved changes.
  ipcMain.on("set-dirty", (_e, value: boolean) => (dirty = value));
  // Renderer finished "Save, then close" (or wants to close unconditionally).
  ipcMain.on("close-now", () => {
    forceClose = true;
    win?.close();
  });
}

let dirty = false;
let forceClose = false;
/** The window's renderer died (crash / killed): its recovery file must survive. */
let crashed = false;

/** Where unsaved work is autosaved (a test run uses its own, so it never touches the user's). */
function recoveryFile(): string {
  return process.env.YDDD_TEST ? path.join(process.env.YDDD_TEST, "recovery.yddd") : path.join(app.getPath("userData"), "recovery.yddd");
}

async function clearRecovery(): Promise<void> {
  await unlink(recoveryFile()).catch(() => {});
}

/** Ask before closing a window with unsaved changes. */
async function onWindowClose(e: Electron.Event): Promise<void> {
  if (forceClose || !dirty || !win) return;
  e.preventDefault();
  const res = await dialog.showMessageBox(win, {
    type: "warning",
    buttons: ["Save", "Don't Save", "Cancel"],
    defaultId: 0,
    cancelId: 2,
    message: "Do you want to save changes before closing?",
    detail: "Your changes will be lost if you don't save them.",
  });
  if (res.response === 0) send("file.saveAndClose");
  else if (res.response === 1) {
    forceClose = true;
    win?.close();
  }
}

async function createWindow(): Promise<void> {
  forceClose = false;
  dirty = false;
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#1e1f22",
    title: "YDDD",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.on("close", (e) => void onWindowClose(e));
  win.on("closed", () => {
    win = null;
    // Closed on purpose (saved, or "Don't Save"): nothing to recover next time.
    if (!crashed) void clearRecovery();
  });
  // The drawing window died (e.g. the geometry kernel crashed): say so and restart it — the
  // restarted window offers the last autosave.
  win.webContents.on("render-process-gone", (_e, details) => {
    if (details.reason === "clean-exit" || !win) return;
    crashed = true;
    // Reload after the "gone" event, not inside it: while the dead renderer is still being torn
    // down a reload can be dropped, leaving a dark window. If the page still isn't back, load it again.
    const restart = () => {
      crashed = false;
      dirty = false;
      setTimeout(() => {
        if (!win) return;
        let back = false;
        win.webContents.once("did-finish-load", () => (back = true));
        win.reload();
        setTimeout(() => {
          if (win && !back && !win.webContents.isLoading()) void (DEV_URL ? win.loadURL(DEV_URL) : win.loadURL("app://y3d/index.html"));
        }, 3000);
      }, 100);
    };
    if (process.env.YDDD_TEST) return restart(); // unattended
    void dialog
      .showMessageBox(win, {
        type: "error",
        message: "YDDD stopped working and will restart.",
        detail: `Reason: ${details.reason}. Your unsaved work up to the last autosave (a few seconds before) will be offered when it restarts.`,
        buttons: ["Restart"],
      })
      .then(restart);
  });
  // YDDD_STRESS=N: renderer populates the scene with N test solids on startup.
  const q = process.env.YDDD_STRESS ? `?stress=${encodeURIComponent(process.env.YDDD_STRESS)}` : "";
  if (DEV_URL) await win.loadURL(DEV_URL + q);
  // The page stays at app://y3d (the app's old name): its origin keys the saved settings (localStorage).
  else await win.loadURL("app://y3d/index.html" + q);
  if (process.env.YDDD_TEST) {
    // (local only, not in the repo: a variable path so the build doesn't need the file)
    const tests = "./test.js";
    const { runTests } = await import(tests);
    await runTests(win, process.env.YDDD_TEST);
  } else if (process.env.YDDD_BENCH) {
    const { runBench } = await import("./bench.js");
    await runBench(win);
  }
}

app.whenReady().then(async () => {
  // A test run starts clean (a leftover recovery file would stop it with the Recover question).
  if (process.env.YDDD_TEST) await clearRecovery();
  registerAppProtocol();
  registerIpc();
  loadRecent();
  buildMenu();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
