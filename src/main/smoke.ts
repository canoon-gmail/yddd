/**
 * Opt-in end-to-end smoke test. Run with:  Y3D_SMOKE=/tmp/y3d-smoke npx electron .
 * Drives the real UI with synthetic pointer events, captures screenshots and
 * prints a JSON report, then quits. Not loaded during normal use.
 */
import type { BrowserWindow } from "electron";
import { app } from "electron";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

const SCENARIO = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 200 && !window.y3dApp; i++) await sleep(100);
  const app = window.y3dApp;
  if (!app) throw new Error("app did not start");
  const vp = app.viewport;
  const V = vp.camera.position.constructor;
  const canvas = vp.canvas;
  const S = (p) => vp.toScreen(new V(p[0], p[1], p[2]));
  const ev = (type, p, extra = {}) => {
    const s = S(p);
    canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true, ...extra }));
  };
  const clickAt = (p) => { ev("pointermove", p); ev("pointerdown", p); ev("pointerup", p); };
  const toolClicks = (pts) => { for (const p of pts) { ev("pointermove", p); ev("pointerdown", p); } };
  const pickAt = (p, mode) => { const s = S(p); const k = vp.pick(s.x, s.y, mode); return k && { kind: k.kind, body: k.body, id: k.id }; };
  const log = [];
  const state = (label) => log.push({ label, bodies: app.doc.bodies.map((b) => ({ id: b.id, name: b.name, faces: b.shape.faces.length })) });

  vp.setView("iso"); vp.fit(); await sleep(100);

  // 1) Box 60x40x40 on the ground
  app.run("tool.box");
  toolClicks([[-30, -20, 0], [30, 20, 0], [0, 0, 40]]);
  state("box");
  vp.fit(); await sleep(50);

  // 2) Cylinder drawn on the box's top face
  app.run("tool.cylinder");
  toolClicks([[0, 0, 40], [12, 0, 40], [0, 0, 70]]);
  state("cylinder on top face");

  // 3) Union
  app.run("mode.body");
  app.setSelection([{ kind: "body", body: 1, id: 0 }, { kind: "body", body: 2, id: 0 }]);
  app.run("bool.union");
  state("union");
  vp.fit(); await sleep(50);

  // 4) Fillet a top edge of the box (edge mode pick)
  app.run("mode.edge");
  const edge = pickAt([30, 0, 40], "edge");
  log.push({ label: "picked edge", edge });
  if (edge) app.setSelection([edge]);
  app.run("op.fillet");
  await sleep(300);
  log.push({ label: "op panel open", open: !document.getElementById("op-panel").hidden });
  window.__shot1 = true;
  return log;
})()
`;

const SCENARIO_2 = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.y3dApp;
  const vp = app.viewport;
  const V = vp.camera.position.constructor;
  const canvas = vp.canvas;
  const S = (p) => vp.toScreen(new V(p[0], p[1], p[2]));
  const ev = (type, p) => { const s = S(p); canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
  const toolClicks = (pts) => { for (const p of pts) { ev("pointermove", p); ev("pointerdown", p); } };
  const pickAt = (p, mode) => { const s = S(p); const k = vp.pick(s.x, s.y, mode); return k && { kind: k.kind, body: k.body, id: k.id }; };
  const log = [];
  const state = (label) => log.push({ label, bodies: app.doc.bodies.map((b) => ({ id: b.id, name: b.name, faces: b.shape.faces.length })) });

  app.applyOp();
  state("fillet applied");

  // 5) Push/pull the front face (y = -20) out by 10
  app.run("mode.face");
  const face = pickAt([-15, -20, 15], "face");
  log.push({ label: "picked face", face });
  if (face) app.setSelection([face]);
  app.run("op.pushpull");
  app.applyOp();
  state("push/pull");

  // 6) Sphere drawn off to the side, moved onto a corner with the move pipeline, then subtracted
  app.run("mode.body");
  app.setSelection([]);
  app.run("tool.sphere");
  toolClicks([[60, 0, 0], [72, 0, 0]]);
  state("sphere");
  const sphereId = app.doc.bodies[app.doc.bodies.length - 1].id;
  app.setSelection([{ kind: "body", body: sphereId, id: 0 }]);
  app.run("xf.move");
  app.applyTransform({ type: "translate", vector: [-90, 20, 40] });
  app.stopTransform();
  state("sphere moved");
  app.setSelection([{ kind: "body", body: 1, id: 0 }, { kind: "body", body: sphereId, id: 0 }]);
  app.run("bool.subtract");
  state("subtract sphere");

  // 7) Undo / redo
  app.run("edit.undo"); state("undo");
  app.run("edit.redo"); state("redo");

  // 8) Second box beside, then shell it opening its top face
  app.run("tool.box");
  toolClicks([[50, -60, 0], [90, -30, 0], [70, -45, 25]]);
  state("box 2");
  vp.fit(); await sleep(50);
  app.run("mode.face");
  const top = pickAt([70, -45, 25], "face");
  log.push({ label: "picked top", top });
  if (top) app.setSelection([top]);
  app.run("op.shell");
  app.applyOp();
  state("shell");

  // 9) Object snap: a cursor 4px off a corner / edge midpoint locks onto it exactly
  const snapNear = (p) => { const s = S(p); const r = vp.snapPoint(s.x + 4, s.y - 3); return r && { kind: r.kind, p: r.point.toArray().map((n) => +n.toFixed(3)) }; };
  log.push({ label: "snap corner", snap: snapNear([90, -30, 25]) });
  log.push({ label: "snap midpoint", snap: snapNear([70, -30, 25]) });

  // 10) Move from point: box 3's corner (120,-60,0) → box 2's top corner (90,-30,25)
  app.run("mode.body");
  app.setSelection([]);
  app.run("tool.box");
  toolClicks([[120, -60, 0], [130, -50, 0], [125, -55, 10]]);
  const b3 = app.doc.bodies[app.doc.bodies.length - 1].id;
  app.setSelection([{ kind: "body", body: b3, id: 0 }]);
  app.run("xf.moveFrom");
  toolClicks([[120, -60, 0], [90, -30, 25]]);
  const bb = app.doc.get(b3).shape.boundingBox.bounds;
  log.push({ label: "move from point", min: bb[0].map((n) => +n.toFixed(3)) });

  // 11) A + key + B: select box 2 only, press union, click box 3 → one body fewer, box 2 kept
  const before = app.doc.bodies.length;
  const b2 = app.doc.bodies[app.doc.bodies.length - 2].id;
  app.setSelection([{ kind: "body", body: b2, id: 0 }]);
  app.run("bool.union");
  vp.fit(); await sleep(50);
  toolClicks([[95, -25, 35]]);
  log.push({ label: "pick boolean", removed: before - app.doc.bodies.length, kept: !!app.doc.get(b2), gone: !app.doc.get(b3) });

  // 12a) Default startup camera: a rectangle in empty space lies on the floor (z = 0)
  app.run("mode.body"); app.setSelection([]);
  vp.camera.position.set(140, -190, 130); vp.controls.target.set(0, 0, 0); vp.controls.update(); await sleep(50);
  app.run("tool.rectangle");
  toolClicks([[-100, -100, 0], [-80, -80, 0]]);
  const fb = app.doc.bodies[app.doc.bodies.length - 1].shape.boundingBox.bounds;
  log.push({ label: "startup-view rectangle", min: fb[0].map((n) => +n.toFixed(2)), max: fb[1].map((n) => +n.toFixed(2)) });

  // 12) Front view: a rectangle in empty space is drawn on the XZ plane (y = 0)
  app.run("mode.body");
  app.setSelection([]);
  vp.setView("front"); await sleep(50);
  app.run("tool.rectangle");
  toolClicks([[-100, 0, 10], [-80, 0, 30]]);
  const rb = app.doc.bodies[app.doc.bodies.length - 1].shape.boundingBox.bounds;
  log.push({ label: "front-view rectangle", min: rb[0].map((n) => +n.toFixed(2)), max: rb[1].map((n) => +n.toFixed(2)) });

  // 13) Shift+V view menu → press 3 → right view (camera looks along -X)
  app.run("mode.body");
  app.run("view.menu");
  const menuShown = !!document.getElementById("view-menu");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "3", code: "Digit3", bubbles: true }));
  const dir = vp.camera.getWorldDirection(new V()).toArray().map((n) => +n.toFixed(2));
  log.push({ label: "view menu", menuShown, closed: !document.getElementById("view-menu"), dir });
  app.run("view.menu");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "v", code: "KeyV", bubbles: true }));
  log.push({ label: "view flip", dir: vp.camera.getWorldDirection(new V()).toArray().map((n) => +n.toFixed(2)) });

  app.run("mode.body");
  app.setSelection([]);
  vp.setView("iso"); vp.fit();
  await sleep(400);
  return log;
})()
`;

export async function runSmoke(win: BrowserWindow, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const errors: string[] = [];
  win.webContents.on("console-message", (details) => {
    const d = details as unknown as { level: string | number; message: string };
    if ((d.level === "error" || d.level === 3) && !d.message.includes("setPointerCapture")) errors.push(d.message); // synthetic events have no real pointer
  });
  const shot = async (name: string) => {
    const img = await win.webContents.capturePage();
    await writeFile(path.join(outDir, name), img.toPNG());
  };
  let report: unknown[] = [];
  try {
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO, true));
    await shot("1-fillet-preview.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_2, true));
    await shot("2-final.png");
  } catch (e) {
    errors.push(`scenario failed: ${String(e)}`);
    await shot("error.png").catch(() => {});
  }
  console.log("SMOKE_REPORT " + JSON.stringify({ report, errors }, null, 1));
  app.exit(errors.length ? 1 : 0);
}
