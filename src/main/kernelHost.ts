/**
 * The background kernel's own process: a hidden window (kernel-host.html) that runs the background kernel
 * (kernel.worker.ts) for one app window. Its own process, so OpenCascade locking up there (a Shell on a loft's sides
 * once froze the whole app with it) can't freeze the app window: that window asks for a fresh one instead (Stop, Esc,
 * its watchdog), and this ends the old one whatever state it's in. The two talk over a MessageChannel of their own —
 * the jobs' shapes and files don't pass through here.
 */
import { BrowserWindow, ipcMain, MessageChannelMain, type WebContents } from "electron";
import * as path from "node:path";

/** The hidden kernel window of each app window (by its webContents id). */
const hosts = new Map<number, BrowserWindow>();
/** App windows whose closing ends their kernel process (hooked once each). */
const hooked = new Set<number>();

/** End the app window's kernel process, if it has one. */
function endHost(ownerId: number): void {
  const host = hosts.get(ownerId);
  hosts.delete(ownerId);
  if (host && !host.isDestroyed()) host.destroy();
}

/** A fresh kernel process for `owner` (the old one ended): its end of the channel is sent when the page has loaded. */
function startHost(owner: WebContents, url: string, threads: string | undefined): void {
  endHost(owner.id);
  const host = new BrowserWindow({
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // (hidden: its timers and messages mustn't be slowed down)
      backgroundThrottling: false,
    },
  });
  hosts.set(owner.id, host);
  const ownerId = owner.id;
  host.webContents.once("did-finish-load", () => {
    if (hosts.get(ownerId) !== host || owner.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    host.webContents.postMessage("kernel-port", null, [port1]);
    owner.postMessage("kernel-port", null, [port2]);
  });
  // (gone for any other reason than being ended here: the app window starts another — see kernelWorker.ts)
  host.webContents.on("render-process-gone", (_e, details) => {
    if (hosts.get(ownerId) !== host || owner.isDestroyed()) return;
    hosts.delete(ownerId);
    owner.send("kernel-gone", details.reason);
    if (!host.isDestroyed()) host.destroy();
  });
  const q = threads ? `?threads=${encodeURIComponent(threads)}` : "";
  void host.loadURL(url + q);
  if (!hooked.has(ownerId)) {
    hooked.add(ownerId);
    owner.once("destroyed", () => {
      hooked.delete(ownerId);
      endHost(ownerId);
    });
  }
}

/** `kernel-start` from an app window: a (fresh) kernel process for it. `baseUrl`: where the app's pages are served. */
export function registerKernelHost(baseUrl: string): void {
  const base = baseUrl.endsWith("/") ? baseUrl : baseUrl + "/";
  ipcMain.on("kernel-start", (e) => startHost(e.sender, base + "kernel-host.html", process.env.YDDD_THREADS));
}
