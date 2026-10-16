/**
 * Opt-in snapping benchmark. Run with:  N=2000 npm run bench
 * Loads the stress scene, times object-snap queries and draw-tool pointer
 * moves, prints a JSON report and quits. Not loaded during normal use.
 */
import type { BrowserWindow } from "electron";
import { app } from "electron";

const SCENARIO = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 600 && !(window.y3dApp && window.y3dApp.doc.bodies.length); i++) await sleep(100);
  const app = window.y3dApp;
  if (!app) throw new Error("app did not start");
  await sleep(500);
  const vp = app.viewport, canvas = vp.canvas;
  const r = canvas.getBoundingClientRect();
  const pts = [];
  for (let i = 0; i < 200; i++) pts.push([r.left + ((i * 37) % 100) / 100 * r.width, r.top + ((i * 61) % 100) / 100 * r.height]);
  const time = (fn) => { const t = performance.now(); fn(); return performance.now() - t; };
  const stats = (xs) => { xs = [...xs].sort((a, b) => a - b); const avg = xs.reduce((a, b) => a + b, 0) / xs.length; return { avg: +avg.toFixed(2), p95: +xs[Math.floor(xs.length * 0.95)].toFixed(2), max: +xs[xs.length - 1].toFixed(2) }; };
  const out = { bodies: app.doc.bodies.length };
  out.firstSnapMs = +time(() => vp.snapPoint(pts[0][0], pts[0][1])).toFixed(1);
  out.warmSnap = stats(pts.map(([x, y]) => time(() => vp.snapPoint(x, y))));
  // Camera changed every query -> reprojection each time (orbit while drawing)
  out.snapAfterCameraMove = stats(pts.slice(0, 40).map(([x, y], i) => {
    vp.camera.position.x += 0.01 * (i % 2 ? 1 : -1); vp.camera.updateMatrixWorld(); vp.requestRender && vp.requestRender();
    if ("stamp" in vp) vp.stamp++;
    return time(() => vp.snapPoint(x, y));
  }));
  app.run("tool.box");
  out.boxToolMove = stats(pts.map(([x, y]) => time(() => canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: x, clientY: y, bubbles: true })))));
  app.run("tool.select");
  return out;
})()
`;

export async function runBench(win: BrowserWindow): Promise<void> {
  try {
    const res = await win.webContents.executeJavaScript(SCENARIO, true);
    console.log(JSON.stringify(res, null, 1));
  } catch (e) {
    console.log(JSON.stringify({ error: String(e) }));
  }
  app.exit(0);
}
