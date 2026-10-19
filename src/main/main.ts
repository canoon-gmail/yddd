import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, type MenuItemConstructorOptions } from "electron";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import * as path from "node:path";

const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const DEV_URL = process.env.VITE_DEV_SERVER_URL;

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

function buildMenu(): void {
  const item = (label: string, cmd: string, accelerator?: string): MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: () => send(cmd),
  });
  const template: MenuItemConstructorOptions[] = [
    {
      label: "&File",
      submenu: [
        item("New", "file.new", "CmdOrCtrl+N"),
        item("Open…", "file.open", "CmdOrCtrl+O"),
        item("Save", "file.save", "CmdOrCtrl+S"),
        item("Save As…", "file.saveAs", "CmdOrCtrl+Shift+S"),
        { type: "separator" },
        item("Import STEP…", "file.importStep", "CmdOrCtrl+I"),
        item("Import STL…", "file.importStl"),
        item("Export STEP…", "file.exportStep", "CmdOrCtrl+E"),
        item("Export STL…", "file.exportStl", "CmdOrCtrl+Shift+E"),
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
        item("Select All", "edit.selectAll", "CmdOrCtrl+A"),
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
        item("Pro Layout (less text) on / off", "view.pro", "CmdOrCtrl+Shift+F1"),
        { type: "separator" },
        { label: "Reload", click: (_m, w) => (w as BrowserWindow | undefined)?.webContents.reload() }, // no shortcut: Ctrl+R is Redo
        { role: "toggleDevTools" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "&Help",
      submenu: [item("Keyboard Shortcuts", "help.shortcuts", "F1"), item("Bird House", "help.birdhouse"), item("Cable Storage Box", "help.cablebox")],
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
    if (process.env.Y3D_SMOKE) return 0; // unattended: take the first (default) answer
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

/** Where unsaved work is autosaved (a smoke run uses its own, so it never touches the user's). */
function recoveryFile(): string {
  return process.env.Y3D_SMOKE ? path.join(process.env.Y3D_SMOKE, "recovery.y3d") : path.join(app.getPath("userData"), "recovery.y3d");
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
    title: "Y3D",
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
    if (process.env.Y3D_SMOKE) return restart(); // unattended
    void dialog
      .showMessageBox(win, {
        type: "error",
        message: "Y3D stopped working and will restart.",
        detail: `Reason: ${details.reason}. Your unsaved work up to the last autosave (a few seconds before) will be offered when it restarts.`,
        buttons: ["Restart"],
      })
      .then(restart);
  });
  // Y3D_STRESS=N: renderer populates the scene with N test solids on startup.
  const q = process.env.Y3D_STRESS ? `?stress=${encodeURIComponent(process.env.Y3D_STRESS)}` : "";
  if (DEV_URL) await win.loadURL(DEV_URL + q);
  else await win.loadURL("app://y3d/index.html" + q);
  if (process.env.Y3D_SMOKE) {
    const { runSmoke } = await import("./smoke.js");
    await runSmoke(win, process.env.Y3D_SMOKE);
  } else if (process.env.Y3D_BENCH) {
    const { runBench } = await import("./bench.js");
    await runBench(win);
  }
}

app.whenReady().then(async () => {
  // A smoke run starts clean (a leftover recovery file would stop it with the Recover question).
  if (process.env.Y3D_SMOKE) await clearRecovery();
  registerAppProtocol();
  registerIpc();
  buildMenu();
  await createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
