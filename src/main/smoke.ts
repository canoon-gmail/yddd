/**
 * Opt-in end-to-end smoke test. Run with:  YDDD_SMOKE=/tmp/yddd-smoke npx electron .
 * (npm run smoke; npm run smoke:half skips scenarios 1–3 — see YDDD_SMOKE_HALF.)
 * Drives the real UI with synthetic pointer events, captures screenshots and
 * prints a JSON report, then quits. Not loaded during normal use. Real mouse input is ignored until the
 * last checks (navigation), so the mouse over the window can't upset it; YDDD_SMOKE_JITTER=1 checks that.
 * One run at a time: runs share /tmp/yddd-smoke (settings, panel width) and the CPU.
 */
import type { BrowserWindow } from "electron";
import { app, Menu } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";

const SCENARIO = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 200 && !window.ydddApp; i++) await sleep(100);
  const app = window.ydddApp;
  if (!app) throw new Error("app did not start");
  const vp = app.viewport;
  const V = vp.camera.position.constructor;
  const canvas = vp.canvas;
  const S = (p) => window.__see(new V(p[0], p[1], p[2]));
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
  const app = window.ydddApp;
  const vp = app.viewport;
  const V = vp.camera.position.constructor;
  const canvas = vp.canvas;
  const S = (p) => window.__see(new V(p[0], p[1], p[2]));
  const ev = (type, p) => { const s = S(p); canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true, ctrlKey: true })); }; // ctrlKey: Ctrl held = snapping on
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

  // 10b) Drag from a pivot dot: press box 3's corner (90,-30,25), drag, release at (100,-30,25)
  app.setSelection([{ kind: "body", body: b3, id: 0 }]);
  app.run("xf.moveFrom");
  const all = vp.pivotCandidates([b3]); const dots = all.length; const visible = vp.visiblePoints(all).length;
  ev("pointermove", [90, -30, 25]); ev("pointerdown", [90, -30, 25]);
  ev("pointermove", [100, -30, 25]); ev("pointerup", [100, -30, 25]);
  const bd = app.doc.get(b3).shape.boundingBox.bounds;
  log.push({ label: "drag from pivot", dots, visible, min: bd[0].map((n) => +n.toFixed(3)) });

  // 10c) Shift+D on a face copies just the face
  const nBefore = app.doc.bodies.length;
  app.setSelection([{ kind: "face", body: b3, id: app.doc.get(b3).shape.faces[0].hashCode }]);
  app.run("edit.duplicate");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  const last = app.doc.bodies[app.doc.bodies.length - 1];
  log.push({ label: "duplicate face", added: app.doc.bodies.length - nBefore, kind: last.kind });

  // 10d) Shift+wheel changes polygon sides (and must not zoom)
  app.run("tool.polygon");
  const s0 = app.tool.sides;
  const cv = document.querySelector("#viewport canvas");
  const camD0 = vp.camera.position.length();
  cv.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, shiftKey: true, bubbles: true, cancelable: true }));
  cv.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, shiftKey: true, bubbles: true, cancelable: true }));
  const s1 = app.tool.sides;
  const zoomed = Math.abs(vp.camera.position.length() - camD0) > 1e-6;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  app.endTool && app.endTool();
  log.push({ label: "polygon shift+wheel", s0, s1, zoomed });

  // 10e) Tab opens the property dialog while drawing: box 20 x 10 x 5 at the cursor
  app.run("tool.box");
  ev("pointermove", [-60, 60, 0]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }));
  const dlg = document.getElementById("props-dlg");
  const ins = dlg ? [...dlg.querySelectorAll("input")] : [];
  [20, 10, 5].forEach((v, k) => { if (ins[k]) ins[k].value = String(v); });
  dlg && dlg.requestSubmit();
  const nb = app.doc.bodies[app.doc.bodies.length - 1];
  const bx = nb.shape.boundingBox.bounds;
  log.push({ label: "tab props box", fields: ins.length, name: nb.name, size: [0, 1, 2].map((k) => +(bx[1][k] - bx[0][k]).toFixed(3)) });

  // 10f) Tab during Move (G) / Rotate (R): exact values
  const tab = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true }));
  const fill = (vals) => { const d = document.getElementById("props-dlg"); const q = d ? [...d.querySelectorAll("input")] : []; vals.forEach((v, k) => { if (q[k]) q[k].value = String(v); }); d && d.requestSubmit(); return q.length; };
  app.setSelection([{ kind: "body", body: nb.id, id: 0 }]);
  app.run("xf.move"); tab(); const mf = fill([5, 0, 0]);
  const m1 = app.doc.get(nb.id).shape.boundingBox.bounds[0].map((n) => +n.toFixed(3));
  app.run("xf.rotate"); tab(); const rf = fill([0, 0, 90]);
  const rbb = app.doc.get(nb.id).shape.boundingBox.bounds;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  log.push({ label: "tab move/rotate", mf, m1, rf, sizeAfterRotate: [0, 1].map((k) => +(rbb[1][k] - rbb[0][k]).toFixed(3)) });

  // 10g) Drag-rotate a bit about Y, then Tab: dialog shows that axis + angle; typing 90 makes the total 90
  app.run("xf.rotate");
  const bb0 = app.doc.get(nb.id).shape.boundingBox.bounds;
  const cen = [0, 1, 2].map((k) => (bb0[0][k] + bb0[1][k]) / 2);
  app.applyTransform({ type: "rotate", angleDeg: 10, axis: [0, 1, 0], center: cen });
  tab();
  const dl = document.getElementById("props-dlg");
  const title = dl ? dl.querySelector("h4").textContent : null;
  const pre = dl ? dl.querySelector("input").value : null;
  fill([90]);
  const ab = app.doc.get(nb.id).shape.boundingBox.bounds;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  log.push({ label: "tab after drag", title, pre, zSize: +(ab[1][2] - ab[0][2]).toFixed(3) });

  // 10h) Shift+D, drag +30 X, then Shift+R twice -> array of copies at +30/+60/+90
  app.setSelection([{ kind: "body", body: nb.id, id: 0 }]);
  const x0 = app.doc.get(nb.id).shape.boundingBox.bounds[0][0];
  const n0 = app.doc.bodies.length;
  app.run("edit.duplicate");
  app.applyTransform({ type: "translate", vector: [30, 0, 0] });
  const shR = () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "R", code: "KeyR", shiftKey: true, bubbles: true }));
  shR(); shR();
  const xs = app.doc.bodies.slice(n0).map((b) => +(b.shape.boundingBox.bounds[0][0] - x0).toFixed(3));
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
  log.push({ label: "shift+R array", xs });

  // 10i) Enter finishes the move gizmo
  app.run("edit.duplicate");
  const xfOn = !!app.xf;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  log.push({ label: "enter finishes move", xfOn, xfAfter: !!app.xf });


  // 10j) Multi-face push/pull: both X-end faces of a box out by 4 -> X size +8
  {
    const b = app.doc.bodies.filter((x) => x.kind === "solid").slice(-1)[0];
    const bb = b.shape.boundingBox.bounds;
    const sx0 = bb[1][0] - bb[0][0];
    const ends = b.shape.faces.filter((f) => { const nn = f.normalAt(f.center).toTuple(); return Math.abs(Math.abs(nn[0]) - 1) < 1e-6; });
    app.run("mode.face");
    app.setSelection(ends.map((f) => ({ kind: "face", body: b.id, id: f.hashCode })));
    app.run("op.pushpull");
    const inp = document.querySelector("#op-panel input[data-key=d]");
    if (inp) { inp.value = "4"; inp.dispatchEvent(new Event("input", { bubbles: true })); }
    app.applyOp();
    const ab = app.doc.get(b.id).shape.boundingBox.bounds;
    log.push({ label: "multi push/pull", faces: ends.length, dx: +((ab[1][0] - ab[0][0]) - sx0).toFixed(3) });
    app.run("mode.body");
  }

  // 11) A + key + B: select box 2 only, press union, click box 3 → one body fewer, box 2 kept
  const before = app.doc.bodies.length;
  const b2 = app.doc.bodies[app.doc.bodies.length - 2].id;
  app.setSelection([{ kind: "body", body: b2, id: 0 }]);
  app.run("bool.union");
  vp.fit(); await sleep(50);
  toolClicks([[105, -25, 35]]);
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

  // 13) V view menu → press 3 → right view (camera looks along -X)
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

const SCENARIO_3 = String.raw`
(async () => {
  // Complex workflow on a fresh document: draw → select → push/pull → boolean → fillet → copy/array → undo/redo.
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp;
  const vp = app.viewport;
  const V = vp.camera.position.constructor;
  const canvas = vp.canvas;
  const S = (p) => window.__see(new V(p[0], p[1], p[2]));
  const ev = (type, p) => { const s = S(p); canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true, ctrlKey: true })); };
  const toolClicks = (pts) => { for (const p of pts) { ev("pointermove", p); ev("pointerdown", p); } };
  const pickAt = (p, mode) => { const s = S(p); const k = vp.pick(s.x, s.y, mode); return k && { kind: k.kind, body: k.body, id: k.id }; };
  const key = (k, code, extra = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true, ...extra }));
  const dialog = (vals) => { const d = document.getElementById("props-dlg"); if (!d) return false; const q = [...d.querySelectorAll("input")]; vals.forEach((v, i) => { if (q[i]) q[i].value = String(v); }); d.requestSubmit(); return true; };
  const opValue = (k, v) => { const i = document.querySelector("#op-panel input[data-key=" + k + "]"); if (i) { i.value = String(v); i.dispatchEvent(new Event("input", { bubbles: true })); } };
  const r = (n) => +n.toFixed(3);
  const size = (id) => { const b = app.doc.get(id).shape.boundingBox.bounds; return [0, 1, 2].map((k) => r(b[1][k] - b[0][k])); };
  const lo = (id) => app.doc.get(id).shape.boundingBox.bounds[0].map(r);
  const last = () => app.doc.bodies[app.doc.bodies.length - 1];
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  app.doc.reset([]);
  app.run("mode.body");
  vp.setView("iso"); vp.fit(); await sleep(100);

  // 0) Empty scene: world origin is a snap point (cursor a few px away → exactly 0,0,0)
  { const o = S([0, 0, 0]); const sp = vp.snapPoint(o.x + 3, o.y + 2); expect("0 origin snap", sp && eq(sp.point.toArray(), [0, 0, 0]), sp && sp.point.toArray()); }

  // 0b) Axis lines are snap lines: near (25,0,0) on X and (0,0,18) on Z → exact points on the axis
  for (const [lbl, pt] of [["X", [25, 0, 0]], ["Z", [0, 0, 18]]]) {
    const o = S(pt); const sp = vp.snapPoint(o.x + 0.4, o.y + 0.4);
    expect("0b axis snap " + lbl, sp && sp.kind === "axis" && eq(sp.point.toArray().map(r), pt), sp && [sp.kind, sp.point.toArray().map(r)]);
  }

  // 0c) Face chords: A starts a rectangle, A C switches to circle, A P to polygon; E no longer starts one
  { const names = [];
    for (const k2 of [null, "c", "p"]) { key("a", "KeyA"); if (k2) key(k2, "Key" + k2.toUpperCase()); names.push(app.tool && app.tool.name); key("Escape", "Escape"); }
    key("e", "KeyE"); const eTool = app.tool && app.tool.name; key("Escape", "Escape");
    expect("0c A chords: rectangle · circle · polygon, E starts nothing", eq(names, ["Rectangle", "Circle", "Polygon"]) && !eTool, { names, eTool }); }

  // 1) Base plate via Tab dialog: 60 x 40 x 10 with its corner at the origin
  app.run("tool.box");
  ev("pointermove", [0, 0, 0]);
  key("Tab", "Tab");
  // 1a) The open dialog holds the tool: moving and clicking elsewhere changes nothing
  { const n = app.doc.bodies.length, st = app.tool && app.tool.stage;
    ev("pointermove", [30, 20, 0]); ev("pointerdown", [30, 20, 0]); ev("pointerup", [30, 20, 0]);
    ev("pointermove", [50, -10, 0]); ev("pointerdown", [50, -10, 0]); ev("pointerup", [50, -10, 0]);
    const d = document.getElementById("props-dlg");
    expect("1a dialog blocks mouse: still open, focused, no new body, same stage", d && d.contains(document.activeElement) && app.doc.bodies.length === n && app.tool && app.tool.stage === st,
      { open: !!d, focused: !!d && d.contains(document.activeElement), bodies: [n, app.doc.bodies.length], stage: [st, app.tool && app.tool.stage] }); }
  expect("1 tab dialog opens", dialog([60, 40, 10]), null);
  const base = last().id;
  expect("1 base size", eq(size(base), [60, 40, 10]), size(base));
  expect("1 base at origin", eq(lo(base), [0, 0, 0]), lo(base));
  vp.fit(); await sleep(50);

  // 2) Rectangle face drawn on the plate's top face, then Push/Pull it into a 15 mm tower
  app.run("tool.rectangle");
  toolClicks([[20, 10, 10], [40, 30, 10]]);
  const rect = last();
  expect("2 rectangle is a face on top", rect.kind === "face" && r(rect.shape.boundingBox.bounds[0][2]) === 10, rect.kind);
  app.setSelection([{ kind: "body", body: rect.id, id: 0 }]);
  app.run("op.pushpull"); opValue("d", 15); app.applyOp();
  const tower = last().id;
  expect("2 tower extruded", eq(size(tower), [20, 20, 15]) && app.doc.get(tower).kind === "solid", size(tower));

  // 3) Union plate + tower (select both, +)
  app.setSelection([{ kind: "body", body: base, id: 0 }, { kind: "body", body: tower, id: 0 }]);
  app.run("bool.union");
  const part = app.doc.bodies.find((b) => b.kind === "solid").id;
  expect("3 union → one body", app.doc.bodies.length === 1, app.doc.bodies.length);
  expect("3 union size", eq(size(part), [60, 40, 25]), size(part));
  expect("3 union renamed Solid", /^Solid \d+$/.test(app.doc.get(part).name), app.doc.get(part).name);
  vp.fit(); await sleep(50);

  // 4) Face mode: pick the tower top and push it up 5
  app.run("mode.face");
  const topFace = pickAt([30, 20, 25], "face");
  expect("4 picked tower top", !!topFace, topFace);
  if (topFace) app.setSelection([topFace]);
  app.run("op.pushpull"); opValue("d", 5); app.applyOp();
  expect("4 tower now 30 high", size(part)[2] === 30, size(part));

  // 5) Multi-face push/pull: both X ends of the plate out by 5
  const P = app.doc.get(part).shape;
  const ends = P.faces.filter((f) => { const n = f.normalAt(f.center).toTuple(); return Math.abs(Math.abs(n[0]) - 1) < 1e-6 && f.center.x !== undefined && Math.abs(f.center.z - 5) < 1e-3; });
  app.setSelection(ends.map((f) => ({ kind: "face", body: part, id: f.hashCode })));
  app.run("op.pushpull"); opValue("d", 5); app.applyOp();
  expect("5 two end faces selected", ends.length === 2, ends.length);
  expect("5 plate now 70 long", size(part)[0] === 70 && lo(part)[0] === -5, [size(part), lo(part)]);

  // 6) Cylinder via Tab on the plate top (r 4, down 40) and subtract → through hole
  app.run("mode.body");
  app.setSelection([]);
  app.run("tool.cylinder");
  ev("pointermove", [5, 20, 10]);
  key("Tab", "Tab");
  dialog([4, -40]);
  const cyl = last().id;
  expect("6 cylinder made", app.doc.get(cyl).kind === "solid" && size(cyl)[0] === 8, size(cyl));
  const facesBefore = app.doc.get(part).shape.faces.length;
  app.setSelection([{ kind: "body", body: part, id: 0 }, { kind: "body", body: cyl, id: 0 }]);
  app.run("bool.subtract");
  expect("6 subtract leaves one body", app.doc.bodies.length === 1, app.doc.bodies.length);
  expect("6 hole adds a face", app.doc.get(part).shape.faces.length > facesBefore, [facesBefore, app.doc.get(part).shape.faces.length]);

  // 7) Fillet a vertical outer edge of the plate (edge-mode pick), r = 2
  app.run("mode.edge");
  const edge = pickAt([65, 0, 5], "edge");
  expect("7 picked edge", !!edge, edge);
  const fBefore = app.doc.get(part).shape.faces.length;
  if (edge) app.setSelection([edge]);
  app.run("op.fillet"); opValue("r", 2); opValue("radius", 2); app.applyOp();
  expect("7 fillet adds a face", app.doc.get(part).shape.faces.length === fBefore + 1, [fBefore, app.doc.get(part).shape.faces.length]);

  // 7b) Pull the flat face beside the fillet out 5: the fillet moves with it (no step left behind), then undo
  {
    app.run("mode.face");
    const side = pickAt([65, 20, 5], "face");
    expect("7b picked face beside fillet", !!side, side);
    const fc = app.doc.get(part).shape.faces.length;
    if (side) app.setSelection([side]);
    app.run("op.pushpull"); opValue("d", 5); app.applyOp();
    const sh = app.doc.get(part).shape;
    const curved = sh.faces.filter((f) => f.geomType === "CYLINDRE" && f.center.x > 65).length;
    expect("7b fillet moved with the face", size(part)[0] === 75 && sh.faces.length === fc && curved === 1, [size(part), fc, sh.faces.length, curved]);
    app.run("edit.undo");
    expect("7b undo", size(part)[0] === 70, size(part));
  }

  // 8) Copy + move with Tab (ΔY 60) + Enter, then Shift+R → array of 3
  app.run("mode.body");
  app.setSelection([{ kind: "body", body: part, id: 0 }]);
  key("D", "KeyD", { shiftKey: true });
  key("Tab", "Tab");
  dialog([0, 60, 0]);
  key("Enter", "Enter");
  expect("8 gizmo closed by Enter", !app.xf, !!app.xf);
  key("R", "KeyR", { shiftKey: true });
  const ys = app.doc.bodies.map((b) => lo(b.id)[1]);
  expect("8 array y offsets", eq(ys, [0, 60, 120]), ys);

  // 9) Undo / redo
  app.run("edit.undo");
  const afterUndo = app.doc.bodies.length;
  app.run("edit.redo");
  expect("9 undo removes the last copy, redo restores", afterUndo === 2 && app.doc.bodies.length === 3, [afterUndo, app.doc.bodies.length]);
  app.run("edit.undo");
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Z", code: "KeyZ", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
  expect("9 Ctrl+Shift+Z redoes too", app.doc.bodies.length === 3, app.doc.bodies.length);

  // 10) G G (Move from point): click a mark → move gizmo appears at that mark; dragging keeps the pivot on the body
  {
    const id = app.doc.bodies[0].id;
    app.setSelection([{ kind: "body", body: id, id: 0 }]);
    vp.fit(); await sleep(50);
    key("g", "KeyG"); key("g", "KeyG");
    const vis = vp.visiblePoints(vp.pivotCandidates([id]));
    const mark = vis.find((c) => c.kind === "vertex") || vis[0];
    const mp = mark.point.toArray().map(r);
    ev("pointermove", mp); ev("pointerdown", mp); ev("pointerup", mp);
    const piv = vp.pivot.position.toArray().map(r);
    expect("10 gizmo shown at clicked mark", !!app.xf && !app.tool && eq(piv, mp), { xf: !!app.xf, piv, mp });
    app.applyTransform({ type: "translate", vector: [0, 0, 7] });
    const piv2 = vp.pivot.position.toArray().map(r);
    expect("10 pivot follows the move", eq(piv2, [mp[0], mp[1], r(mp[2] + 7)]), piv2);
    key("Enter", "Enter");
  }

  // 11) Box with a filleted top edge along X; Push/Pull its X end face (outline includes the fillet arc)
  //     with several live previews first: booleans must not damage the document solid.
  {
    const valid = window.ydddKernel.isValidShape;
    app.run("mode.body");
    app.setSelection([]);
    app.run("tool.box");
    ev("pointermove", [200, 0, 0]);
    key("Tab", "Tab");
    dialog([60, 40, 30]);
    const bx = last().id;
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const e = app.doc.get(bx).shape.edges.find((x) => near(x.startPoint.z, 30) && near(x.endPoint.z, 30) && near(x.startPoint.y, 0) && near(x.endPoint.y, 0));
    app.run("mode.edge");
    app.setSelection([{ kind: "edge", body: bx, id: e.hashCode }]);
    app.run("op.fillet"); opValue("r", 6); opValue("radius", 6); app.applyOp();
    const before = app.doc.get(bx).shape;
    const xEnd = (sh) => sh.faces.find((f) => f.geomType === "PLANE" && near(f.center.x, 260));
    app.run("mode.face");
    app.setSelection([{ kind: "face", body: bx, id: xEnd(before).hashCode }]);
    app.run("op.pushpull");
    for (const v of [5, -5, 12, -12, 3]) { opValue("d", v); app.previewOp(); }
    opValue("d", 15); app.applyOp();
    const after = app.doc.get(bx).shape;
    expect("11 fillet + X push/pull valid", valid(after) && valid(before) && size(bx)[0] === 75, [valid(after), valid(before), size(bx)]);
    const x0 = after.faces.find((f) => f.geomType === "PLANE" && near(f.center.x, 200));
    app.setSelection([{ kind: "face", body: bx, id: x0.hashCode }]);
    app.run("op.pushpull"); opValue("d", -8); app.applyOp();
    expect("11 push the other end in", valid(app.doc.get(bx).shape) && size(bx)[0] === 67, [valid(app.doc.get(bx).shape), size(bx)]);
  }

  // 12) Smart selection on that box: Face mode click on an edge of the selected face → Edge mode;
  //     Solid mode second click on the selected solid → Face mode
  {
    const bx = last().id;
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const click = (p) => { const s = S(p); for (const t of ["pointerdown", "pointerup"]) canvas.dispatchEvent(new PointerEvent(t, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
    const sh = () => app.doc.get(bx).shape;
    const top = sh().faces.find((f) => f.geomType === "PLANE" && near(f.center.z, 30));
    const xMax = sh().boundingBox.bounds[1][0];
    const topItem = { kind: "face", body: bx, id: top.hashCode };
    app.setSelection([{ kind: "body", body: bx, id: 0 }]);
    vp.fit(); await sleep(50);
    app.run("mode.face");
    app.setSelection([topItem]);
    click([xMax - 20, 25, 30]);
    expect("12 click inside the selected face keeps Face mode", app.mode === "face" && eq(app.selection, [topItem]), [app.mode, app.selection]);
    click([xMax, 25, 30]);
    const ids = new Set(top.edges.map((e) => e.hashCode));
    expect("12 click on its edge → Edge mode", app.mode === "edge" && app.selection.length === 1 && app.selection[0].kind === "edge" && ids.has(app.selection[0].id), [app.mode, app.selection]);
    app.run("mode.face");
    app.setSelection([]);
    click([xMax, 25, 30]);
    expect("12 edge click with nothing selected selects a face", app.mode === "face" && app.selection.length === 1 && app.selection[0].kind === "face", [app.mode, app.selection]);
    app.run("mode.body");
    app.setSelection([{ kind: "body", body: bx, id: 0 }]);
    click([xMax - 20, 25, 30]);
    expect("12 second click on selected solid → Face mode", app.mode === "face" && eq(app.selection, [topItem]), [app.mode, app.selection]);
  }

  // 13) Move edge: G with an edge selected reshapes the solid (Tab → exact offset)
  try {
    app.run("mode.body");
    app.setSelection([]);
    app.run("tool.box");
    ev("pointermove", [200, 0, 0]);
    key("Tab", "Tab");
    dialog([40, 30, 20]);
    const bx = last().id;
    const sh = () => app.doc.get(bx).shape;
    const valid = window.ydddKernel.isValidShape;
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    // top edge along X at the back (y = max, z = 20)
    const [blo, bhi] = sh().boundingBox.bounds;
    const top = sh().edges.find((e) => near(e.startPoint.z, 20) && near(e.endPoint.z, 20) && near(e.startPoint.y, bhi[1]) && near(e.endPoint.y, bhi[1]));
    expect("13 box drawn", eq(size(bx), [40, 30, 20]) && !!top, [size(bx), !!top]);
    app.run("mode.edge");
    app.setSelection([{ kind: "edge", body: bx, id: top.hashCode }]);
    app.run("xf.move");
    expect("13 G on an edge starts edge move", app.xf && app.xf.edges && app.xf.edges.length === 1, app.xf);
    key("Tab", "Tab");
    dialog([0, 0, 10]);
    expect("13 raise edge: stays flat-faced, 6 faces, taller", valid(sh()) && eq(size(bx), [40, 30, 30]) && sh().faces.length === 6, [valid(sh()), size(bx), sh().faces.length]);
    expect("13 moved edge stays selected, gizmo stays", app.selection.length === 1 && app.selection[0].kind === "edge" && app.xf && app.xf.edges, [app.selection, !!app.xf]);
    key("Tab", "Tab");
    dialog([10, 0, 0]);
    expect("13 shift edge sideways: bent side faces split, valid", valid(sh()) && eq(size(bx), [50, 30, 30]) && sh().faces.length > 6, [valid(sh()), size(bx), sh().faces.length]);
    key("Enter", "Enter");
    expect("13 Enter ends edge move", !app.xf, app.xf);
    app.run("edit.undo");
    app.run("edit.undo");
    expect("13 undo twice restores the box", eq(size(bx), [40, 30, 20]) && sh().faces.length === 6, [size(bx), sh().faces.length]);
    app.run("mode.body");
  } catch (e) {
    expect("13 move edge threw", false, String(e && e.stack || e));
  }

  // 13b) Move edge on a solid with a curved part elsewhere (box + cylinder): only the faces round the edge must be flat
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    // 40 × 30 × 20 box at x -20..20, y 685..715 with a R10 cylinder on its +X side; the -X face divided at z = 10
    let u = K.booleanOp("union", K.makeBox(G, [0, 700, 0], 40, 30, 20), [K.makeCylinder(G, [25, 700, 0], 10, 30)]);
    u = K.splitFaceByLine(u, [-20, 685, 10], [-20, 715, 10]);
    const b = app.doc.makeBody(u, "Box + cylinder");
    app.doc.commit([...app.doc.bodies, b], "box + cylinder");
    const mid = (x = -20) => app.doc.get(b.id).shape.edges.find((e) => near(e.startPoint.x, x) && near(e.endPoint.x, x) && near(e.startPoint.z, 10) && near(e.endPoint.z, 10));
    const v0 = K.solidVolume(app.doc.get(b.id).shape);
    app.run("mode.edge");
    app.setSelection([{ kind: "edge", body: b.id, id: mid().hashCode }]);
    app.run("xf.move");
    const started = !!(app.xf && app.xf.edges);
    key("Tab", "Tab");
    dialog([-5, 0, 0]);
    const sh = app.doc.get(b.id).shape, moved = mid(-25), v1 = K.solidVolume(sh);
    const curved = sh.faces.filter((f) => f.geomType === "CYLINDRE").length;
    // (the -X side becomes a wedge sticking out 5: + 30 × 20 × 5 / 2)
    expect("13b G on the divided edge of a box fused with a cylinder: moves it, the cylinder stays", started && K.isValidShape(sh) && !!moved && curved >= 1 && Math.abs(v1 - v0 - 1500) < 1e-3, { started, valid: K.isValidShape(sh), moved: !!moved, curved, dv: v1 - v0 });
    key("Enter", "Enter");
    app.setSelection([{ kind: "body", body: b.id, id: 0 }]); app.run("mode.body"); app.run("edit.delete");
  } catch (e) {
    expect("13b move edge (box + cylinder) threw", false, String(e && e.stack || e));
  }

  // 13c) …and a vertical edge whose ends lie on faces with arcs (the cylinder cuts into the top / bottom): those stay flat
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    // 40 × 30 × 20 box at x -20..20, y 685..715, a R10 cylinder round its back edge; the front face divided at x = 0
    let u = K.booleanOp("union", K.makeBox(G, [0, 700, 0], 40, 30, 20), [K.makeCylinder(G, [0, 715, 0], 10, 30)]);
    u = K.splitFaceByLine(u, [0, 685, 0], [0, 685, 20]);
    const b = app.doc.makeBody(u, "Box + cylinder 2");
    app.doc.commit([...app.doc.bodies, b], "box + cylinder 2");
    const edgeAt = (y) => app.doc.get(b.id).shape.edges.find((e) => near(e.startPoint.x, 0) && near(e.endPoint.x, 0) && near(e.startPoint.y, y) && near(e.endPoint.y, y) && !near(e.startPoint.z, e.endPoint.z));
    const v0 = K.solidVolume(app.doc.get(b.id).shape);
    app.run("mode.edge");
    app.setSelection([{ kind: "edge", body: b.id, id: edgeAt(685).hashCode }]);
    app.run("xf.move");
    const started = !!(app.xf && app.xf.edges);
    key("Tab", "Tab");
    dialog([0, -5, 0]);
    const sh = app.doc.get(b.id).shape, v1 = K.solidVolume(sh);
    const arcs = sh.edges.filter((e) => e.geomType === "CIRCLE").length;
    // (a wedge out the front: 40 × 5 / 2 × 20)
    expect("13c G on a vertical edge ending on faces with arcs (box + cylinder): moves it, the faces keep their arcs", started && K.isValidShape(sh) && !!edgeAt(680) && arcs >= 2 && Math.abs(v1 - v0 - 2000) < 1e-3, { started, valid: K.isValidShape(sh), moved: !!edgeAt(680), arcs, dv: v1 - v0 });
    key("Enter", "Enter");
    app.setSelection([{ kind: "body", body: b.id, id: 0 }]); app.run("mode.body"); app.run("edit.delete");
  } catch (e) {
    expect("13c move edge (vertical, faces with arcs) threw", false, String(e && e.stack || e));
  }

  // 13d) Shift+D on a closed loop of edges → a flat face copy (on the move gizmo); a single straight edge still starts a guide
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const cyl = app.doc.makeBody(K.makeCylinder(G, [0, 900, 0], 10, 20), "Cylinder"), box = app.doc.makeBody(K.makeBox(G, [60, 900, 0], 40, 30, 20), "Box");
    app.doc.commit([...app.doc.bodies, cyl, box], "loop shapes");
    const area = (b) => b.shape.faces.reduce((s, f) => s + K.faceInfo(b.shape, f.hashCode).area, 0);
    const dup = (items) => { app.run("mode.edge"); app.setSelection(items); const n = app.doc.bodies.length; key("D", "KeyD", { shiftKey: true }); const made = app.doc.bodies.length > n ? last() : null; const r = { made, gizmo: !!app.xf, mode: app.mode }; key("Escape", "Escape"); return r; };
    // The cylinder's top circle (one closed edge)
    const rim = app.doc.get(cyl.id).shape.edges.find((e) => e.geomType === "CIRCLE" && near(e.startPoint.z, 20));
    const c = dup([{ kind: "edge", body: cyl.id, id: rim.hashCode }]);
    const cOk = c.made && c.made.kind === "face" && Math.abs(area(c.made) - Math.PI * 100) < 1e-6 && c.gizmo && c.mode === "body";
    // The box's 4 top edges (end to end, round the top face)
    const tops = app.doc.get(box.id).shape.edges.filter((e) => near(e.startPoint.z, 20) && near(e.endPoint.z, 20));
    const b = dup(tops.map((e) => ({ kind: "edge", body: box.id, id: e.hashCode })));
    const bOk = tops.length === 4 && b.made && b.made.kind === "face" && Math.abs(area(b.made) - 1200) < 1e-6;
    // 3 of them: not a loop → no face
    const n3 = app.doc.bodies.length;
    const t = dup(tops.slice(0, 3).map((e) => ({ kind: "edge", body: box.id, id: e.hashCode })));
    const openOk = !(t.made && t.made.kind === "face");
    if (app.doc.bodies.length > n3) app.run("edit.undo");
    // One straight edge: the guide line tool, as before
    app.run("mode.edge"); app.setSelection([{ kind: "edge", body: box.id, id: tops[0].hashCode }]);
    key("D", "KeyD", { shiftKey: true });
    const guide = app.tool && app.tool.name;
    key("Escape", "Escape"); key("Escape", "Escape");
    expect("13d Shift+D on a closed loop → a flat face copy on the gizmo (circle: π·10², box top: 40 × 30); 3 edges: no face; one edge: guide", cOk && bOk && openOk && guide === "Guide line",
      { c: c.made && { kind: c.made.kind, area: area(c.made), gizmo: c.gizmo, mode: c.mode }, b: b.made && { kind: b.made.kind, area: area(b.made) }, tops: tops.length, openOk, guide });
    app.run("mode.body");
    app.setSelection([cyl, box, c.made, b.made].filter(Boolean).map((x) => ({ kind: "body", body: x.id, id: 0 }))); app.run("edit.delete");
  } catch (e) {
    expect("13d Shift+D on a loop threw", false, String(e && e.stack || e));
  }

  // 13e) Scale: the ring dragged with Shift scales about the centre (without: the base stays put); the X / Y / Z boxes ignore Shift
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const r3 = (v) => Math.round(v * 1e6) / 1e6;
    const bx = app.doc.makeBody(K.makeBox(G, [0, 1100, 0], 40, 30, 20), "Box");
    app.doc.commit([...app.doc.bodies, bx], "scale box");
    const ringDrag = async (shift) => {
      app.run("mode.body"); app.setSelection([{ kind: "body", body: bx.id, id: 0 }]); app.run("xf.scale"); await sleep(30);
      const drags = app.op.spec.drag, ri = drags.findIndex((d) => d.look === "ring");
      {
        // (the ring's axis pointing near the camera can't be dragged on screen: then from the top)
        const d0 = drags[ri], a = vp.toScreen(new V(...d0.origin)), b = vp.toScreen(new V(...d0.origin).addScaledVector(new V(...d0.dir).normalize(), 10));
        if (Math.hypot(b.x - a.x, b.y - a.y) < 10) { vp.setView("top"); vp.fit([bx.id]); await sleep(30); }
      }
      app.op.active = ri; app.op.anchor = undefined;
      const h = document.querySelectorAll("#op-handles .op-handle")[ri].getBoundingClientRect();
      const x0 = h.left + h.width / 2, y0 = h.top + h.height / 2;
      app.opDrag(new PointerEvent("pointermove", { clientX: x0, clientY: y0, shiftKey: shift }));
      // outward along the ring's axis on screen (from the base — or with Shift the centre — to the corner)
      const drag = drags[ri], o = new V(...app.dragOrigin(drag)), dv = new V(...app.dragDir(drag)).normalize();
      const s0 = vp.toScreen(o), s1 = vp.toScreen(o.clone().addScaledVector(dv, 10)), ul = Math.hypot(s1.x - s0.x, s1.y - s0.y), ux = s1.x - s0.x, uy = s1.y - s0.y;
      for (const k of [20, 40, 60]) app.opDrag(new PointerEvent("pointermove", { clientX: x0 + ux / ul * k, clientY: y0 + uy / ul * k, shiftKey: shift }));
      const box = document.querySelector("#op-panel input[data-key=center]").checked, sv = Number(document.querySelector("#op-panel input[data-key=s]").value);
      app.applyOp(); await sleep(30);
      const [lo, hi] = app.doc.get(bx.id).shape.boundingBox.bounds;
      return { box, sv, lo: lo.map(r3), hi: hi.map(r3) };
    };
    const a = await ringDrag(true);
    const aOk = a.box && a.sv > 101 && Math.abs((a.lo[2] + a.hi[2]) / 2 - 10) < 1e-6 && a.lo[2] < -1e-3 && Math.abs((a.lo[1] + a.hi[1]) / 2 - 1100) < 1e-6;
    app.run("edit.undo"); await sleep(30);
    const b = await ringDrag(false);
    const bOk = !b.box && b.sv > 101 && Math.abs(b.lo[2]) < 1e-6 && b.hi[2] > 20.001;
    app.run("edit.undo"); await sleep(30);
    // An axis box with Shift: no centre checkbox change
    app.setSelection([{ kind: "body", body: bx.id, id: 0 }]); app.run("xf.scale"); await sleep(30);
    const xi = app.op.spec.drag.findIndex((d) => d.key === "x");
    app.op.active = xi; app.op.anchor = undefined;
    app.opDrag(new PointerEvent("pointermove", { clientX: 100, clientY: 100, shiftKey: true }));
    app.opDrag(new PointerEvent("pointermove", { clientX: 140, clientY: 100, shiftKey: true }));
    const xBox = document.querySelector("#op-panel input[data-key=center]").checked;
    app.cancelOp();
    expect("13e Scale ring + Shift: about the centre (centre stays at z 10); without Shift: base stays at z 0; X box ignores Shift", aOk && bOk && !xBox, { a, b, xBox });
    app.setSelection([{ kind: "body", body: bx.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("13e scale ring + Shift threw", false, String(e && e.stack || e));
  }

  // 13f) Scale panel: sizes typed into the % fields — X "+10mm", Z "-5mm"; Scale "60mm" (the longest side → 60)
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const bx = app.doc.makeBody(K.makeBox(G, [0, 1200, 0], 40, 30, 20), "Box");
    app.doc.commit([...app.doc.bodies, bx], "scale box mm");
    const field = (k) => document.querySelector("#op-panel input[data-key=" + k + "]");
    app.run("mode.body"); app.setSelection([{ kind: "body", body: bx.id, id: 0 }]); app.run("xf.scale"); await sleep(30);
    opValue("x", "+10mm"); opValue("z", "-5 mm");
    field("x").dispatchEvent(new Event("change", { bubbles: true }));
    const shownX = field("x").value;
    app.applyOp(); await sleep(30);
    const s1 = size(bx.id);
    app.setSelection([{ kind: "body", body: bx.id, id: 0 }]); app.run("xf.scale"); await sleep(30);
    opValue("s", "60mm"); app.applyOp(); await sleep(30);
    const s2 = size(bx.id);
    app.setSelection([{ kind: "body", body: bx.id, id: 0 }]); app.run("xf.scale"); await sleep(30);
    opValue("y", "+10%"); app.applyOp(); await sleep(30);
    const s3 = size(bx.id);
    expect("13f Scale fields take sizes: X +10mm → 50 (shown 125), Z -5mm → 15; Scale 60mm → longest side 60; Y +10% → ×1.1", eq(s1, [50, 30, 15]) && shownX === "125" && eq(s2, [60, 36, 18]) && eq(s3, [60, 39.6, 18]), { s1, shownX, s2, s3 });
    app.setSelection([{ kind: "body", body: bx.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("13f scale sizes threw", false, String(e && e.stack || e));
  }

  // 13g) Tapered planter (300 square top, 220 bottom, 450 high): box, G each bottom edge 40 inward (Tab), Shell the top open
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const pl = app.doc.makeBody(K.makeBox(G, [0, 2000, 0], 300, 300, 450), "Planter");
    app.doc.commit([...app.doc.bodies, pl], "planter box");
    const sh = () => app.doc.get(pl.id).shape;
    // bottom edge on a side (x = ±150 or y = 2000 ± 150 — where it is before its own move), moved 40 inward
    const sides = [[(e) => near(e.startPoint.y, 1850) && near(e.endPoint.y, 1850), [0, 40, 0]], [(e) => near(e.startPoint.y, 2150) && near(e.endPoint.y, 2150), [0, -40, 0]],
      [(e) => near(e.startPoint.x, -150) && near(e.endPoint.x, -150), [40, 0, 0]], [(e) => near(e.startPoint.x, 150) && near(e.endPoint.x, 150), [-40, 0, 0]]];
    app.run("mode.edge");
    const moved = [];
    for (const [pick, d] of sides) {
      const e = sh().edges.find((e) => near(e.startPoint.z, 0) && near(e.endPoint.z, 0) && pick(e));
      moved.push(!!e);
      if (!e) break;
      app.setSelection([{ kind: "edge", body: pl.id, id: e.hashCode }]); app.run("xf.move");
      key("Tab", "Tab"); dialog(d); key("Enter", "Enter"); await sleep(20);
    }
    const tapered = sh(), [lo, hi] = tapered.boundingBox.bounds;
    const bottom = tapered.faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[2] < -0.99);
    const bb = bottom && bottom.boundingBox.bounds;
    const frustum = 450 / 3 * (300 * 300 + 220 * 220 + 300 * 220), v0 = K.solidVolume(tapered);
    const top = tapered.faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[2] > 0.99);
    app.run("mode.face"); app.setSelection([{ kind: "face", body: pl.id, id: top.hashCode }]); app.run("op.shell"); opValue("t", 30); app.applyOp(); await sleep(30);
    const v1 = K.solidVolume(sh());
    // Hollow: the cavity is a frustum from z 30 to 450, its sides 2 × 30 / cos(taper) narrower than the outside's
    const w = 2 * 30 * Math.hypot(450, 40) / 450, side = (z) => 220 + 80 * z / 450 - w, a = side(450), b = side(30);
    const shelled = v0 - 420 / 3 * (a * a + b * b + a * b);
    expect("13g tapered planter: 4 bottom edges G'd 40 inward → 220 square bottom, 6 flat faces, frustum volume; Shell 30 top open → hollow",
      moved.every(Boolean) && moved.length === 4 && tapered.faces.length === 6 && bb && near(bb[1][0] - bb[0][0], 220) && near(bb[1][1] - bb[0][1], 220) && near(hi[0] - lo[0], 300) && near(hi[2] - lo[2], 450)
        && Math.abs(v0 - frustum) < 1e-3 && K.isValidShape(sh()) && Math.abs(v1 - shelled) < 1e-2,
      { moved, faces: tapered.faces.length, bottom: bb && [bb[1][0] - bb[0][0], bb[1][1] - bb[0][1]], v0, frustum, v1, shelled });
    app.run("mode.body"); app.setSelection([{ kind: "body", body: pl.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("13g tapered planter threw", false, String(e && e.stack || e));
  }

  // 13h) Move edge: Tab right after a drag shows that drag's offset; OK replaces it (one undo step back to the box)
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const pb = app.doc.makeBody(K.makeBox(G, [0, 2600, 0], 300, 300, 450), "Box");
    app.doc.commit([...app.doc.bodies, pb], "edge tab box");
    const sh = () => app.doc.get(pb.id).shape;
    const e = sh().edges.find((e) => near(e.startPoint.z, 0) && near(e.endPoint.z, 0) && near(e.startPoint.y, 2450) && near(e.endPoint.y, 2450));
    app.run("mode.edge"); app.setSelection([{ kind: "edge", body: pb.id, id: e.hashCode }]); app.run("xf.move");
    app.applyEdgeMove([7, 0, 0], true); // (what a drag of the gizmo along X ends with)
    key("Tab", "Tab"); await sleep(20);
    const d = document.getElementById("props-dlg");
    const shown = d ? [...d.querySelectorAll("input")].map((i) => Number(i.value)) : null, title = d && d.textContent;
    dialog([0, 40, 0]); await sleep(20);
    const [lo, hi] = sh().boundingBox.bounds;
    const bottom = sh().faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[2] < -0.99), bb = bottom.boundingBox.bounds;
    const after = { x: [lo[0], hi[0]], bottomY: bb[0][1], faces: sh().faces.length, sel: app.selection.length, gizmo: !!(app.xf && app.xf.edges) };
    // A drag on that edge, then another edge picked: Tab starts from 0 (it doesn't touch the other's drag)
    app.applyEdgeMove([5, 0, 0], true);
    const other = sh().edges.find((e) => near(e.startPoint.z, 450) && near(e.endPoint.z, 450) && near(e.startPoint.y, 2750) && near(e.endPoint.y, 2750));
    app.setSelection([{ kind: "edge", body: pb.id, id: other.hashCode }]); await sleep(20);
    key("Tab", "Tab"); await sleep(20);
    const d2 = document.getElementById("props-dlg"), shown2 = d2 ? [...d2.querySelectorAll("input")].map((i) => Number(i.value)).join() : null;
    if (d2) d2.querySelector("[data-act=cancel]")?.click();
    key("Escape", "Escape"); key("Enter", "Enter"); await sleep(20);
    app.run("edit.undo"); await sleep(20);
    app.run("edit.undo"); await sleep(20);
    const back = sh().faces.length === 6 && near(sh().boundingBox.bounds[0][1], 2450) && K.solidVolume(sh()) > 300 * 300 * 450 - 1e-3;
    expect("13h Move edge: Tab after a drag shows it (7, 0, 0 — 'last drag'), typed 0, 40, 0 replaces it; one undo → the box", !!shown && shown.join() === "7,0,0" && /last drag/.test(title) && near(after.x[0], -150) && near(after.x[1], 150) && near(after.bottomY, 2490) && after.faces === 6 && after.sel === 1 && after.gizmo && back && shown2 === "0,0,0",
      { shown, title: title && title.slice(0, 40), after, back, shown2 });
    app.run("mode.body"); app.setSelection([{ kind: "body", body: pb.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("13h edge move Tab after drag threw", false, String(e && e.stack || e));
  }

  // 13i) Move guide: Tab right after a drag shows it and replaces it (one undo back); Tab after a Tab adds (from 0)
  try {
    const g0 = app.doc.guides.length;
    app.doc.setGuides([...app.doc.guides, { a: [-50, 2800, 0], b: [50, 2800, 0], n: [0, 1, 0] }], "guide for Tab");
    const gi = app.doc.guides.length - 1;
    app.run("mode.body"); app.setSelection([]);
    app.selGuide = gi; app.run("xf.move");
    const moving = !!(app.xf && app.xf.guide === gi);
    app.applyGuideMove([7, 0, 0], true); // (what a drag of the gizmo along X ends with)
    key("Tab", "Tab"); await sleep(20);
    const d1 = document.getElementById("props-dlg"), title = d1 && d1.textContent, shown = d1 ? [...d1.querySelectorAll("input")].map((i) => Number(i.value)).join() : null;
    dialog([0, 5, 0]); await sleep(20);
    const g = app.doc.guides[gi], replaced = g && g.a.join() === "-50,2805,0" && g.b.join() === "50,2805,0";
    key("Tab", "Tab"); await sleep(20);
    const d2 = document.getElementById("props-dlg"), shown2 = d2 ? [...d2.querySelectorAll("input")].map((i) => Number(i.value)).join() : null;
    d2?.querySelector("[data-act=cancel]")?.click();
    key("Escape", "Escape"); await sleep(20);
    app.run("edit.undo"); await sleep(20);
    const back = app.doc.guides[gi] && app.doc.guides[gi].a.join() === "-50,2800,0";
    expect("13i Move guide: Tab after a drag shows it (7, 0, 0 — 'last drag'), typed 0, 5, 0 replaces it, one undo → back; Tab after that starts from 0",
      moving && /last drag/.test(title) && shown === "7,0,0" && replaced && shown2 === "0,0,0" && back, { moving, title: title && title.slice(0, 30), shown, guide: g && [g.a, g.b], shown2, back });
    app.doc.setGuides(app.doc.guides.slice(0, g0), "remove guide");
  } catch (e) {
    expect("13i guide move Tab after drag threw", false, String(e && e.stack || e));
  }

  // 13j) Shift+D on a closed loop that isn't flat (where a thin cylinder pierces a thick one): refused, nothing added
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const SIDE = { origin: [0, 0, 0], x: [0, 1, 0], y: [0, 0, 1], z: [1, 0, 0] }; // (along X)
    const u = K.booleanOp("union", K.makeCylinder(G, [0, 3000, 0], 10, 40), [K.makeCylinder(SIDE, [-20, 3000, 20], 6, 40)]);
    const cb = app.doc.makeBody(u, "Pierced");
    app.doc.commit([...app.doc.bodies, cb], "pierced cylinder");
    // The loop on the +X side: the curved edges (not lines / circles) there
    const loop = app.doc.get(cb.id).shape.edges.filter((e) => e.geomType !== "LINE" && e.geomType !== "CIRCLE" && e.pointAt(0.5).x > 1 && e.pointAt(0.5).x < 10.5);
    const flat = (() => { const z = loop.flatMap((e) => [0, 0.25, 0.5, 0.75].map((t) => e.pointAt(t).x)); return Math.max(...z) - Math.min(...z) < 1e-6; })();
    document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
    app.run("mode.edge"); app.setSelection(loop.map((e) => ({ kind: "edge", body: cb.id, id: e.hashCode })));
    const n = app.doc.bodies.length;
    key("D", "KeyD", { shiftKey: true }); await sleep(20);
    const err = [...document.querySelectorAll("#toasts .toast.error")].map((t) => t.textContent).join(" | ");
    key("Escape", "Escape");
    expect("13j Shift+D on a closed loop that isn't flat: refused ('isn't flat'), nothing added", loop.length >= 1 && !flat && /isn't flat/.test(err) && app.doc.bodies.length === n && !app.tool,
      { edges: loop.length, kinds: loop.map((e) => e.geomType), flat, err, added: app.doc.bodies.length - n, tool: app.tool && app.tool.name });
    app.run("mode.body"); app.setSelection([{ kind: "body", body: cb.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("13j Shift+D on a non-flat loop threw", false, String(e && e.stack || e));
  }

  // 14) Draw line on face (L): split the top face between the two long-edge midpoints, then G lifts the ridge → gable roof
  try {
    const valid = window.ydddKernel.isValidShape;
    app.run("mode.body");
    app.setSelection([]);
    app.run("tool.box");
    ev("pointermove", [400, 0, 0]);
    key("Tab", "Tab");
    dialog([40, 30, 20]);
    const bx = last().id;
    const sh = () => app.doc.get(bx).shape;
    app.setSelection([{ kind: "body", body: bx, id: 0 }]);
    vp.setView("iso"); app.run("view.fitSelection"); await sleep(50);
    app.setSelection([]);
    app.run("tool.divideFace");
    toolClicks([[420, 0, 20], [420, 30, 20]]);
    const sel = app.selection[0];
    expect("14 draw line on face splits the top face, new edge selected in Edge mode", sh().faces.length === 7 && valid(sh()) && app.mode === "edge" && app.selection.length === 1 && sel.kind === "edge", [sh().faces.length, valid(sh()), app.mode, app.selection]);
    const e = sel && sh().edges.find((x) => x.hashCode === sel.id);
    const r3 = (p) => [p.x, p.y, p.z].map((n) => +n.toFixed(6));
    expect("14 new edge runs exactly between the midpoints", e && eq([r3(e.startPoint), r3(e.endPoint)].sort(), [[420, 0, 20], [420, 30, 20]].sort()), e && [r3(e.startPoint), r3(e.endPoint)]);
    app.run("xf.move");
    key("Tab", "Tab");
    dialog([0, 0, 10]);
    key("Enter", "Enter");
    expect("14 G lifts the ridge: gable house (7 faces, 30 tall)", valid(sh()) && eq(size(bx), [40, 30, 30]) && sh().faces.length === 7, [valid(sh()), size(bx), sh().faces.length]);
    // 14b) Draw line on face on a flat rectangle face: refused with an error toast, face unchanged, tool stays
    app.setSelection([]);
    app.run("tool.rectangle"); ev("pointermove", [400, 100, 0]); key("Tab", "Tab"); dialog([40, 30]);
    const rf = last(), rfFaces = rf.shape.faces ? rf.shape.faces.length : 1, toasts = document.querySelectorAll(".toast.error").length;
    app.setSelection([{ kind: "body", body: rf.id, id: 0 }]); app.run("view.fitSelection"); await sleep(50); app.setSelection([]);
    const rb = rf.shape.boundingBox.bounds, mx = (rb[0][0] + rb[1][0]) / 2;
    app.run("tool.divideFace");
    toolClicks([[mx, rb[0][1], 0], [mx, rb[1][1], 0]]);
    const t = [...document.querySelectorAll(".toast.error")].slice(toasts).map((x) => x.textContent);
    expect("14b divide a flat face: error toast, face unchanged, tool kept", t.some((x) => x.includes("works on solids only")) && app.doc.get(rf.id).kind === "face" && (app.doc.get(rf.id).shape.faces ? app.doc.get(rf.id).shape.faces.length : 1) === rfFaces && !!app.tool, { toasts: t, kind: app.doc.get(rf.id).kind, tool: !!app.tool });
    key("Escape", "Escape");
    app.setSelection([{ kind: "body", body: rf.id, id: 0 }]); app.run("edit.delete");
    app.setSelection([{ kind: "body", body: bx, id: 0 }]); app.run("view.fitSelection"); await sleep(50); app.setSelection([]); // camera back for the next steps
    app.run("mode.body");
  } catch (e) {
    expect("14 draw line on face threw", false, String(e && e.stack || e));
  }

  // 15) Offset face with round corners: 40 x 30 top grows by 5 (4 arcs), shrinks by 5 (still 4 arcs)
  try {
    app.run("mode.body"); app.setSelection([]);
    app.run("tool.box"); ev("pointermove", [0, -200, 0]); key("Tab", "Tab"); dialog([40, 30, 10]);
    const ob = last().id;
    const topOf = (id) => app.doc.get(id).shape.faces.find((f) => f.normalAt(f.center).toTuple()[2] > 0.99 && Math.abs(f.center.z - 10) < 1e-6);
    for (const [d, want] of [[5, [50, 40, 0]], [-5, [30, 20, 0]]]) {
      app.setSelection([{ kind: "face", body: ob, id: topOf(ob).hashCode }]);
      app.run("op.offset"); opValue("d", d);
      const cb = document.querySelector("#op-panel input[data-key=round]"); cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true }));
      app.applyOp();
      const f = last().shape, arcs = f.edges.filter((e) => e.geomType === "CIRCLE").length;
      expect("15 round offset " + d, last().id !== ob && eq(size(last().id), want) && arcs === 4 && window.ydddKernel.isValidShape(f), [size(last().id), arcs]);
    }
    // Make ring: only the band between the top's outline and the offset outline (a face with one hole)
    const check = (k, on) => { const cb = document.querySelector("#op-panel input[data-key=" + k + "]"); cb.checked = on; cb.dispatchEvent(new Event("change", { bubbles: true })); };
    for (const [d, want] of [[5, [50, 40, 0]], [-5, [40, 30, 0]]]) {
      app.setSelection([{ kind: "face", body: ob, id: topOf(ob).hashCode }]);
      app.run("op.offset"); opValue("d", d); check("round", false); check("ring", true);
      app.applyOp();
      const f = last().shape, holes = f.faces.length === 1 ? f.faces[0].clone().innerWires().length : -1;
      expect("15 offset ring " + d, last().id !== ob && eq(size(last().id), want) && holes === 1 && window.ydddKernel.isValidShape(f), [size(last().id), holes]);
    }
    // Right click on empty space clears the selection (like a left click)
    app.setSelection([{ kind: "body", body: ob, id: 0 }]);
    const r = canvas.getBoundingClientRect();
    for (const t of ["pointerdown", "pointerup"]) canvas.dispatchEvent(new PointerEvent(t, { clientX: r.left + 3, clientY: r.top + 3, button: 2, bubbles: true }));
    expect("15 right click on nothing clears the selection", app.selection.length === 0, app.selection.length);
    app.run("mode.body");
  } catch (e) {
    expect("15 round offset threw", false, String(e && e.stack || e));
  }

  // 15b) Revolve (Pro: R E) and Sweep (Pro: S W) — the second key lands in the panel the first one opened
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const XZ = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] }; // a plane square to Y
    const add = (shape, name, kind) => { const b = app.doc.makeBody(shape, name, kind); app.doc.commit([...app.doc.bodies, b], name); return b.id; };
    const pick = (k, text) => { const sel = document.querySelector("#op-panel select[data-key=" + k + "]"); const o = [...sel.options].find((o) => o.text.startsWith(text)); sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); };
    const wasPro = document.body.classList.contains("pro");
    document.body.classList.add("pro");
    const chord = async (k1, k2) => { key(k1, "Key" + k1.toUpperCase()); await sleep(20); (document.activeElement || window).dispatchEvent(new KeyboardEvent("keydown", { key: k2, code: "Key" + k2.toUpperCase(), bubbles: true, cancelable: true })); await sleep(20); };
    const opErr = () => document.querySelector("#op-panel .op-error").textContent;
    const near = (v, want) => Math.abs(v - want) < want * 0.002;
    const g0 = app.doc.guides.length;
    // Donut: a circle r 5 at x 30 standing up, about a guide along Z through x 0 (picked by default: the nearest axis that works)
    app.doc.setGuides([...app.doc.guides, { a: [0, 4000, -10], b: [0, 4000, 10] }], "axis guide");
    const circle = add(K.makeCircleFace(XZ, [30, 4000, 0], 5), "Circle", "face");
    app.run("mode.body"); app.setSelection([{ kind: "body", body: circle, id: 0 }]);
    await chord("r", "e");
    const axisName = document.querySelector("#op-panel select[data-key=axis]").selectedOptions[0].text;
    pick("axis", "Y axis"); await sleep(150); const square = opErr();
    pick("axis", "Guide line 1"); await sleep(150);
    app.applyOp();
    const donut = app.doc.get(circle) ? null : last();
    const dv = donut && K.solidVolume(donut.shape), torus = donut && donut.shape.faces.map((f) => f.geomType).join();
    expect("15b Revolve: circle beside a Z guide → donut (torus face, volume 2π²Rr²) replacing the face; Y axis refused (square to the face)",
      /^Guide line 1/.test(axisName) && /square/.test(square) && donut && donut.kind === "solid" && torus === "TORUS" && near(dv, 2 * Math.PI ** 2 * 30 * 25) && K.isValidShape(donut.shape),
      { axisName, square, torus, dv });
    app.doc.setGuides(app.doc.guides.slice(0, g0), "remove guide");
    // Quarter turn of a 10 x 20 rectangle about one of its edges → a quarter cylinder (r 10 · 20 long or r 20 · 10 long)
    const rect = add(K.makeRectFace(G, [100, 4000, 0], 10, 20), "Rect", "face");
    app.setSelection([{ kind: "body", body: rect, id: 0 }]); app.run("op.revolve"); await sleep(20);
    pick("axis", "Face edge 1"); opValue("angle", 90); await sleep(150); app.applyOp();
    const quarter = last().id, qv = K.solidVolume(last().shape);
    expect("15b Revolve 90° about a face edge → quarter cylinder", (near(qv, Math.PI * 100 * 20 / 4) || near(qv, Math.PI * 400 * 10 / 4)) && K.isValidShape(last().shape), qv);
    {
      // Clicks in the viewport pick the axis: a straight edge of the face, the Z axis line (10 x 10 square at x 50 → ring π(55² − 45²)·10)
      const nb0 = app.doc.bodies.length;
      const rq = add(K.makeRectFace(XZ, [50, 0, 0], 10, 10), "Square", "face");
      app.setSelection([{ kind: "body", body: rq, id: 0 }]); app.run("op.revolve"); await sleep(20);
      const cam = [vp.camera.position.clone(), vp.camera.up.clone(), vp.controls.target.clone()];
      vp.camera.up.set(0, 0, 1); vp.camera.position.set(55, -120, 65); vp.controls.target.set(25, 0, 5); vp.camera.lookAt(25, 0, 5); vp.controls.update(); vp.requestRender(); await sleep(50);
      opValue("angle", 360);
      const clickAt = (p) => { ev("pointermove", p); ev("pointerdown", p); ev("pointerup", p); };
      const axisNow = () => document.querySelector("#op-panel select[data-key=axis]").selectedOptions[0].text;
      const se = app.doc.get(rq).shape.edges.find((e) => e.geomType === "LINE"), sa = se.startPoint.toTuple(), sb2 = se.endPoint.toTuple();
      clickAt([0, 1, 2].map((i) => (sa[i] + sb2[i]) / 2)); await sleep(150); const byEdge = axisNow();
      clickAt([0, 0, 25]); await sleep(150); const byZ = axisNow();
      app.applyOp();
      const ring = last(), rv = ring && K.solidVolume(ring.shape);
      expect("15b Revolve: clicking the face's edge / the Z axis line picks it as the axis → ring", /^Face edge/.test(byEdge) && byZ === "Z axis" && !app.doc.get(rq) && near(rv, Math.PI * (55 ** 2 - 45 ** 2) * 10), { byEdge, byZ, rv });
      app.run("edit.undo"); app.run("edit.undo");
      expect("15b Revolve click test cleaned up", app.doc.bodies.length === nb0, app.doc.bodies.length);
      vp.camera.position.copy(cam[0]); vp.camera.up.copy(cam[1]); vp.controls.target.copy(cam[2]); vp.camera.lookAt(cam[2]); vp.controls.update(); vp.requestRender(); await sleep(50);
    }
    // Sweep: a 10 x 10 square (on the ground, away from the path) along an L path, moved onto it: mitred corner → volume 100 × 90
    const path = add(K.sketchPath([{ kind: "line", a: [0, 4100, 0], b: [0, 4100, 50] }, { kind: "line", a: [0, 4100, 50], b: [40, 4100, 50] }]), "Path", "path");
    const sq = add(K.makeRectFace(G, [200, 4200, 0], 10, 10), "Square", "face");
    app.setSelection([{ kind: "body", body: path, id: 0 }, { kind: "body", body: sq, id: 0 }]);
    await chord("s", "w"); await sleep(150);
    const toPath = !document.querySelector("#op-panel input[data-key=toPath]"); // (away from the path: always moved, no box)
    app.applyOp();
    const sw = last(), sv = K.solidVolume(sw.shape);
    expect("15b Sweep: square moved to the path end, mitred corner → volume 9000; the face becomes the solid, the path stays",
      toPath && !app.doc.get(sq) && app.doc.get(path) && sw.kind === "solid" && near(sv, 9000) && K.isValidShape(sw.shape), { toPath, sv });
    // Tube: nothing selected, S W opens Sweep (no Scale complaint); click a flat ring (Offset → Make ring), then a Z guide → tube π(5² − 3²) × 30
    const disc = add(K.makeCircleFace(G, [300, 4200, 0], 5), "Disc", "face");
    app.setSelection([{ kind: "body", body: disc, id: 0 }]); app.run("op.offset"); opValue("d", -2);
    { const cb = document.querySelector("#op-panel input[data-key=ring]"); cb.checked = true; cb.dispatchEvent(new Event("change", { bubbles: true })); }
    await sleep(150); app.applyOp();
    const ring = last().id;
    const gz = app.doc.guides.length;
    app.doc.setGuides([...app.doc.guides, { a: [300, 4210, 0], b: [300, 4210, 30] }], "Z guide");
    const cam = vp.cameraState();
    vp.setView("top"); vp.fit([disc]); await sleep(50);
    const click = (p) => { ev("pointermove", p); ev("pointerdown", p); ev("pointerup", p); };
    app.selGuide = -1; app.setSelection([]);
    document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
    await chord("s", "w");
    const hoverAt = async (p) => { ev("pointermove", p); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return canvas.style.cursor; };
    const hovers = [await hoverAt([304, 4200, 0]), await hoverAt([300, 4210, 15]), await hoverAt([308, 4192, 0])];
    const waiting = { title: app.op && app.op.spec.title, err: opErr(), toasts: document.querySelectorAll("#toasts .toast.error").length,
      green: document.querySelector("#op-panel .op-error").classList.contains("waiting") };
    click([304, 4200, 0]); await sleep(150); // on the ring band (the disc lies under it: either is a flat face on the same plane — the ring is on top, made last)
    const afterFace = { note: document.querySelector("#op-panel .op-note").textContent, err: opErr() };
    click([300, 4210, 15]); await sleep(150);
    const afterGuide = { note: document.querySelector("#op-panel .op-note").textContent, toPath: !document.querySelector("#op-panel input[data-key=toPath]") };
    app.applyOp();
    const tube = last(), tv = K.solidVolume(tube.shape), tb = tube.shape.boundingBox.bounds.map((p) => p.map(r));
    expect("15b Sweep with nothing selected: panel waits (no Scale error), click a ring face then a guide → tube on the guide (π·16·30)",
      waiting.title === "Sweep" && /flat face/.test(waiting.err) && waiting.green && waiting.toasts === 0 && /click a path or guide/.test(afterFace.err) && /Path: guide line/.test(afterGuide.note) && afterGuide.toPath
        && near(tv, Math.PI * 16 * 30) && eq(tb, [[295, 4205, 0], [305, 4215, 30]]) && K.isValidShape(tube.shape)
        && eq(hovers, ["pointer", "pointer", "crosshair"]), { waiting, afterFace, afterGuide, tv, tb, hovers });
    // A guide selected first: the panel shows it and waits for the face
    app.setSelection([]); app.selGuide = gz;
    await chord("s", "w");
    const g1 = { note: document.querySelector("#op-panel .op-note").textContent, err: opErr() };
    click([300, 4200, 0]); await sleep(150);
    const g2 = { ok: !!(app.op && app.op.result), err: opErr() };
    key("Escape", "Escape");
    expect("15b Sweep with a guide selected: waits for a face click, then previews", /Path: guide line/.test(g1.note) && /flat face/.test(g1.err) && g2.ok, { g1, g2 });
    // Picked in the Bodies panel: nothing selected, S W, click the square's row then the path's row → the same L sweep
    const sq2 = add(K.makeRectFace(G, [500, 4200, 0], 10, 10), "Square", "face");
    app.setSelection([]); app.selGuide = -1;
    await chord("s", "w");
    const row = (id) => document.querySelector("#outliner .ol-row[data-id='" + id + "'] .ol-name").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    row(sq2); await sleep(150);
    const olFace = { note: document.querySelector("#op-panel .op-note").textContent, err: opErr() };
    row(path); await sleep(150);
    const olPath = { note: document.querySelector("#op-panel .op-note").textContent, ok: !!(app.op && app.op.result) };
    app.applyOp();
    const olSw = last(), olV = K.solidVolume(olSw.shape);
    expect("15b Sweep picked in the Bodies panel: a face object row is the profile, a path row the path → volume 9000",
      /Profile: Square/.test(olFace.note) && /click a path or guide/.test(olFace.err) && /Path: Path/.test(olPath.note) && olPath.ok && !app.doc.get(sq2) && near(olV, 9000), { olFace, olPath, olV });
    app.setSelection([{ kind: "body", body: olSw.id, id: 0 }]); app.run("edit.delete");
    // Turn profile: a 10 x 4 bar moved onto the Z guide lies along X; turned 90° it lies along Y
    const bar = add(K.makeRectFace(G, [400, 4300, 0], 10, 4), "Bar", "face");
    app.setSelection([{ kind: "body", body: bar, id: 0 }]); app.selGuide = gz;
    await chord("s", "w"); await sleep(150);
    const span = () => { const b = app.op.result.ghost.get(bar).boundingBox.bounds; return [0, 1, 2].map((k) => r(b[1][k] - b[0][k])); };
    const s0 = span(); opValue("turn", 90); await sleep(150); const s90 = span();
    key("Escape", "Escape");
    expect("15b Sweep Turn profile: 0° → 10 x 4 x 30, 90° → 4 x 10 x 30", eq(s0, [10, 4, 30]) && eq(s90, [4, 10, 30]), { s0, s90 });
    app.selGuide = -1; // (else Delete takes the guide, not the bar)
    app.setSelection([{ kind: "body", body: bar, id: 0 }]); app.run("edit.delete");
    app.doc.setGuides(app.doc.guides.slice(0, gz), "remove guide");
    app.selGuide = -1;
    vp.restoreCamera(cam); await sleep(50);
    // From a solid's face: joins the solid (no new object), or a separate solid with New solid
    app.run("tool.box"); ev("pointermove", [0, 4300, 0]); key("Tab", "Tab"); dialog([20, 20, 20]);
    const bx = last().id, n = app.doc.bodies.length, v0 = K.solidVolume(last().shape);
    const side = app.doc.get(bx).shape.faces.find((f) => f.normalAt(f.center).toTuple()[0] > 0.99);
    app.run("mode.face"); app.setSelection([{ kind: "face", body: bx, id: side.hashCode }]); app.run("op.revolve"); await sleep(20);
    const edges = [...document.querySelector("#op-panel select[data-key=axis]").options].map((o) => o.text).filter((t) => t.startsWith("Face edge")).length;
    for (let i = 1; i <= edges; i++) { pick("axis", "Face edge " + i); await sleep(150); if (!opErr()) break; }
    for (const a of [90, -90]) { opValue("angle", a); await sleep(150); const g = app.op.result && app.op.result.ghost.get(bx); if (g && K.solidVolume(g) > v0 + 1) break; } // (the turn away from the box)
    app.applyOp();
    const jv = K.solidVolume(app.doc.get(bx).shape);
    expect("15b Revolve a solid's face 90° about its edge: joined into the solid (quarter cylinder r 20 · 20 added)",
      app.doc.bodies.length === n && near(jv, v0 + Math.PI * 400 * 20 / 4) && K.isValidShape(app.doc.get(bx).shape), { edges, v0, jv });
    // S W / R E with a solid selected: Scale / Rotate closes; Sweep waits for a face click, Revolve says what to select
    app.run("mode.body");
    const refused = [];
    for (const [k1, k2] of [["s", "w"], ["r", "e"]]) {
      app.setSelection([{ kind: "body", body: bx, id: 0 }]);
      document.querySelectorAll("#toasts .toast").forEach((t) => t.remove());
      await chord(k1, k2);
      refused.push({ op: app.op && app.op.spec.title, xf: !!app.xf, err: [...document.querySelectorAll("#toasts .toast.error")].map((t) => t.textContent).join(" | ") });
      key("Escape", "Escape");
    }
    expect("15b S W / R E on a solid: no Scale panel or Rotate gizmo left; Sweep panel waiting, Revolve error",
      refused[0].op === "Sweep" && !refused[0].err && !refused[1].op && !refused[1].xf && /^Revolve: select one flat face/.test(refused[1].err), refused);
    // Not in Pro: S W is just Scale (W does nothing)
    document.body.classList.remove("pro");
    app.run("mode.body"); app.setSelection([{ kind: "body", body: path, id: 0 }]); await chord("s", "w");
    const plain = app.op && app.op.spec.title; key("Escape", "Escape");
    expect("15b without Pro, S W stays Scale", /^Scale/.test(plain || ""), plain);
    if (wasPro) document.body.classList.add("pro");
    for (const id of [bx, tube.id, disc, sw.id, path, quarter, donut && donut.id].filter(Boolean)) { app.setSelection([{ kind: "body", body: id, id: 0 }]); app.run("edit.delete"); }
  } catch (e) {
    expect("15b revolve / sweep threw", false, String(e && e.stack || e));
  }

  // 15c) Shell a cylinder cut in half (OpenCascade's own shell gave it back unchanged): hollowed, exact walls
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const half = K.booleanOp("subtract", K.makeCylinder(G, [0, 4500, 0], 20, 50), [K.makeBox(G, [50, 4500, 0], 100, 100, 200)]);
    const hb = app.doc.makeBody(half, "Half"); app.doc.commit([...app.doc.bodies, hb], "half cylinder");
    const top = app.doc.get(hb.id).shape.faces.find((f) => f.geomType === "PLANE" && f.center.z > 49);
    app.run("mode.face"); app.setSelection([{ kind: "face", body: hb.id, id: top.hashCode }]);
    app.run("op.shell"); opValue("t", 2); await sleep(150); app.applyOp();
    const sh = app.doc.get(hb.id).shape, v = K.solidVolume(sh);
    // outer half cylinder − inside (r 18, flat side 2 in, floor 2 thick): 18² acos(2/18) − 2·√(18² − 2²), × 48
    const want = Math.PI * 400 * 50 / 2 - (324 * Math.acos(2 / 18) - 2 * Math.sqrt(320)) * 48;
    expect("15c Shell a half cylinder (top open, 2 mm): hollowed, volume exact", Math.abs(v - want) < 1 && K.isValidShape(sh), { v, want });
    app.run("mode.body"); app.setSelection([{ kind: "body", body: hb.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("15c half cylinder shell threw", false, String(e && e.stack || e));
  }

  // 16) Push/pull of adjacent faces meets cleanly at the shared corner (no post / notch / missing block)
  try {
    const mkBox = (at, dims) => { app.run("mode.body"); app.setSelection([]); app.run("tool.box"); ev("pointermove", at); key("Tab", "Tab"); dialog(dims); return last().id; };
    const faceBy = (id, test) => app.doc.get(id).shape.faces.filter((f) => test(f.normalAt(f.center).toTuple(), f.center.toTuple())).map((f) => ({ kind: "face", body: id, id: f.hashCode }));
    const pp = (id, sel, d) => { app.setSelection(sel); app.run("op.pushpull"); opValue("d", d); app.applyOp(); return app.doc.get(id).shape; };
    // Open box 50 x 50 x 20, shell 6, push two adjacent inner walls 3 outward
    const tray = mkBox([0, -300, 0], [50, 50, 20]);
    app.setSelection(faceBy(tray, (n, c) => n[2] > 0.99)); app.run("op.shell"); opValue("t", 6); app.applyOp();
    const b0 = app.doc.get(tray).shape.boundingBox.bounds;
    const inner = faceBy(tray, (n, c) => (n[0] > 0.99 && Math.abs(c[0] - (b0[0][0] + 6)) < 1e-3) || (n[1] > 0.99 && Math.abs(c[1] - (b0[0][1] + 6)) < 1e-3));
    let sh = pp(tray, inner, -3);
    expect("16 inner walls pushed: clean corner", inner.length === 2 && window.ydddKernel.isValidShape(sh) && sh.faces.length === 11 && eq(size(tray), [50, 50, 20]), [inner.length, sh.faces.length, size(tray)]);
    // Two adjacent outside walls pulled 5 → no notch
    sh = pp(tray, faceBy(tray, (n, c) => n[0] < -0.99 && Math.abs(c[0] - b0[0][0]) < 1e-3 || n[1] < -0.99 && Math.abs(c[1] - b0[0][1]) < 1e-3), 5);
    expect("16 outer walls pulled: no notch", window.ydddKernel.isValidShape(sh) && sh.faces.length === 11 && eq(size(tray), [55, 55, 20]), [sh.faces.length, size(tray)]);
    // Top + two sides of a plain box pulled 5 → corner block filled too
    const blk = mkBox([200, -300, 0], [40, 40, 30]);
    sh = pp(blk, faceBy(blk, (n) => n[2] > 0.99 || n[0] > 0.99 || n[1] > 0.99), 5);
    expect("16 three faces pulled: plain box", window.ydddKernel.isValidShape(sh) && sh.faces.length === 6 && eq(size(blk), [45, 45, 35]), [sh.faces.length, size(blk)]);
    app.run("mode.body");
  } catch (e) {
    expect("16 corner push/pull threw", false, String(e && e.stack || e));
  }

  // 17b) Fillet / Chamfer drag: the handle starts on the picked top edge and runs across the top face;
  //      dragging it changes the value and the preview, Apply uses the dragged value
  try {
    for (const cmd of ["op.fillet", "op.chamfer"]) {
      app.run("mode.body"); app.setSelection([]);
      app.run("tool.box"); ev("pointermove", [100, -300, 0]); key("Tab", "Tab"); dialog([40, 40, 30]);
      const fb = last().id, b = app.doc.get(fb).shape.boundingBox.bounds;
      const te = app.doc.get(fb).shape.edges.find((e) => { const p = e.startPoint.toTuple(), q = e.endPoint.toTuple(); return Math.abs(p[2] - b[1][2]) < 1e-6 && Math.abs(q[2] - b[1][2]) < 1e-6 && Math.abs(p[1] - b[1][1]) < 1e-6 && Math.abs(q[1] - b[1][1]) < 1e-6; });
      app.setSelection([{ kind: "edge", body: fb, id: te.hashCode }]); app.run(cmd); opValue("r", 1);
      await sleep(50);
      const drag = app.op && app.op.spec.drag, h = document.querySelector("#op-handles .op-handle");
      const axisOk = drag && eq(drag.origin.map(r), [(b[0][0] + b[1][0]) / 2, b[1][1], b[1][2]].map(r)) && eq(drag.dir.map(r), [0, -1, 0]) && h && !h.hidden;
      const o = S(drag.origin), o2 = S([drag.origin[0], drag.origin[1] - 10, drag.origin[2]]);
      const L = Math.hypot(o2.x - o.x, o2.y - o.y), dx = (o2.x - o.x) / L, dy = (o2.y - o.y) / L, pxPerMm = L / 10;
      app.opDrag(new PointerEvent("pointermove", { clientX: o.x, clientY: o.y }));
      app.opDrag(new PointerEvent("pointermove", { clientX: o.x + dx * pxPerMm * 5, clientY: o.y + dy * pxPerMm * 5 }));
      await sleep(400);
      const v = Number(document.querySelector("#op-panel input[data-key=r]").value);
      const ghost = vp.ghostRoot.children.length > 0;
      app.opDrag(new PointerEvent("pointermove", { clientX: o.x - dx * pxPerMm * 50, clientY: o.y - dy * pxPerMm * 50 }));
      const vMin = Number(document.querySelector("#op-panel input[data-key=r]").value);
      app.opDrag(new PointerEvent("pointermove", { clientX: o.x + dx * pxPerMm * 5, clientY: o.y + dy * pxPerMm * 5 }));
      await sleep(400);
      app.applyOp();
      const top = app.doc.get(fb).shape.faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[2] > 0.99);
      const tb = top && top.boundingBox.bounds, topY = tb ? r(tb[1][1] - tb[0][1]) : null;
      expect("17b " + cmd + " drag: handle on the edge across the top, value + preview follow, min 0.1, applied", axisOk && Math.abs(v - 6) < 0.6 && ghost && vMin === 0.1 && Math.abs(topY - (40 - v)) < 1e-3,
        { origin: drag && drag.origin.map(r), dir: drag && drag.dir.map(r), shown: !!h && !h.hidden, v, ghost, vMin, topY });
      app.setSelection([{ kind: "body", body: fb, id: 0 }]); app.run("edit.delete");
    }
  } catch (e) {
    expect("17b fillet drag threw", false, String(e && e.stack || e));
  }

  // 17) Fillet a vertical edge, then push/pull the two walls + the fillet: the corner stays a concentric fillet
  try {
    for (const [d, want, rr] of [[5, [45, 45, 30], 13], [-3, [37, 37, 30], 5]]) {
      app.run("mode.body"); app.setSelection([]);
      const before = app.doc.bodies.length;
      app.run("tool.box"); ev("pointermove", [100, -300, 0]); key("Tab", "Tab"); dialog([40, 40, 30]);
      if (app.doc.bodies.length !== before + 1) throw new Error("17: box not created");
      const fb = last().id;
      const b = app.doc.get(fb).shape.boundingBox.bounds;
      const ve = app.doc.get(fb).shape.edges.find((e) => { const p = e.startPoint.toTuple(), q = e.endPoint.toTuple(); return Math.abs(p[0] - b[1][0]) < 1e-6 && Math.abs(q[0] - b[1][0]) < 1e-6 && Math.abs(p[1] - b[1][1]) < 1e-6 && Math.abs(q[1] - b[1][1]) < 1e-6; });
      app.setSelection([{ kind: "edge", body: fb, id: ve.hashCode }]); app.run("op.fillet"); opValue("r", 8); app.applyOp();
      const sel = app.doc.get(fb).shape.faces.filter((f) => { const n = f.normalAt().toTuple(); return f.geomType === "CYLINDRE" || n[0] > 0.99 || n[1] > 0.99; });
      app.setSelection(sel.map((f) => ({ kind: "face", body: fb, id: f.hashCode }))); app.run("op.pushpull"); opValue("d", d); app.applyOp();
      const sh = app.doc.get(fb).shape, cyl = sh.faces.filter((f) => f.geomType === "CYLINDRE");
      const arc = cyl[0] && cyl[0].edges.find((e) => e.geomType === "CIRCLE");
      const rad = arc ? +(Math.hypot(...[0, 1].map((k) => arc.startPoint.toTuple()[k] - arc.endPoint.toTuple()[k])) / Math.SQRT2).toFixed(3) : null;
      expect("17 fillet + walls push/pull " + d, sel.length === 3 && window.ydddKernel.isValidShape(sh) && sh.faces.length === 7 && cyl.length === 1 && eq(size(fb), want) && rad === rr, [sel.length, sh.faces.length, cyl.length, size(fb), rad]);
      app.setSelection([{ kind: "body", body: fb, id: 0 }]); app.run("edit.delete");
    }
    app.run("mode.body");
  } catch (e) {
    expect("17 fillet push/pull threw", false, String(e && e.stack || e));
  }

  // 18) Sphere centre is a snap point, seen through the sphere's own surface (e.g. to start a guide line there)
  try {
    app.run("mode.body"); app.setSelection([]);
    const before = app.doc.bodies.length;
    app.run("tool.sphere"); toolClicks([[100, -300, 0], [112, -300, 0]]);
    if (app.doc.bodies.length !== before + 1) throw new Error("18: sphere not created");
    const sid = last().id;
    const [a, b] = app.doc.get(sid).shape.boundingBox.bounds;
    const c = [0, 1, 2].map((k) => (a[k] + b[k]) / 2);
    await sleep(50);
    const o = vp.toScreen(new V(...c)); const sp = vp.snapPoint(o.x + 3, o.y + 2); // (inside the sphere on purpose: not __see)
    expect("18 sphere centre snap", sp && sp.kind === "center" && sp.point.distanceTo(new V(...c)) < 1e-6, sp && [sp.kind, sp.point.toArray().map(r), c.map(r)]);
    app.setSelection([{ kind: "body", body: sid, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("18 sphere centre snap threw", false, String(e && e.stack || e));
  }

  // 19) Front view, horizontal guide across a sphere (not on a flat face) → the cut is horizontal, as seen
  try {
    app.run("mode.body"); app.setSelection([]);
    const before = app.doc.bodies.length;
    app.run("tool.sphere"); toolClicks([[100, -300, 0], [112, -300, 0]]);
    if (app.doc.bodies.length !== before + 1) throw new Error("19: sphere not created");
    const sid = last().id;
    const [a, b] = app.doc.get(sid).shape.boundingBox.bounds;
    const zc = (a[2] + b[2]) / 2 + 5;
    app.run("view.front"); await sleep(50);
    app.doc.setGuides([...app.doc.guides, { a: [a[0] - 5, (a[1] + b[1]) / 2, zc], b: [b[0] + 5, (a[1] + b[1]) / 2, zc] }], "Add guide");
    app.opCut([sid], app.doc.guides.length - 1);
    const top = last();
    const tb = top.shape.boundingBox.bounds, kb = app.doc.get(sid).shape.boundingBox.bounds;
    expect("19 sphere cut level in front view", top.id !== sid && Math.abs(tb[0][2] - zc) < 1e-6 && Math.abs(kb[1][2] - zc) < 1e-6 && r(tb[1][0] - tb[0][0]) < 24, [tb[0].map(r), kb[1].map(r), zc]);
    app.doc.setGuides(app.doc.guides.slice(0, -1), "Remove guide");
    app.setSelection([{ kind: "body", body: sid, id: 0 }, { kind: "body", body: top.id, id: 0 }]); app.run("edit.delete");
    vp.setView("iso");
  } catch (e) {
    expect("19 sphere cut threw", false, String(e && e.stack || e));
  }

  // 20) Diagonal guides ON a box face cut straight across that face, whatever the view
  try {
    for (const view of ["iso", "top", "front"]) {
      for (const which of ["top", "front"]) {
        app.run("mode.body"); app.setSelection([]); vp.setView("iso"); await sleep(30);
        const before = app.doc.bodies.length;
        app.run("tool.box"); ev("pointermove", [100, -300, 0]); key("Tab", "Tab"); dialog([40, 30, 20]);
        if (app.doc.bodies.length !== before + 1) throw new Error("20: box not created");
        const bid = last().id;
        const [lo, hi] = app.doc.get(bid).shape.boundingBox.bounds;
        // top: corner to opposite corner of the top face; front: bottom-left to top-right of the front (−y) face
        const g = which === "top" ? { a: [lo[0], lo[1], hi[2]], b: [hi[0], hi[1], hi[2]] } : { a: [lo[0], lo[1], lo[2]], b: [hi[0], lo[1], hi[2]] };
        vp.setView(view); await sleep(30);
        app.doc.setGuides([...app.doc.guides, g], "Add guide");
        app.opCut([bid], app.doc.guides.length - 1); await sleep(30); // (the cut commits after an await)
        const piece = last(), pb = piece.shape.boundingBox.bounds, kb = app.doc.get(bid).shape.boundingBox.bounds;
        const span = (bb) => [0, 1, 2].map((k) => r(bb[1][k] - bb[0][k]));
        // Straight across the face: top diagonal → both pieces full height (20); front diagonal → both full depth (30)
        const k = which === "top" ? 2 : 1, full = which === "top" ? 20 : 30;
        expect("20 box " + which + "-face diagonal, " + view + " view", piece.id !== bid && span(pb)[k] === full && span(kb)[k] === full && piece.shape.faces.length === 5 && app.doc.get(bid).shape.faces.length === 5, [span(pb), span(kb), piece.shape.faces.length]);
        app.doc.setGuides(app.doc.guides.slice(0, -1), "Remove guide");
        app.setSelection([{ kind: "body", body: bid, id: 0 }, { kind: "body", body: piece.id, id: 0 }]); app.run("edit.delete");
      }
    }
    vp.setView("iso");
  } catch (e) {
    expect("20 box diagonal cut threw", false, String(e && e.stack || e));
  }

  // 21) Front view: a 2-point guide from the sphere centre locks onto X / Z, keeps its cut direction,
  //     and cuts level even after orbiting to iso
  try {
    app.run("mode.body"); app.setSelection([]); vp.setView("iso"); await sleep(30);
    const before = app.doc.bodies.length;
    app.run("tool.sphere"); toolClicks([[100, -300, 0], [112, -300, 0]]);
    if (app.doc.bodies.length !== before + 1) throw new Error("21: sphere not created");
    const sid = last().id;
    const [a, b] = app.doc.get(sid).shape.boundingBox.bounds;
    const c = [0, 1, 2].map((k) => (a[k] + b[k]) / 2);
    app.setSelection([{ kind: "body", body: sid, id: 0 }]); app.run("view.front");
    // (straight from the front — what this check is about — also when an orbit run turns every view)
    const camDist = vp.camera.position.distanceTo(vp.controls.target);
    vp.camera.position.copy(vp.controls.target).add(new V(0, -camDist, 0)); vp.controls.update();
    app.run("view.fitSelection"); app.setSelection([]); await sleep(50);
    const at = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    const guideFromCentre = (dx, dy) => {
      const o = vp.toScreen(new V(...c)); // (the centre, inside the sphere on purpose: not __see)
      app.run("tool.guide");
      at("pointermove", o.x + 2, o.y + 1); at("pointerdown", o.x + 2, o.y + 1);
      at("pointermove", o.x + dx, o.y + dy); at("pointerdown", o.x + dx, o.y + dy);
      return app.doc.guides[app.doc.guides.length - 1];
    };
    const n0 = app.doc.guides.length;
    const gx = guideFromCentre(90, -2);  // ~1.3° above horizontal → locks onto X
    const gz = guideFromCentre(2, -90);  // ~1.3° off vertical → locks onto Z
    const same = (p, q) => p.every((v, k) => Math.abs(v - q[k]) < 1e-9);
    expect("21 guides added", app.doc.guides.length === n0 + 2, app.doc.guides.length - n0);
    expect("21 X lock: level, from the centre, cut normal up", same(gx.a, c) && gx.b[1] === gx.a[1] && gx.b[2] === gx.a[2] && gx.b[0] > gx.a[0] && same(gx.n, [0, 0, 1]), [gx.a.map(r), gx.b.map(r), gx.n]);
    expect("21 Z lock: upright, cut normal along X", same(gz.a, c) && gz.b[0] === gz.a[0] && gz.b[1] === gz.a[1] && gz.b[2] > gz.a[2] && same(gz.n.map(Math.abs), [1, 0, 0]), [gz.a.map(r), gz.b.map(r), gz.n]);
    vp.setView("iso"); await sleep(30);
    app.opCut([sid], app.doc.guides.indexOf(gx));
    const top = last(), tb = top.shape.boundingBox.bounds, kb = app.doc.get(sid).shape.boundingBox.bounds;
    expect("21 cut level from iso (stored direction)", top.id !== sid && Math.abs(tb[0][2] - c[2]) < 1e-6 && Math.abs(kb[1][2] - c[2]) < 1e-6, [tb[0].map(r), kb[1].map(r)]);
    app.doc.setGuides(app.doc.guides.slice(0, n0), "Remove guides");
    app.setSelection([{ kind: "body", body: sid, id: 0 }, { kind: "body", body: top.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("21 axis-locked guide threw", false, String(e && e.stack || e));
  }

  // 22) Per-axis scale of curved solids: a sphere halved through its centre (the cut lies on the
  //     sphere's seam), both halves stretched X 150 % / Z 70 % → valid, exact size, exact ellipsoid
  try {
    app.run("mode.body"); app.setSelection([]); vp.setView("iso"); await sleep(30);
    const before = app.doc.bodies.length;
    app.run("tool.sphere"); toolClicks([[100, -300, 0], [112, -300, 0]]);
    if (app.doc.bodies.length !== before + 1) throw new Error("22: sphere not created");
    const sid = last().id;
    const [a, b] = app.doc.get(sid).shape.boundingBox.bounds;
    const c = [0, 1, 2].map((k) => (a[k] + b[k]) / 2), R = (b[0] - a[0]) / 2;
    const n0 = app.doc.guides.length;
    app.doc.setGuides([...app.doc.guides, { a: [c[0], c[1] - 20, c[2]], b: [c[0], c[1] + 20, c[2]], n: [1, 0, 0] }], "Add guide");
    app.opCut([sid], n0);
    const halves = [sid, last().id];
    app.doc.setGuides(app.doc.guides.slice(0, n0), "Remove guide");
    app.setSelection(halves.map((id) => ({ kind: "body", body: id, id: 0 })));
    app.run("xf.scale"); opValue("x", 150); opValue("z", 70);
    app.previewOp();
    const previewMs = app.op.previewMs;
    expect("22 scale preview is instant (transformed meshes)", previewMs < 30, previewMs);
    app.applyOp();
    const shapes = halves.map((id) => app.doc.get(id).shape);
    const lo = [0, 1, 2].map((k) => Math.min(...shapes.map((sh) => sh.boundingBox.bounds[0][k])));
    const hi = [0, 1, 2].map((k) => Math.max(...shapes.map((sh) => sh.boundingBox.bounds[1][k])));
    // Pivot = bottom centre of the pair: the centre moves to (cx, cy, zmin + R * 0.7)
    const C = [c[0], c[1], a[2] + R * 0.7], f = [1.5, 1, 0.7];
    let worst = 0;
    for (const sh of shapes) for (const fc of sh.faces) {
      if (fc.geomType === "PLANE") continue;
      for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) { const q = fc.pointOnSurface(i / 6, j / 6).toTuple(); worst = Math.max(worst, Math.abs(Math.hypot(...[0, 1, 2].map((k) => (q[k] - C[k]) / f[k])) - R)); }
    }
    expect("22 stretched sphere halves: valid, exact size, on the ellipsoid",
      shapes.every((sh) => window.ydddKernel.isValidShape(sh)) && eq([0, 1, 2].map((k) => r(hi[k] - lo[k])), [r(3 * R), r(2 * R), r(1.4 * R)]) && worst < 1e-9,
      [shapes.map((sh) => window.ydddKernel.isValidShape(sh)), [0, 1, 2].map((k) => r(hi[k] - lo[k])), worst]);
    app.setSelection(halves.map((id) => ({ kind: "body", body: id, id: 0 }))); app.run("edit.delete");
  } catch (e) {
    expect("22 curved per-axis scale threw", false, String(e && e.stack || e));
  }

  // 23) Cut a box, Shift+D one part, move the copy, undo → clicking the source twice still drills down to a face
  try {
    app.run("mode.body"); app.setSelection([]); vp.setView("iso"); await sleep(30);
    const before = app.doc.bodies.length;
    app.run("tool.box"); ev("pointermove", [100, -300, 0]); key("Tab", "Tab"); dialog([40, 30, 20]);
    if (app.doc.bodies.length !== before + 1) throw new Error("23: box not created");
    const bid = last().id;
    const [lo, hi] = app.doc.get(bid).shape.boundingBox.bounds;
    const cx = (lo[0] + hi[0]) / 2;
    app.setSelection([{ kind: "body", body: bid, id: 0 }]); app.run("view.top"); app.run("view.fitSelection"); await sleep(50);
    const n0 = app.doc.guides.length;
    app.doc.setGuides([...app.doc.guides, { a: [cx, lo[1], hi[2]], b: [cx, hi[1], hi[2]], n: [1, 0, 0] }], "Add guide");
    app.opCut([bid], n0);
    const other = last().id;
    app.doc.setGuides(app.doc.guides.slice(0, n0), "Remove guide");
    // Shift+D on one part, move the copy 60 along X with Tab, then undo
    app.setSelection([{ kind: "body", body: bid, id: 0 }]);
    key("D", "KeyD", { shiftKey: true });
    const copy = last().id;
    key("Tab", "Tab"); dialog([60, 0, 0]);
    const moved = app.doc.get(copy) && app.doc.get(copy).shape.boundingBox.bounds[0][0];
    app.run("edit.undo"); // Ctrl+Z goes through the app menu
    await sleep(50);
    const state = () => ({ mode: app.mode, sel: app.selection.map((s) => s.kind + ":" + s.body), xf: !!app.xf, gizmo: vp.gizmoHot, transforming: vp.transforming });
    const afterUndo = { copyGone: !app.doc.get(copy), copyAt: app.doc.get(copy) && app.doc.get(copy).shape.boundingBox.bounds[0].map(r), srcAt: app.doc.get(bid).shape.boundingBox.bounds[0].map(r), undoLabel: document.querySelector(".toast:last-child")?.textContent, ...state() };
    // Click the source part twice (centre of its top face)
    const [sl, sh] = app.doc.get(bid).shape.boundingBox.bounds;
    const p = S([(sl[0] + sh[0]) / 2, (sl[1] + sh[1]) / 2, sh[2]]);
    const click = () => { for (const t of ["pointerdown", "pointerup"]) canvas.dispatchEvent(new PointerEvent(t, { clientX: p.x, clientY: p.y, button: 0, bubbles: true })); };
    const facePick = vp.pick(p.x, p.y, "face");
    click(); const first = state();
    click(); const second = state();
    expect("23 undo after Shift+D + move removes the copy (one step)", afterUndo.copyGone && afterUndo.undoLabel === "Undo: Duplicate" && moved > 150, afterUndo);
    expect("23 then clicking the source twice drills down to a face", app.mode === "face" && app.selection.length === 1 && app.selection[0].kind === "face" && app.selection[0].body === bid,
      { facePick: facePick && facePick.body + ":" + facePick.kind, first, second, bid, other, copy });
    // A copy left in place (Shift+D, Esc) overlapping the source: drill-down still works on whichever is selected
    app.run("mode.body"); app.setSelection([{ kind: "body", body: bid, id: 0 }]);
    key("D", "KeyD", { shiftKey: true }); key("Escape", "Escape");
    const twin = last().id;
    app.setSelection([{ kind: "body", body: twin, id: 0 }]);
    click();
    expect("23 overlapping copy: second click drills into the selected one", app.mode === "face" && app.selection.length === 1 && app.selection[0].body === twin, { sel: app.selection, twin });
    app.run("mode.body"); app.setSelection([{ kind: "body", body: twin, id: 0 }]); app.run("edit.delete");
    app.run("mode.body"); app.setSelection([bid, other].map((id) => ({ kind: "body", body: id, id: 0 }))); app.run("edit.delete");
  } catch (e) {
    expect("23 duplicate/undo threw", false, String(e && e.stack || e));
  }

  // 24) Per-axis-scaled filleted box: push/pull of the (now B-spline) fillet previews fast,
  //     leaves the document solid untouched, and applies a valid result
  try {
    app.run("mode.body"); app.setSelection([]); vp.setView("iso"); await sleep(30);
    const before = app.doc.bodies.length;
    app.run("tool.box"); ev("pointermove", [100, -300, 0]); key("Tab", "Tab"); dialog([40, 30, 20]);
    if (app.doc.bodies.length !== before + 1) throw new Error("24: box not created");
    const bid = last().id;
    const [lo, hi] = app.doc.get(bid).shape.boundingBox.bounds;
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const ve = app.doc.get(bid).shape.edges.find((e) => { const p = e.startPoint.toTuple(), q = e.endPoint.toTuple(); return near(p[0], hi[0]) && near(q[0], hi[0]) && near(p[1], hi[1]) && near(q[1], hi[1]); });
    app.run("mode.edge"); app.setSelection([{ kind: "edge", body: bid, id: ve.hashCode }]); app.run("op.fillet"); opValue("r", 6); app.applyOp();
    app.run("mode.body"); app.setSelection([{ kind: "body", body: bid, id: 0 }]); app.run("xf.scale"); opValue("x", 150); app.applyOp();
    const src = app.doc.get(bid).shape;
    const fillet = src.faces.find((f) => f.geomType === "BSPLINE_SURFACE");
    app.run("mode.face"); app.setSelection([{ kind: "face", body: bid, id: fillet.hashCode }]);
    app.run("op.pushpull");
    let slowest = 0;
    for (const v of [2, -2, 4]) { opValue("d", v); app.op.key = ""; app.previewOp(); slowest = Math.max(slowest, app.op.previewMs); }
    const srcValid = window.ydddKernel.isValidShape(src);
    opValue("d", 3); app.applyOp();
    const out = app.doc.get(bid).shape;
    expect("24 stretched fillet push/pull: fast preview, source intact, valid result", fillet && slowest < 150 && srcValid && window.ydddKernel.isValidShape(out) && out !== src,
      { slowestPreviewMs: Math.round(slowest), srcValid, outValid: window.ydddKernel.isValidShape(out) });
    app.run("mode.body"); app.setSelection([{ kind: "body", body: bid, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("24 stretched fillet push/pull threw", false, String(e && e.stack || e));
  }

  // 25) Fillet a whole solid with Edges = Vertical / Horizontal (e.g. the corners of an open tray)
  try {
    const choose = (k, i) => { const el = document.querySelector("#op-panel select[data-key=" + k + "]"); el.value = String(i); el.dispatchEvent(new Event("change", { bubbles: true })); return !!el; };
    const cyl = (id) => app.doc.get(id).shape.faces.filter((f) => f.geomType === "CYLINDRE").length;
    const mk = (dims) => { app.run("mode.body"); app.setSelection([]); const n = app.doc.bodies.length; app.run("tool.box"); ev("pointermove", [100, -300, 0]); key("Tab", "Tab"); dialog(dims); if (app.doc.bodies.length !== n + 1) throw new Error("25: box not created"); return last().id; };
    // Open tray: 60 x 40 x 30, shelled 5 from the top
    const tray = mk([60, 40, 30]);
    const top = app.doc.get(tray).shape.faces.find((f) => f.normalAt().toTuple()[2] > 0.99);
    app.run("mode.face"); app.setSelection([{ kind: "face", body: tray, id: top.hashCode }]); app.run("op.shell"); opValue("t", 5); app.applyOp();
    const facesBefore = app.doc.get(tray).shape.faces.length;
    app.run("mode.body"); app.setSelection([{ kind: "body", body: tray, id: 0 }]);
    app.run("op.fillet"); const hasList = choose("which", 1); opValue("r", 3); app.applyOp();
    const sh = app.doc.get(tray).shape;
    expect("25 tray: Edges = Vertical rounds exactly the 8 corners (4 outside, 4 inside)", hasList && window.ydddKernel.isValidShape(sh) && cyl(tray) === 8 && sh.faces.length === facesBefore + 8, [hasList, cyl(tray), facesBefore, sh.faces.length]);
    // Plain box: Horizontal rounds the 8 top / bottom edges, not the 4 vertical ones
    const bx = mk([30, 20, 10]);
    app.setSelection([{ kind: "body", body: bx, id: 0 }]);
    app.run("op.fillet"); choose("which", 2); opValue("r", 2); app.applyOp();
    expect("25 box: Edges = Horizontal rounds the 8 top / bottom edges", window.ydddKernel.isValidShape(app.doc.get(bx).shape) && cyl(bx) === 8, cyl(bx));
    app.setSelection([tray, bx].map((id) => ({ kind: "body", body: id, id: 0 }))); app.run("edit.delete");
    // The choice is remembered: put it back to All for later checks
    app.setSelection([]);
  } catch (e) {
    expect("25 fillet edge choice threw", false, String(e && e.stack || e));
  }

  // 26) Stretched tray with rounded corners: dragging a wall's push/pull handle is instant
  //     (deformed mesh), the real preview follows on pause, Apply is exact
  try {
    const choose = (k, i) => { const el = document.querySelector("#op-panel select[data-key=" + k + "]"); el.value = String(i); el.dispatchEvent(new Event("change", { bubbles: true })); };
    app.run("mode.body"); app.setSelection([]); vp.setView("iso"); await sleep(30);
    const n0 = app.doc.bodies.length;
    app.run("tool.box"); ev("pointermove", [100, -300, 0]); key("Tab", "Tab"); dialog([60, 40, 30]);
    if (app.doc.bodies.length !== n0 + 1) throw new Error("26: box not created");
    const tid = last().id;
    app.setSelection([{ kind: "body", body: tid, id: 0 }]); app.run("op.fillet"); choose("which", 1); opValue("r", 6); app.applyOp();
    choose && (app.defaults.edgesWhich = 0);
    const top = app.doc.get(tid).shape.faces.find((f) => f.normalAt().toTuple()[2] > 0.99 && f.geomType === "PLANE");
    app.run("mode.face"); app.setSelection([{ kind: "face", body: tid, id: top.hashCode }]); app.run("op.shell"); opValue("t", 4); app.applyOp();
    app.run("mode.body"); app.setSelection([{ kind: "body", body: tid, id: 0 }]); app.run("xf.scale"); opValue("x", 150); app.applyOp();
    const [lo, hi] = app.doc.get(tid).shape.boundingBox.bounds;
    const wall = app.doc.get(tid).shape.faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[1] < -0.99 && Math.abs(f.center.toTuple()[1] - lo[1]) < 1e-6);
    app.setSelection([{ kind: "body", body: tid, id: 0 }]); app.run("view.fitSelection"); vp.setView("iso"); await sleep(50);
    app.run("mode.face"); app.setSelection([{ kind: "face", body: tid, id: wall.hashCode }]); app.run("op.pushpull");
    const firstMs = app.op.previewMs;
    const h = document.querySelector("#op-handles .op-handle");
    const hr = h.getBoundingClientRect(), hx = hr.left + hr.width / 2, hy = hr.top + hr.height / 2;
    const pe = (t, x, y) => h.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, button: 0, bubbles: true, pointerId: 1 }));
    // Screen direction of the wall's outward normal (-Y)
    const s0 = S(wall.center.toTuple()), s1 = S([wall.center.toTuple()[0], wall.center.toTuple()[1] - 10, wall.center.toTuple()[2]]);
    const dx = (s1.x - s0.x) / Math.hypot(s1.x - s0.x, s1.y - s0.y), dy = (s1.y - s0.y) / Math.hypot(s1.x - s0.x, s1.y - s0.y);
    pe("pointerdown", hx, hy);
    let slowest = 0, deformed = 0, prevGhost = vp.ghostRoot.children[0];
    for (let i = 1; i <= 6; i++) {
      const t0 = performance.now();
      // (synthetic events can't take pointer capture, so feed the handle's drag handler directly)
      app.opDrag(new PointerEvent("pointermove", { clientX: hx + dx * i * 30, clientY: hy + dy * i * 30 }));
      slowest = Math.max(slowest, performance.now() - t0);
      const g = vp.ghostRoot.children[0];
      if (g && g !== prevGhost) deformed++;
      prevGhost = g;
    }
    const dragged = Number(document.querySelector("#op-panel input[data-key=d]").value);
    // The deformed ghost: grown by the dragged distance towards -Y only
    const box = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
    const pos = prevGhost.children[0].geometry.attributes.position.array;
    for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { box.min[k] = Math.min(box.min[k], pos[i + k]); box.max[k] = Math.max(box.max[k], pos[i + k]); }
    const ghostGrow = [0, 1, 2].map((k) => +((box.max[k] - box.min[k]) - (hi[k] - lo[k])).toFixed(3));
    pe("pointerup", hx + dx * 180, hy + dy * 180);
    await sleep(400); // the real preview after the pause
    const realShown = app.op && app.op.key !== "" && !!app.op.result;
    app.applyOp();
    const sh = app.doc.get(tid).shape, b2 = sh.boundingBox.bounds;
    expect("26 stretched tray: wall drag is instant, real preview on pause, exact Apply",
      firstMs > 60 && slowest < 40 && deformed >= 5 && Math.abs(ghostGrow[1] - dragged) < 0.01 && Math.abs(ghostGrow[0]) < 0.01 && Math.abs(ghostGrow[2]) < 0.01 && realShown && dragged >= 5 && window.ydddKernel.isValidShape(sh) && Math.abs((b2[1][1] - b2[0][1]) - (hi[1] - lo[1] + dragged)) < 1e-6,
      { firstPreviewMs: Math.round(firstMs), slowestDragStepMs: Math.round(slowest), deformed, ghostGrow, realShown, dragged, valid: window.ydddKernel.isValidShape(sh), dy: +(b2[1][1] - b2[0][1] - (hi[1] - lo[1])).toFixed(4) });
    app.run("mode.body"); app.setSelection([{ kind: "body", body: tid, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("26 stretched drag threw", false, String(e && e.stack || e));
  }

  // 27) Per-axis scale of a circle face (one closed edge) → exact ellipse face, then push/pull it into a solid
  try {
    app.run("mode.body"); app.setSelection([]); vp.setView("iso"); await sleep(30);
    const n0 = app.doc.bodies.length;
    app.run("tool.circle"); toolClicks([[100, -300, 0], [110, -300, 0]]);
    if (app.doc.bodies.length !== n0 + 1) throw new Error("27: circle not created");
    const cid = last().id;
    const [a, b] = app.doc.get(cid).shape.boundingBox.bounds;
    const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], R = (b[0] - a[0]) / 2;
    app.setSelection([{ kind: "body", body: cid, id: 0 }]); app.run("xf.scale"); opValue("x", 150); app.applyOp();
    const face = app.doc.get(cid);
    const [fa, fb] = face.shape.boundingBox.bounds;
    // Pivot: bottom centre → the centre stays put; points must satisfy (dx / 1.5R)^2 + (dy / R)^2 = 1
    let worst = 0;
    for (const e of face.shape.edges) for (let k = 0; k <= 24; k++) { const p = e.pointAt(k / 24).toTuple(); worst = Math.max(worst, Math.abs(((p[0] - c[0]) / (1.5 * R)) ** 2 + ((p[1] - c[1]) / R) ** 2 - 1)); }
    expect("27 circle face stretched: valid ellipse face of the right size", face.kind === "face" && window.ydddKernel.isValidShape(face.shape) && r(fb[0] - fa[0]) === r(3 * R) && r(fb[1] - fa[1]) === r(2 * R) && worst < 1e-9,
      { kind: face.kind, size: [r(fb[0] - fa[0]), r(fb[1] - fa[1])], worst });
    app.setSelection([{ kind: "body", body: cid, id: 0 }]); app.run("op.pushpull"); opValue("d", -10); app.applyOp();
    const solid = last();
    const sb = solid.shape.boundingBox.bounds;
    expect("27 then push/pull → elliptical solid", solid.kind === "solid" && window.ydddKernel.isValidShape(solid.shape) && r(sb[1][2] - sb[0][2]) === 10, { kind: solid.kind, h: r(sb[1][2] - sb[0][2]) });
    app.setSelection([{ kind: "body", body: solid.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("27 circle stretch threw", false, String(e && e.stack || e));
  }

  // 28) Ellipse face (stretched circle) pushed into a solid — its side is an extrusion surface that
  //     wraps round (seam) — then stretched along Y: Apply builds a valid solid of the right size
  try {
    app.run("mode.body"); app.setSelection([]); vp.setView("iso"); await sleep(30);
    const n0 = app.doc.bodies.length;
    app.run("tool.circle"); toolClicks([[100, -300, 0], [110, -300, 0]]);
    if (app.doc.bodies.length !== n0 + 1) throw new Error("28: circle not created");
    const cid = last().id;
    app.setSelection([{ kind: "body", body: cid, id: 0 }]); app.run("xf.scale"); opValue("x", 150); app.applyOp();
    app.setSelection([{ kind: "body", body: cid, id: 0 }]); app.run("op.pushpull"); opValue("d", -20); app.applyOp();
    const sol = last();
    const types = [...new Set(sol.shape.faces.map((f) => f.geomType))].sort().join(",");
    const [a, b] = sol.shape.boundingBox.bounds;
    app.setSelection([{ kind: "body", body: sol.id, id: 0 }]); app.run("xf.scale"); opValue("y", 150); app.applyOp();
    const out = app.doc.get(sol.id).shape, [oa, ob] = out.boundingBox.bounds;
    const err = document.querySelector("#op-panel .op-error")?.textContent ?? "";
    expect("28 stretched ellipse prism (extrusion surface + seam): Apply works",
      types.includes("EXTRUSION_SURFACE") && !app.op && out !== sol.shape && window.ydddKernel.isValidShape(out) &&
        r(ob[0] - oa[0]) === r(b[0] - a[0]) && r(ob[1] - oa[1]) === r(1.5 * (b[1] - a[1])) && r(ob[2] - oa[2]) === r(b[2] - a[2]),
      { types, panelStillOpen: !!app.op, err, before: [0, 1, 2].map((k) => r(b[k] - a[k])), after: [0, 1, 2].map((k) => r(ob[k] - oa[k])) });
    if (app.op) app.cancelOp && key("Escape", "Escape");
    app.run("mode.body"); app.setSelection([{ kind: "body", body: sol.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("28 extrusion stretch threw", false, String(e && e.stack || e));
  }

  // 29) Saved B-rep leaves out the display meshes (they are rebuilt on load) and reloads identically
  try {
    app.run("mode.body"); app.setSelection([]);
    const n0 = app.doc.bodies.length;
    app.run("tool.box"); ev("pointermove", [100, -300, 0]); key("Tab", "Tab"); dialog([40, 30, 20]);
    if (app.doc.bodies.length !== n0 + 1) throw new Error("29: box not created");
    const bid = last().id;
    app.setSelection([{ kind: "body", body: bid, id: 0 }]); app.run("op.fillet"); opValue("r", 3); app.applyOp();
    await sleep(50); // displayed → the shape now carries triangulations
    const K = window.ydddKernel, sh = app.doc.get(bid).shape;
    const txt = K.serializeShape(sh), back = K.deserialize(txt);
    const tri = /Triangulations (\d+)/.exec(txt);
    const bb = (x) => x.boundingBox.bounds.flat().map((v) => v.toFixed(6)).join(",");
    expect("29 save: no display meshes in the B-rep, reloads identically", tri && tri[1] === "0" && K.isValidShape(back) && back.faces.length === sh.faces.length && bb(back) === bb(sh) && K.isValidShape(sh),
      { triangulations: tri && tri[1], chars: txt.length, faces: [sh.faces.length, back.faces.length] });
    app.setSelection([{ kind: "body", body: bid, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("29 save threw", false, String(e && e.stack || e));
  }

  // 30) All-filleted box stretched in Y, then its +X face pulled out: the lengthened fillets
  //     stay one face each (no seam where the old end was)
  try {
    app.run("mode.body"); app.setSelection([]);
    const n0 = app.doc.bodies.length;
    app.run("tool.box"); ev("pointermove", [100, -300, 0]); key("Tab", "Tab"); dialog([40, 30, 20]);
    if (app.doc.bodies.length !== n0 + 1) throw new Error("30: box not created");
    const bid = last().id;
    app.setSelection([{ kind: "body", body: bid, id: 0 }]); app.run("op.fillet"); opValue("r", 4); app.applyOp();
    app.setSelection([{ kind: "body", body: bid, id: 0 }]); app.run("xf.scale"); opValue("y", 150); app.applyOp();
    const src = app.doc.get(bid).shape;
    const K = window.ydddKernel;
    const xf = src.faces.filter((f) => f.geomType === "PLANE").sort((a, b) => b.center.x - a.center.x)[0];
    app.run("mode.face"); app.setSelection([{ kind: "face", body: bid, id: xf.hashCode }]);
    app.run("op.pushpull"); opValue("d", 10); app.applyOp();
    const out = app.doc.get(bid).shape;
    const [lo0, hi0] = src.boundingBox.bounds, [lo1, hi1] = out.boundingBox.bounds;
    expect("30 stretched fillets + X pull: no extra seam faces", src.faces.length === 26 && out.faces.length === 26 && K.isValidShape(out) && Math.abs((hi1[0] - lo1[0]) - (hi0[0] - lo0[0]) - 10) < 1e-6,
      { faces: [src.faces.length, out.faces.length], valid: K.isValidShape(out), dx: +((hi1[0] - lo1[0]) - (hi0[0] - lo0[0])).toFixed(4) });
    // Push the same face back in by 15: done as a stretch (fast, no corner scrap left behind) — the
    // swept-block boolean on these B-spline faces took seconds and could leave a piece of a corner.
    const xf2 = out.faces.filter((f) => f.geomType === "PLANE").sort((a, b) => b.center.x - a.center.x)[0];
    app.setSelection([{ kind: "face", body: bid, id: xf2.hashCode }]);
    const t0 = performance.now();
    app.run("op.pushpull"); opValue("d", -15); app.applyOp();
    const ms = performance.now() - t0, back = app.doc.get(bid).shape, [lo2, hi2] = back.boundingBox.bounds;
    expect("30b stretched fillets + X push: right size, no scrap, fast", back.faces.length === 26 && K.isValidShape(back) && Math.abs((hi2[0] - lo2[0]) - (hi0[0] - lo0[0]) + 5) < 1e-6 && ms < 2000,
      { faces: back.faces.length, valid: K.isValidShape(back), dx: +((hi2[0] - lo2[0]) - (hi0[0] - lo0[0])).toFixed(4), ms: Math.round(ms) });
    app.run("mode.body"); app.setSelection([{ kind: "body", body: bid, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("30 stretched fillet seam threw", false, String(e && e.stack || e));
  }

  // 31) Push/pull a curved wall: a cylinder's side grows its radius; one half of an elliptic
  //     cylinder's (split) side scales the whole ellipse in the floor plane, both semi-axes + d
  try {
    app.run("mode.body"); app.setSelection([]);
    const n0 = app.doc.bodies.length;
    app.run("tool.circle"); toolClicks([[100, -300, 0], [110, -300, 0]]);
    if (app.doc.bodies.length !== n0 + 1) throw new Error("31: circle not created");
    const cid = last().id;
    app.setSelection([{ kind: "body", body: cid, id: 0 }]); app.run("op.pushpull"); opValue("d", -20); app.applyOp();
    const cyl = last();
    const size = (s) => { const [a, b] = s.boundingBox.bounds; return [0, 1, 2].map((k) => r(b[k] - a[k])); };
    const pullWall = (id, d) => {
      const wall = app.doc.get(id).shape.faces.find((f) => f.geomType !== "PLANE");
      app.run("mode.face"); app.setSelection([{ kind: "face", body: id, id: wall.hashCode }]); app.run("op.pushpull"); opValue("d", d); app.applyOp();
      return app.doc.get(id).shape;
    };
    const s0 = size(cyl.shape), round = pullWall(cyl.id, 3), s1 = size(round);
    app.run("mode.body"); app.setSelection([{ kind: "body", body: cyl.id, id: 0 }]); app.run("xf.scale"); opValue("x", 150); app.applyOp();
    const ell = app.doc.get(cyl.id).shape, s2 = size(ell);
    // The same elliptic cylinder tilted (wall axis no longer vertical), pulled the same way: tilted back, same size.
    const K = window.ydddKernel, tilted = K.rotateShape(ell, 37, [3, 4, 5], [1, 1, 0]);
    const tw = tilted.faces.find((f) => f.geomType !== "PLANE");
    const st = size(K.rotateShape(K.pushPull(tilted, tw.hashCode, 3), -37, [3, 4, 5], [1, 1, 0]));
    const out = pullWall(cyl.id, 3), s3 = size(out);
    expect("31 curved wall push/pull: cylinder radius + d, ellipse semi-axes + d (also tilted), valid",
      K.isValidShape(round) && s1[0] === r(s0[0] + 6) && s1[1] === r(s0[1] + 6) && s1[2] === s0[2] &&
        K.isValidShape(out) && s3[0] === r(s2[0] + 6) && s3[1] === r(s2[1] + 6) && s3[2] === s2[2] && out.faces.length === ell.faces.length &&
        st.join() === s3.join(),
      { cyl: [s0, s1], ellipse: [s2, s3], tilted: st, faces: [ell.faces.length, out.faces.length] });
    app.run("mode.body"); app.setSelection([{ kind: "body", body: cyl.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("31 curved wall push/pull threw", false, String(e && e.stack || e));
  }

  // 32) Two overlapping cylinders whose tops differ by float32 rounding (~1e-6 mm, as when one was
  //     pushed up to the other's top through the display mesh): Union gives one solid, one top face
  try {
    app.run("mode.body"); app.setSelection([]);
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const h = 52.690614026, h32 = Math.fround(h);
    const a = app.doc.makeBody(K.makeCylinder(G, [200, 0, 0], 20, h), "Cylinder"), b = app.doc.makeBody(K.makeCylinder(G, [215, 10, 0], 12, h32), "Cylinder");
    app.doc.commit([...app.doc.bodies, a, b], "two cylinders");
    app.setSelection([{ kind: "body", body: a.id, id: 0 }, { kind: "body", body: b.id, id: 0 }]);
    app.run("bool.union");
    const u = app.doc.get(a.id)?.shape;
    const tops = u ? u.faces.filter((f) => f.geomType === "PLANE" && f.center.z > 1).length : -1;
    expect("32 union of cylinders off by float32 rounding: one solid, single top face", !!u && K.isValidShape(u) && !app.doc.get(b.id) && tops === 1 && u.faces.length === 4,
      { faces: u?.faces.length, tops, toolGone: !app.doc.get(b.id), dz: h - h32 });
    if (u) { app.setSelection([{ kind: "body", body: a.id, id: 0 }]); app.run("edit.delete"); }
  } catch (e) {
    expect("32 union threw", false, String(e && e.stack || e));
  }

  // 33) Shell a stretched (elliptic) cylinder, top face open: OpenCascade's shell fails on its
  //     B-spline walls, so it is hollowed as a straight extrusion — valid, walls the given thickness
  try {
    app.run("mode.body"); app.setSelection([]);
    const n0 = app.doc.bodies.length;
    app.run("tool.circle"); toolClicks([[300, -300, 0], [310, -300, 0]]);
    if (app.doc.bodies.length !== n0 + 1) throw new Error("33: circle not created");
    const cid = last().id;
    app.setSelection([{ kind: "body", body: cid, id: 0 }]); app.run("op.pushpull"); opValue("d", -20); app.applyOp();
    const sid = last().id;
    app.run("mode.body"); app.setSelection([{ kind: "body", body: sid, id: 0 }]); app.run("xf.scale"); opValue("x", 150); app.applyOp();
    const src = app.doc.get(sid).shape;
    const topFace = src.faces.filter((f) => f.geomType === "PLANE").sort((a, b) => b.center.z - a.center.z)[0];
    app.run("mode.face"); app.setSelection([{ kind: "face", body: sid, id: topFace.hashCode }]);
    app.run("op.shell"); opValue("t", 1); app.applyOp();
    const out = app.doc.get(sid).shape, K = window.ydddKernel;
    const err = document.querySelector("#op-panel .op-error")?.textContent ?? "";
    const [a, b] = out.boundingBox.bounds, [a0, b0] = src.boundingBox.bounds;
    expect("33 shell of a stretched cylinder: hollow, valid, same outside", out !== src && K.isValidShape(out) && out.faces.length > src.faces.length &&
        [0, 1, 2].every((k) => r(b[k] - a[k]) === r(b0[k] - a0[k])),
      { faces: [src.faces.length, out.faces.length], valid: K.isValidShape(out), err, panelOpen: !!app.op });
    if (app.op) key("Escape", "Escape");
    app.run("mode.body"); app.setSelection([{ kind: "body", body: sid, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("33 shell threw", false, String(e && e.stack || e));
  }

  // 34) Union only joins solids that touch: apart ones are refused (bodies unchanged, named);
  //     touching ones still become one solid
  try {
    app.run("mode.body"); app.setSelection([]);
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const lastToast = () => [...document.querySelectorAll("#toasts .toast")].pop()?.textContent ?? "";
    const add = (x, name) => { const b = app.doc.makeBody(K.makeBox(G, [x, 400, 0], 10, 10, 10), name); app.doc.commit([...app.doc.bodies, b], "box"); return b; };
    const sel = (...bs) => app.setSelection(bs.map((b) => ({ kind: "body", body: b.id, id: 0 })));
    const a = add(0, "Box A"), b = add(30, "Box B");
    const n0 = app.doc.bodies.length;
    sel(a, b); app.run("bool.union");
    const apartMsg = lastToast(), apartKept = app.doc.bodies.length === n0 && !!app.doc.get(a.id) && !!app.doc.get(b.id);
    const c = add(10, "Box C"); // touches A, B still apart
    sel(a, c, b); app.run("bool.union");
    const threeMsg = lastToast(), threeKept = !!app.doc.get(c.id) && !!app.doc.get(b.id);
    sel(a, c); app.run("bool.union");
    const joined = app.doc.get(a.id)?.shape;
    const want = '"' + a.name + '" and "' + b.name + '" don' + "'t touch — nothing to join";
    expect("34 union: solids apart refused and named, touching ones joined",
      apartMsg === want && apartKept && threeMsg === want && threeKept &&
        !!joined && !app.doc.get(c.id) && K.isValidShape(joined) && joined.faces.length === 6,
      { apartMsg, apartKept, threeMsg, threeKept, joinedFaces: joined?.faces.length });
    for (const id of [a.id, b.id, c.id]) if (app.doc.get(id)) { app.setSelection([{ kind: "body", body: id, id: 0 }]); app.run("edit.delete"); }
  } catch (e) {
    expect("34 union apart threw", false, String(e && e.stack || e));
  }

  // 35) Subtract that cuts a bar in two: one body per piece (the larger keeps the bar), both
  //     selected; Undo brings back the bar and the block
  try {
    app.run("mode.body"); app.setSelection([]);
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const bar = app.doc.makeBody(K.makeBox(G, [0, 500, 0], 40, 10, 10), "Bar"), blk = app.doc.makeBody(K.makeBox(G, [5, 500, -5], 4, 20, 30), "Block");
    app.doc.commit([...app.doc.bodies, bar, blk], "bar + block");
    const n0 = app.doc.bodies.length;
    app.setSelection([{ kind: "body", body: bar.id, id: 0 }, { kind: "body", body: blk.id, id: 0 }]);
    app.run("bool.subtract"); await sleep(30); // (the pieces are selected after an await)
    const n1 = app.doc.bodies.length, sel = app.selection.map((s) => s.body);
    const pieces = sel.map((id) => app.doc.get(id)?.shape).filter(Boolean);
    const len = (sh) => { const [a, b] = sh.boundingBox.bounds; return r(b[0] - a[0]); };
    const kept = app.doc.get(bar.id)?.shape;
    const msg = [...document.querySelectorAll("#toasts .toast")].pop()?.textContent ?? "";
    app.run("edit.undo");
    const back = app.doc.bodies.length === n0 && !!app.doc.get(bar.id) && !!app.doc.get(blk.id) && app.doc.get(bar.id).shape.faces.length === 6;
    expect("35 subtract splitting a bar: one body per piece, larger keeps the bar, undo restores",
      n1 === n0 && pieces.length === 2 && sel[0] === bar.id && !!kept && len(kept) === 23 && pieces.every((p) => K.isValidShape(p) && p.faces.length === 6) && back,
      { bodies: [n0, n1], selected: sel.length, keptLen: kept && len(kept), lens: pieces.map(len), msg, undoRestores: back });
    for (const id of [bar.id, blk.id]) if (app.doc.get(id)) { app.setSelection([{ kind: "body", body: id, id: 0 }]); app.run("edit.delete"); }
  } catch (e) {
    expect("35 subtract split threw", false, String(e && e.stack || e));
  }

  // 36) Split face by guide: a box's front face split along a vertical guide (solid stays one
  //     piece, both halves selected); pulling one half moves only that half
  try {
    app.run("mode.body"); app.setSelection([]);
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const bx = app.doc.makeBody(K.makeBox(G, [0, 600, 0], 40, 30, 20), "Box");
    app.doc.commit([...app.doc.bodies, bx], "box");
    const guides0 = app.doc.guides.length;
    app.doc.setGuides([...app.doc.guides, { a: [5, 585, 0], b: [5, 585, 20], n: [1, 0, 0] }], "guide");
    vp.setView("front"); vp.fit(); await sleep(30);
    const front = app.doc.get(bx.id).shape.faces.find((f) => f.geomType === "PLANE" && Math.abs(f.center.y - 585) < 1e-6);
    app.run("mode.face"); app.setSelection([{ kind: "face", body: bx.id, id: front.hashCode }]);
    app.run("op.splitFace");
    ev("pointermove", [5, 585, 10]); ev("pointerdown", [5, 585, 10]);
    const split = app.doc.get(bx.id).shape, sel = app.selection.filter((s) => s.kind === "face");
    const halves = sel.map((s) => split.faces.find((f) => f.hashCode === s.id)).filter(Boolean);
    const right = halves.sort((a, b) => b.center.x - a.center.x)[0];
    let pulled = null;
    if (right) { app.setSelection([{ kind: "face", body: bx.id, id: right.hashCode }]); app.run("op.pushpull"); opValue("d", 5); app.applyOp(); pulled = app.doc.get(bx.id).shape; }
    const lo = pulled ? pulled.boundingBox.bounds[0] : null;
    expect("36 split face by guide: one solid, two halves selected, pull moves one half",
      K.isValidShape(split) && split.faces.length === 7 && halves.length === 2 && !!pulled && K.isValidShape(pulled) && r(lo[1]) === 580 && pulled.faces.length > 7,
      { faces: split.faces.length, selected: sel.length, halves: halves.length, pulledFaces: pulled?.faces.length, minY: lo && r(lo[1]) });
    app.doc.setGuides(app.doc.guides.slice(0, guides0), "remove guide");
    app.run("mode.body"); app.setSelection([{ kind: "body", body: bx.id, id: 0 }]); app.run("edit.delete");
    vp.setView("iso");
  } catch (e) {
    expect("36 split face threw", false, String(e && e.stack || e));
  }

  // 37) Cut by guide on a flat face object (a circle drawn on the ground, guide across it in top
  //     view): two separate faces, both selected; Undo restores the circle
  try {
    app.run("mode.body"); app.setSelection([]); vp.setView("top"); await sleep(30);
    const n0 = app.doc.bodies.length;
    app.run("tool.circle"); toolClicks([[300, -300, 0], [310, -300, 0]]);
    if (app.doc.bodies.length !== n0 + 1) throw new Error("37: circle not created");
    const cid = last().id;
    const guides0 = app.doc.guides.length;
    app.doc.setGuides([...app.doc.guides, { a: [285, -300, 0], b: [315, -300, 0], n: [0, 1, 0] }], "guide");
    vp.fit(); await sleep(30);
    app.setSelection([{ kind: "body", body: cid, id: 0 }]);
    app.run("op.cut");
    ev("pointermove", [292, -300, 0]); ev("pointerdown", [292, -300, 0]);
    const sel = app.selection.map((s) => app.doc.get(s.body)).filter(Boolean);
    const areas = sel.map((b) => { const [lo, hi] = b.shape.boundingBox.bounds; return [r(hi[0] - lo[0]), r(hi[1] - lo[1])]; });
    const nCut = app.doc.bodies.length;
    app.run("edit.undo");
    const back = app.doc.bodies.length === n0 + 1 && app.doc.get(cid)?.kind === "face";
    expect("37 cut a circle face by a guide: two separate half faces, undo restores",
      nCut === n0 + 2 && sel.length === 2 && sel.every((b) => b.kind === "face" && window.ydddKernel.isValidShape(b.shape)) &&
        areas.every(([w, h]) => w === 20 && h === 10) && back,
      { bodies: [n0, nCut], selected: sel.length, kinds: sel.map((b) => b.kind), sizes: areas, undoRestores: back });
    app.doc.setGuides(app.doc.guides.slice(0, guides0), "remove guide");
    app.setSelection([{ kind: "body", body: cid, id: 0 }]); app.run("edit.delete");
    vp.setView("iso");
  } catch (e) {
    expect("37 cut face threw", false, String(e && e.stack || e));
  }

  // 38) Autosave / crash recovery: unsaved work is written to the recovery file, reads back as
  //     the same model, and is dropped once the work is saved
  try {
    app.run("mode.body"); app.setSelection([]);
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const b = app.doc.makeBody(K.makeBox(G, [0, 700, 0], 12, 8, 6), "Recover me");
    app.doc.commit([...app.doc.bodies, b], "box");
    await app.autosave();
    const rec = await window.yddd.readRecovery();
    const parsed = rec ? JSON.parse(rec.data) : null;
    const saved = parsed?.bodies.find((x) => x.name === b.name);
    const back = saved ? K.deserialize(saved.brep) : null;
    const same = !!back && K.isValidShape(back) && back.faces.length === 6 && parsed.bodies.length === app.doc.bodies.length;
    const fresh = !!rec && Date.now() - rec.savedAt < 60000;
    app.dropRecovery();
    await new Promise((res) => setTimeout(res, 100));
    const gone = (await window.yddd.readRecovery()) === null;
    expect("38 autosave writes the model to the recovery file; dropped when safe", same && fresh && gone,
      { written: !!rec, bodies: parsed?.bodies.length, docBodies: app.doc.bodies.length, same, fresh, droppedAfterSave: gone });
    app.setSelection([{ kind: "body", body: b.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("38 autosave threw", false, String(e && e.stack || e));
  }

  // 40) Guide parallel to a world axis: Shift+G, click the X axis (top view), move 25 to +Y,
  //     click → a guide along X at y = 25; again on the other side (either side allowed)
  try {
    // Nothing in the way of the axis: hide every body for this test.
    app.run("mode.body"); app.setSelection([]);
    for (const b of app.doc.bodies) app.hidden.add(b.id);
    vp.setHidden(app.hidden);
    vp.setView("top"); vp.fit(); await sleep(30);
    const plain = (type, p) => { const sc = S(p); canvas.dispatchEvent(new PointerEvent(type, { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); };
    const g0 = app.doc.guides.length;
    const made = [];
    for (const y of [25, -10]) {
      app.run("tool.guide");
      plain("pointermove", [30, 0, 0]); plain("pointerdown", [30, 0, 0]);
      plain("pointermove", [30, y, 0]); plain("pointerdown", [30, y, 0]);
      const g = app.doc.guides[app.doc.guides.length - 1];
      made.push(g && { a: g.a.map(r), b: g.b.map(r) });
    }
    const ok = app.doc.guides.length === g0 + 2 && made.every((g, i) => g && g.a[1] === [25, -10][i] && g.b[1] === [25, -10][i] && g.a[2] === 0 && g.b[2] === 0 && g.a[0] < -100 && g.b[0] > 100);
    expect("40 guide parallel to the X axis at y = 25 and y = -10", ok, { added: app.doc.guides.length - g0, made });
    // From the start (iso) view: an X-axis guide still lies on the ground (z = 0); G + Tab raises it.
    vp.setView("iso"); vp.fit(); await sleep(30);
    app.run("tool.guide");
    plain("pointermove", [30, 0, 0]); plain("pointerdown", [30, 0, 0]);
    plain("pointermove", [30, 25, 0]); plain("pointerdown", [30, 25, 0]);
    const gi = app.doc.guides.length - 1, iso = app.doc.guides[gi];
    const isoOk = !!iso && r(iso.a[1]) === 25 && r(iso.b[1]) === 25 && r(iso.a[2]) === 0 && r(iso.b[2]) === 0;
    app.selGuide = gi; app.run("xf.move");
    key("Tab", "Tab"); dialog([0, 0, 10]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true }));
    const moved = app.doc.guides[gi];
    // Guide from the Z axis: the label names the direction ("X = 15"); Y switches to moving along Y.
    app.run("tool.guide");
    plain("pointermove", [0, 0, 20]); plain("pointerdown", [0, 0, 20]);
    plain("pointermove", [15, 0, 20]);
    const hudFirst = app.hudEl.textContent; // (X or Y — whichever runs across the screen)
    key("x", "KeyX");
    plain("pointermove", [15, 0, 20]);
    const hudX = app.hudEl.textContent;
    key("y", "KeyY");
    plain("pointermove", [0, 15, 20]);
    const hudY = app.hudEl.textContent;
    plain("pointerdown", [0, 15, 20]);
    const zg = app.doc.guides[app.doc.guides.length - 1];
    const zOk = /^[XY] = -?[\d.]+ mm$/.test(hudFirst) && hudX === "X = 15 mm" && hudY === "Y = 15 mm" && !!zg && r(zg.a[0]) === 0 && r(zg.a[1]) === 15 && r(zg.b[1]) === 15 && zg.a[2] < -100 && zg.b[2] > 100;
    expect("40c guide from Z: the label names its direction; X key → X = 15 mm, Y key → Y = 15 mm", zOk, { hudFirst, hudX, hudY, guide: zg && { a: zg.a.map(r), b: zg.b.map(r) } });
    expect("40b iso view: X-axis guide on the ground (z = 0); G moves it up 10", isoOk && !!moved && r(moved.a[2]) === 10 && r(moved.b[2]) === 10 && r(moved.a[1]) === 25,
      { iso: iso && { a: iso.a.map(r), b: iso.b.map(r) }, moved: moved && { a: moved.a.map(r), b: moved.b.map(r) } });
    app.doc.setGuides(app.doc.guides.slice(0, g0), "remove guides");
    app.hidden.clear(); vp.setHidden(app.hidden);
    vp.setView("iso");
  } catch (e) {
    expect("40 axis guide threw", false, String(e && e.stack || e));
    app.hidden.clear(); vp.setHidden(app.hidden);
  }

  // 41) A long guide running past the camera (an axis guide, ±500, near a small model in the
  //     default view) can be picked all along where it is drawn
  try {
    app.run("mode.body"); app.setSelection([]);
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const bx = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 12, 12, 8), "Small");
    app.doc.commit([...app.doc.bodies, bx], "box");
    const g0 = app.doc.guides.length;
    vp.setView("iso"); vp.fit([bx.id]); await sleep(30);
    // (along X or Y — whichever the camera looks along more, so the guide runs past it from any view)
    const look = vp.controls.target.clone().sub(vp.camera.position), alongX = Math.abs(look.x) >= Math.abs(look.y);
    const ga = alongX ? [-500, 7.17, 0] : [7.17, -500, 0], gb = alongX ? [500, 7.17, 0] : [7.17, 500, 0];
    app.doc.setGuides([...app.doc.guides, { a: ga, b: gb, n: alongX ? [0, 1, 0] : [1, 0, 0] }], "guide"); await sleep(30);
    const rect = vp.canvas.getBoundingClientRect(), A = new V(...ga), B = new V(...gb);
    const behind = [A, B].filter((P) => P.clone().applyMatrix4(vp.camera.matrixWorldInverse).z > 0).length;
    let visible = 0, picked = 0;
    for (let k = 0; k <= 400; k++) {
      const p = A.clone().lerp(B, k / 400);
      if (p.clone().applyMatrix4(vp.camera.matrixWorldInverse).z > -vp.camera.near * 2) continue;
      const sc = vp.toScreen(p);
      if (sc.x < rect.left || sc.x > rect.right || sc.y < rect.top || sc.y > rect.bottom) continue;
      visible++;
      if (vp.guideAt(sc.x, sc.y) === g0) picked++;
    }
    expect("41 long guide past the camera: picked wherever it is drawn", behind >= 1 && visible > 5 && picked === visible, { endsBehindCamera: behind, visible, picked });
    app.doc.setGuides(app.doc.guides.slice(0, g0), "remove guide");
    app.setSelection([{ kind: "body", body: bx.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("41 guide picking threw", false, String(e && e.stack || e));
  }

  // 42) Axis guides with a slanted cut direction (the view they were drawn in): on the bottom face
  //     the face wins, inside the solid the world plane does, and a Z guide in front of a cylinder
  //     (the plane drawn in iso would miss it) cuts it straight up; a diagonal guide keeps its slant
  try {
    app.run("mode.body"); app.setSelection([]);
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const n = [0, 0.8741521676311549, 0.48565212634740257]; // from an X-axis guide drawn in an orbited view
    const g0 = app.doc.guides.length;
    const cutWith = (shape, guide) => {
      const body = app.doc.makeBody(shape, "Slant");
      app.doc.commit([...app.doc.bodies, body], "solid");
      app.doc.setGuides([...app.doc.guides.slice(0, g0), guide], "guide");
      app.opCut([body.id], g0);
      const top = last(), res = { cut: top.id !== body.id, tb: top.shape.boundingBox.bounds, kb: app.doc.get(body.id).shape.boundingBox.bounds };
      app.setSelection([{ kind: "body", body: body.id, id: 0 }, ...(res.cut ? [{ kind: "body", body: top.id, id: 0 }] : [])]); app.run("edit.delete");
      return res;
    };
    for (const z of [0, 10]) {
      const box = K.makeBox(G, [0, 0, 0], 40, 30, 20), [lo, hi] = box.boundingBox.bounds, y = (lo[1] + hi[1]) / 2;
      const { cut, tb, kb } = cutWith(box, { a: [-500, y, lo[2] + z], b: [500, y, lo[2] + z], n });
      expect(z === 0 ? "42 slanted X guide on the bottom face: cut straight up" : "42b slanted X guide inside the solid: cut straight up",
        cut && Math.abs(tb[0][1] - y) < 1e-6 && Math.abs(kb[1][1] - y) < 1e-6, [tb[0].map(r), kb[1].map(r), y]);
    }
    {
      const c = [22.065237140343754, 69.229549142524775, 0], gx = 25.299588533336504;
      const { cut, tb, kb } = cutWith(K.makeCylinder(G, c, 35.882729580564991, 49.28), { a: [gx, 0, -500], b: [gx, 0, 500], n: [0.8050558373533651, 0.5931990380498541, 0] });
      expect("42c Z guide in front of a cylinder (iso direction): cut straight up at its x", cut && Math.abs(tb[0][0] - gx) < 1e-6 && Math.abs(kb[1][0] - gx) < 1e-6, cut ? [tb[0].map(r), kb[1].map(r)] : "not cut");
    }
    {
      const box = K.makeBox(G, [0, 0, 0], 40, 30, 20), [lo, hi] = box.boundingBox.bounds, m = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
      // Diagonal in plan at mid height (inside the box), vertical plane: not an axis guide, stays diagonal
      const { cut, tb } = cutWith(box, { a: [m[0] - 10, m[1] - 10, m[2]], b: [m[0] + 10, m[1] + 10, m[2]], n: [Math.SQRT1_2, -Math.SQRT1_2, 0] });
      expect("42d diagonal guide keeps its direction", cut && tb[1][2] - tb[0][2] > 19.9 && tb[1][0] - tb[0][0] > 30, cut ? tb.map((p) => p.map(r)) : "not cut");
    }
    app.doc.setGuides(app.doc.guides.slice(0, g0), "remove guide");
  } catch (e) {
    expect("42 slanted guide cut threw", false, String(e && e.stack || e));
  }

  // 39) STL quality dialog: presets fill the values, the estimate drops for Draft, editing a
  //     value selects Custom, Export returns the values and remembers them
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    localStorage.removeItem("yddd.stlQuality");
    const cyl = K.makeCylinder(G, [0, 0, 0], 10, 30);
    const done = app.stlQualityDialog([cyl]);
    const dlg = document.getElementById("props-dlg");
    const est = () => dlg.querySelector(".stl-estimate").textContent;
    const radio = (v) => dlg.querySelector("input[name=preset][value='" + v + "']");
    const num = () => Number(est().replace(/[^0-9 ]/g, "").trim().split(/\s+/)[0]);
    await sleep(400);
    const normal = { checked: radio("1").checked, tri: num() };
    radio("0").checked = true; radio("0").dispatchEvent(new Event("change")); await sleep(400);
    const draft = { tol: dlg.querySelector("input[data-k=tolerance]").value, tri: num() };
    const tolIn = dlg.querySelector("input[data-k=tolerance]");
    tolIn.value = "0.05"; tolIn.dispatchEvent(new Event("input")); await sleep(50);
    const custom = radio("custom").checked;
    dlg.requestSubmit();
    const q = await done;
    const saved = JSON.parse(localStorage.getItem("yddd.stlQuality") || "null");
    expect("39 STL quality dialog: Normal default, Draft fewer triangles, edit → Custom, values returned + remembered",
      normal.checked && normal.tri > 0 && draft.tol === "0.1" && draft.tri > 0 && draft.tri < normal.tri && custom && q && q.tolerance === 0.05 && q.angle === 15 && saved && saved.tolerance === 0.05 && !document.getElementById("props-dlg"),
      { normal, draft, custom, q, saved });
    localStorage.removeItem("yddd.stlQuality");
  } catch (e) {
    expect("39 STL dialog threw", false, String(e && e.stack || e));
  }

  app.setSelection([]);
  vp.setView("iso"); vp.fit();
  await sleep(400);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("complex scenario failed: " + JSON.stringify(failed));
  return [{ label: "complex scenario", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** STL import: ASCII and binary, inside-out winding, several pieces, open meshes, faceted shapes. */
const SCENARIO_STL = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel;
  const checks = [];
  const check = (label, ok, info) => checks.push({ label, ok: !!ok, info });
  // Triangles of an axis-aligned box, wound outward (flip = inward).
  const box = (x0, y0, z0, s, flip = false) => {
    const c = (i) => [x0 + (i & 1 ? s : 0), y0 + (i & 2 ? s : 0), z0 + (i & 4 ? s : 0)];
    const quads = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
    const tris = quads.flatMap(([a, b, c2, d]) => [[a, b, c2], [a, c2, d]]).map((t) => t.map(c));
    return flip ? tris.map(([a, b, c2]) => [a, c2, b]) : tris;
  };
  const ascii = (tris) => new TextEncoder().encode("solid t\n" + tris.map((t) => " facet normal 0 0 0\n  outer loop\n" + t.map((v) => "   vertex " + v.join(" ") + "\n").join("") + "  endloop\n endfacet\n").join("") + "endsolid t\n");
  const binary = (tris) => {
    const buf = new ArrayBuffer(84 + 50 * tris.length), dv = new DataView(buf);
    dv.setUint32(80, tris.length, true);
    tris.forEach((t, i) => t.forEach((v, j) => v.forEach((x, k) => dv.setFloat32(84 + 50 * i + 12 + 12 * j + 4 * k, x, true))));
    return new Uint8Array(buf);
  };
  const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));

  let r = K.importStl(ascii(box(0, 0, 0, 10)));
  check("ascii cube: 1 solid, 6 merged faces, volume 1000", r.solids.length === 1 && r.solids[0].faces.length === 6 && near(K.solidVolume(r.solids[0]), 1000) && K.isValidShape(r.solids[0]), { faces: r.solids[0]?.faces.length, v: r.solids[0] && K.solidVolume(r.solids[0]) });

  r = K.importStl(binary(box(5, 5, 5, 10, true)));
  check("binary inside-out cube: oriented, volume +1000", r.solids.length === 1 && near(K.solidVolume(r.solids[0]), 1000), { v: r.solids[0] && K.solidVolume(r.solids[0]) });

  r = K.importStl(binary([...box(0, 0, 0, 10), ...box(30, 0, 0, 20)]));
  check("two disjoint cubes: 2 solids", r.solids.length === 2 && r.open === 0 && near(r.solids.map(K.solidVolume).reduce((a, b) => a + b, 0), 9000), { n: r.solids.length, open: r.open });

  r = K.importStl(binary([...box(0, 0, 0, 10), ...box(30, 0, 0, 10).slice(2)]));
  check("closed + open piece: 1 solid, 1 skipped", r.solids.length === 1 && r.open === 1, { n: r.solids.length, open: r.open });

  let err = "";
  try { K.importStl(binary(box(0, 0, 0, 10).slice(2))); } catch (e) { err = String(e); }
  check("open mesh only: error", /not closed/.test(err), err);
  err = "";
  try { K.importStl(new TextEncoder().encode("garbage")); } catch (e) { err = String(e); }
  check("garbage: error", !!err, err);

  // Octahedron: 8 non-coplanar triangles stay 8 faces.
  const P = [[10, 0, 0], [-10, 0, 0], [0, 10, 0], [0, -10, 0], [0, 0, 10], [0, 0, -10]];
  const oct = [[0, 2, 4], [2, 1, 4], [1, 3, 4], [3, 0, 4], [2, 0, 5], [1, 2, 5], [3, 1, 5], [0, 3, 5]].map((t) => t.map((i) => P[i]));
  r = K.importStl(binary(oct));
  check("octahedron: 8 faces, volume 4000/3", r.solids.length === 1 && r.solids[0].faces.length === 8 && near(K.solidVolume(r.solids[0]), 4000 / 3), { faces: r.solids[0]?.faces.length });

  // An imported mesh is an ordinary solid: push/pull one of its faces.
  r = K.importStl(ascii(box(0, 0, 0, 10)));
  const top = r.solids[0].faces.find((f) => f.geomType === "PLANE" && Math.abs(f.center.z - 10) < 1e-6)?.hashCode;
  let pulled = null;
  try { pulled = K.pushPull(r.solids[0], top, 5); } catch (e) { err = String(e); }
  check("push/pull on imported cube", pulled && near(K.solidVolume(pulled), 1500), { top, v: pulled && K.solidVolume(pulled), err });

  await sleep(50);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("stl scenario failed: " + JSON.stringify(failed));
  return [{ label: "stl import", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** STEP export → import round trip: solids, volumes and positions come back; bad files fail cleanly. */
const SCENARIO_STEP = String.raw`
(async () => {
  const K = window.ydddKernel;
  const checks = [];
  const check = (label, ok, info) => checks.push({ label, ok: !!ok, info });
  const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol * Math.max(1, Math.abs(b));
  const F = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const box = K.makeBox(F, [100, 50, 0], 20, 10, 5), cyl = K.makeCylinder(F, [-30, 0, 0], 4, 12);
  const buf = new Uint8Array(await K.exportStep([{ shape: box, name: "Box" }, { shape: cyl, name: "Cyl" }]));
  const head = new TextDecoder().decode(buf.subarray(0, 200));
  check("export STEP: ISO-10303 file", buf.length > 500 && head.startsWith("ISO-10303-21"), { bytes: buf.length, head: head.slice(0, 20) });
  const back = await K.importStep(buf);
  check("import STEP: two solids", back.length === 2, back.length);
  const vols = back.map((s) => K.solidVolume(s)).sort((a, b) => a - b), want = [K.solidVolume(cyl), K.solidVolume(box)].sort((a, b) => a - b);
  check("round trip keeps volumes", vols.length === 2 && near(vols[0], want[0]) && near(vols[1], want[1]), { vols, want });
  const b = back.find((s) => near(K.solidVolume(s), 1000));
  const bb = b && b.boundingBox.bounds;
  check("round trip keeps position", bb && near(bb[0][0], 90, 1e-2) && near(bb[0][1], 45, 1e-2) && near(bb[0][2], 0, 1e-2), bb);
  check("imported solids are valid", back.every((s) => K.isValidShape(s)));
  let err = "";
  try { await K.importStep(new TextEncoder().encode("garbage")); } catch (e) { err = String(e); }
  check("garbage STEP throws", err !== "", err);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("step scenario failed: " + JSON.stringify(failed));
  return [{ label: "step round trip", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Help → Bird House: the walkthrough builds a valid bird house step by step; Back undoes a step. */
/** Help → House: every step valid, then one hollow L-shaped house with valleys, chimney, door and window. */
const SCENARIO_HOUSE = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const toasts = () => [...document.querySelectorAll("#toasts .toast.error")].map((t) => t.textContent);
  const press = async (act) => { document.querySelector("#tutorial button[data-act=" + act + "]").click(); await sleep(60); };
  app.doc.dirty = false;
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove()); // (older ones would expire mid-way and upset the count)
  app.run("help.house"); await sleep(30);
  const panel = document.getElementById("tutorial");
  const titles = [...panel.querySelectorAll("li > b:first-child")].map((b) => b.textContent);
  const total = titles.length;
  expect("house: panel opens with the steps", !panel.hidden && panel.querySelector("h2").textContent === "House" && total === 12, titles);
  const before = toasts().length, vols = {};
  for (let i = 0; i < total; i++) {
    if (titles[i] === "Push the wing back") {
      // By hand, as the step says: G G on the wing, press the top of its back gable, drag (then Ctrl + Shift) onto the main ridge
      const vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
      const pe = (type, p, mods = {}) => { const sc = window.__see(new V(p[0], p[1], p[2])); canvas.dispatchEvent(new PointerEvent(type, { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true, ...mods })); };
      const wing = app.doc.bodies.find((b) => b.name === "Wing 1");
      app.run("mode.body"); app.setSelection([{ kind: "body", body: wing.id, id: 0 }]);
      app.run("xf.moveFrom"); await sleep(30);
      const tool = app.tool && app.tool.name;
      pe("pointermove", [-45, -35, 65]); pe("pointerdown", [-45, -35, 65]);
      const mods = { ctrlKey: true, shiftKey: true };
      for (const y of [-25, -12, -3]) pe("pointermove", [-43, y, 65], mods);
      pe("pointermove", [-42, 0, 65], mods); pe("pointerup", [-42, 0, 65], mods); await sleep(30);
      const wb = app.doc.get(wing.id).shape.boundingBox.bounds, r = (v) => Math.round(v * 1e6) / 1e6;
      expect("house: G G from the wing's back gable top, Ctrl + Shift onto the main ridge → exactly 35 back", tool === "Move from point" && [wb[0].map(r), wb[1].map(r)].join() === "-80,-95,0,-10,0,65", { tool, lo: wb[0].map(r), hi: wb[1].map(r) });
      app.run("edit.undo"); await sleep(30);
      app.setSelection([]);
    }
    await press("do");
    const bad = app.doc.bodies.filter((b) => !K.isValidShape(b.shape)).map((b) => b.name);
    if (bad.length || toasts().length > before) { expect("house: step " + (i + 1) + " valid", false, { bad, errors: toasts() }); break; }
    const h = app.doc.bodies.find((b) => b.name === "House 1");
    vols[titles[i]] = h && K.solidVolume(h.shape);
  }
  const names = app.doc.bodies.map((b) => b.name);
  expect("house: all steps done, no errors, one body", panel.querySelectorAll("li.done").length === total && toasts().length === before && names.join() === "House 1", { done: panel.querySelectorAll("li.done").length, errors: toasts(), names });
  const h = app.doc.bodies[0];
  if (h) {
    const [lo, hi] = h.shape.boundingBox.bounds, r = (v) => Math.round(v * 1000) / 1000;
    // Solid (before Shell): main 160×70×40 + roof, wing 70×95×40 + roof, less their overlap (box + where
    // the roofs overlap: 70 × 35 × 25/3), and the chimney above the roof
    const solid = (160 * 70 * 40 + 0.5 * 70 * 25 * 160) + (70 * 95 * 40 + 0.5 * 70 * 25 * 95) - (70 * 35 * 40 + 70 * 35 * 25 / 3) + (8 * 8 * 72 - 8 * (65 * 8 - (25 / 70) * (18 * 18 - 10 * 10)));
    const shelled = vols["Hollow it"], door = vols["Hollow it"] - vols["Door"], win = vols["Door"] - vols["Window"];
    expect("house: L-shaped, 72 high with the chimney; solid, then hollow (3 mm walls, open below)", [lo.map(r), hi.map(r)].join() === "-80,-95,0,80,35,72" && Math.abs(vols["Chimney"] - solid) < 1e-3 && shelled > 0.1 * solid && shelled < 0.3 * solid,
      { lo: lo.map(r), hi: hi.map(r), solid: vols["Chimney"], want: solid, shelled });
    expect("house: door and window cut right through the 3 mm wall", Math.abs(door - 16 * 30 * 3) < 1e-3 && Math.abs(win - 18 * 14 * 3) < 1e-3, { door, win });
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("house scenario failed: " + JSON.stringify(failed));
  return checks;
})()
`;

/** Help → Planter: every step valid; the tapered frustum, hollowed (exact volume), then the drainage hole. */
const SCENARIO_PLANTER = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const toasts = () => [...document.querySelectorAll("#toasts .toast.error")].map((t) => t.textContent);
  const press = async (act) => { document.querySelector("#tutorial button[data-act=" + act + "]").click(); await sleep(60); };
  app.doc.dirty = false;
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove()); // (older ones would expire mid-way and upset the count)
  app.run("help.planter"); await sleep(30);
  const panel = document.getElementById("tutorial");
  const titles = [...panel.querySelectorAll("li > b:first-child")].map((b) => b.textContent);
  const total = titles.length;
  expect("planter: panel opens with the steps", !panel.hidden && panel.querySelector("h2").textContent === "Planter" && total === 4, titles);
  const before = toasts().length, vols = {}, faces = {};
  for (let i = 0; i < total; i++) {
    await press("do");
    const bad = app.doc.bodies.filter((b) => !K.isValidShape(b.shape)).map((b) => b.name);
    if (bad.length || toasts().length > before) { expect("planter: step " + (i + 1) + " valid", false, { bad, errors: toasts() }); break; }
    const p = app.doc.bodies.find((b) => b.name === "Planter 1");
    vols[titles[i]] = p && K.solidVolume(p.shape);
    faces[titles[i]] = p && p.shape.faces.length;
  }
  const names = app.doc.bodies.map((b) => b.name);
  expect("planter: all steps done, no errors, one body", panel.querySelectorAll("li.done").length === total && toasts().length === before && names.join() === "Planter 1", { done: panel.querySelectorAll("li.done").length, errors: toasts(), names });
  const p = app.doc.bodies[0];
  if (p) {
    const [lo, hi] = p.shape.boundingBox.bounds, r = (v) => Math.round(v * 1000) / 1000;
    const frustum = 450 / 3 * (300 * 300 + 220 * 220 + 300 * 220);
    // Hollow: the cavity is a frustum from z 30 to 450, its sides 2 × 30 / cos(taper) narrower than the outside's
    const w = 2 * 30 * Math.hypot(450, 40) / 450, side = (z) => 220 + 80 * z / 450 - w, a = side(450), b = side(30);
    const shelled = frustum - 420 / 3 * (a * a + b * b + a * b), hole = Math.PI * 15 * 15 * 30;
    const v = vols, ok = Math.abs(v["Flare it up"] - frustum) < 1e-3 && faces["Flare it up"] === 6 && Math.abs(v["Hollow it"] - shelled) < 1e-2 && Math.abs(v["Hollow it"] - v["Drainage hole"] - hole) < 1e-2;
    expect("planter: 300 top, 220 bottom, 450 high; frustum, hollow (30 walls, open top), 30 mm hole through the floor",
      [lo.map(r), hi.map(r)].join() === "-150,-150,0,150,150,450" && ok,
      { lo: lo.map(r), hi: hi.map(r), tapered: v["Flare it up"], frustum, faces: faces["Flare it up"], hollow: v["Hollow it"], shelled, hole: v["Hollow it"] - v["Drainage hole"], wantHole: hole });
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("planter scenario failed: " + JSON.stringify(failed));
  return checks;
})()
`;

const SCENARIO_BIRD = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const toasts = () => [...document.querySelectorAll("#toasts .toast.error")].map((t) => t.textContent);
  const press = async (act) => { document.querySelector("#tutorial button[data-act=" + act + "]").click(); await sleep(60); };
  app.doc.dirty = false;
  app.run("help.birdhouse"); await sleep(30);
  const panel = document.getElementById("tutorial");
  const total = panel.querySelectorAll("li").length;
  expect("bird: panel opens with the steps", !panel.hidden && total >= 10, total);
  const before = toasts().length;
  for (let i = 0; i < total; i++) {
    if (i === 5) {
      // Hollow step: from below the base hides the house's bottom face until it is hidden (eye in Bodies)
      const vp = app.viewport, V = vp.camera.position.constructor;
      const base = app.doc.bodies.find((b) => b.name === "Base 1"), house = app.doc.bodies.find((b) => b.name === "House 1");
      vp.setView("top"); vp.flipView(); vp.fit(); await sleep(50);
      const at = () => { const sc = vp.toScreen(new V(20, 20, 15)); return vp.pick(sc.x, sc.y, "face"); }; // (hidden on purpose: not __see)
      const covered = at();
      const eye = () => document.querySelector('#outliner .ol-row[data-id="' + base.id + '"] .ol-eye').click();
      eye(); await sleep(50);
      const open = at();
      eye(); await sleep(50);
      expect("bird: hollow step — base hides the bottom face, the eye hides the base", covered && covered.body === base.id && open && open.body === house.id && !app.hidden.has(base.id),
        { covered: covered && covered.body, open: open && open.body, base: base.id, house: house.id });
      vp.setView("iso");
    }
    await press("do");
    const bad = app.doc.bodies.filter((b) => !K.isValidShape(b.shape)).map((b) => b.name);
    if (bad.length || toasts().length > before) { expect("bird: step " + (i + 1) + " valid", false, { bad, errors: toasts() }); break; }
  }
  const names = app.doc.bodies.map((b) => b.name);
  expect("bird: all steps done, no errors", panel.querySelectorAll("li.done").length === total && toasts().length === before, { done: panel.querySelectorAll("li.done").length, errors: toasts() });
  expect("bird: base, house and roof", names.join() === "Base 1,House 1,Roof", names);
  const get = (n) => app.doc.bodies.find((b) => b.name === n);
  const house = get("House 1"), roof = get("Roof");
  if (house && roof) {
    const hb = house.shape.boundingBox.bounds, rb = roof.shape.boundingBox.bounds;
    const full = 110 * 110 * 130 + 0.5 * 110 * 55 * 110;
    expect("bird: house hollow, with a hole and a perch", K.solidVolume(house.shape) < full / 2 && house.shape.faces.some((f) => f.geomType === "CYLINDRE") && Math.abs(hb[0][1] + 80) < 1e-3 && Math.abs(hb[1][2] - 200) < 1e-3,
      { vol: Math.round(K.solidVolume(house.shape)), lo: hb[0], hi: hb[1] });
    expect("bird: roof overhangs and sits on the slopes", rb[0][0] < -60 && rb[1][0] > 60 && rb[0][1] < -60 && rb[1][1] > 60 && rb[1][2] > 210 && rb[0][2] < 145 && roof.shape.faces.length <= 12,
      { lo: rb[0], hi: rb[1], faces: roof.shape.faces.length });
  }
  await press("back");
  expect("bird: Back undoes the last step (two boards again)", app.doc.bodies.length === 4 && panel.querySelectorAll("li.done").length === total - 1, app.doc.bodies.map((b) => b.name));
  await press("do");
  expect("bird: redo the step", app.doc.bodies.length === 3, app.doc.bodies.map((b) => b.name));
  app.run("view.iso"); app.viewport.fit(); await sleep(300);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("bird scenario failed: " + JSON.stringify(failed));
  return [{ label: "bird house walkthrough", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Help → Cable Storage Box: the walkthrough builds one valid part; the first divider can be drawn as the step says. */
const SCENARIO_CABLE = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const r = (n) => +n.toFixed(3);
  const toasts = () => [...document.querySelectorAll("#toasts .toast.error")].map((t) => t.textContent);
  const press = async (act) => { document.querySelector("#tutorial button[data-act=" + act + "]").click(); await sleep(60); };
  const ev = (type, p) => { const s = window.__see(new V(p[0], p[1], p[2])); canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true, ctrlKey: true })); };
  const key = (k, code) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
  const dialog = (vals) => { const d = document.getElementById("props-dlg"); if (!d) return false; const q = [...d.querySelectorAll("input")]; vals.forEach((v, i) => { if (q[i]) q[i].value = String(v); }); d.requestSubmit(); return true; };
  app.doc.dirty = false;
  vp.setView("top"); vp.flipView(); // (looking from below: Start must turn back to the start-up iso view — the steps say "back left"...)
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove()); // (older ones would expire mid-way and upset the count)
  app.run("help.cablebox"); await sleep(30);
  const panel = document.getElementById("tutorial");
  const total = panel.querySelectorAll("li").length;
  expect("cable: panel opens with the steps", !panel.hidden && panel.querySelector("h2").textContent === "Cable storage box" && total === 9, total);
  const before = toasts().length;
  for (let i = 0; i < total; i++) {
    if (i === 1) {
      const dir = () => vp.camera.position.clone().sub(vp.controls.target).normalize(), o = dir(), pos = vp.camera.position.clone();
      vp.setView("iso"); const iso = dir(); vp.camera.position.copy(pos); vp.controls.update();
      expect("cable: Start turns the view to the start-up iso view", o.dot(iso) > 0.9999, { o: o.toArray(), iso: iso.toArray() });
    }
    if (i === 3) {
      // "First divider" by hand: Box tool, Ctrl-click where the back wall's flat inside starts (floor level), a little inside, Tab 4 × 112 × 56
      vp.fit(); await sleep(50);
      const n0 = app.doc.bodies.length;
      app.run("tool.box");
      ev("pointermove", [-112, 56, 4]); ev("pointerdown", [-112, 56, 4]);
      ev("pointermove", [-100, 40, 4]);
      key("Tab", "Tab"); await sleep(30);
      const ok = dialog([4, 112, 56]); await sleep(30);
      const made = app.doc.bodies.length === n0 + 1 ? app.doc.bodies[n0] : null;
      const bb = made && made.shape.boundingBox.bounds;
      expect("cable: first divider drawn as the step says starts where the back wall's flat inside does, across the box", ok && bb && [bb[0].map(r), bb[1].map(r)].join() === "-112,-56,4,-108,56,60", bb && [bb[0].map(r), bb[1].map(r)]);
      if (made) app.run("edit.undo");
      key("Escape", "Escape");
    }
    await press("do");
    const bad = app.doc.bodies.filter((b) => !K.isValidShape(b.shape)).map((b) => b.name);
    if (bad.length || toasts().length > before) { expect("cable: step " + (i + 1) + " valid", false, { bad, errors: toasts() }); break; }
  }
  expect("cable: all steps done, no errors", panel.querySelectorAll("li.done").length === total && toasts().length === before, { done: panel.querySelectorAll("li.done").length, errors: toasts() });
  const box = app.doc.bodies.length === 2 ? app.doc.bodies[0] : null, lid = box && app.doc.bodies[1];
  if (box) {
    const bb = box.shape.boundingBox.bounds;
    // outside R 8 corners, inside R 4 (Box from Face: the inside radius, the outside that + the wall)
    const outer = (240 * 120 - (4 - Math.PI) * 64) * 60, hollow = (232 * 112 - (4 - Math.PI) * 16) * 56, divs = 3 * 4 * 112 * 56;
    const vol = K.solidVolume(box.shape), want = outer - hollow + divs;
    expect("cable: one box, 240 × 120 × 60 standing on the grid, R 8 outside / R 4 inside corners, 3 dividers", box.name === "Cable box" && [bb[0].map(r), bb[1].map(r)].join() === "-120,-60,0,120,60,60" && Math.abs(vol - want) < 1 && box.shape.faces.filter((f) => f.geomType === "CYLINDRE").length === 8,
      { name: box.name, bb, vol: r(vol), want: r(want) });
    const lb = lid.shape.boundingBox.bounds, cap = K.boxLid(box.shape, { over: true, thickness: 3, lipDepth: 10, lipWall: 2, clearance: 0.3 });
    const label = K.solidVolume(lid.shape) - K.solidVolume(cap), overlap = K.solidVolume(K.booleanOp("intersect", lid.shape, [box.shape]));
    expect("cable: the lid fits over the box (244.6 × 124.6, z 50 – 63, clear of it) with the raised CABLES label joined on top (to z 64.5)",
      lid.name === "Cable box lid" && K.isValidShape(lid.shape) && [lb[0].map(r), lb[1].map(r)].join() === "-122.3,-62.3,50,122.3,62.3,64.5" && overlap < 1e-6 && label > 100,
      { name: lid.name, lb: lb.map((p) => p.map(r)), overlap, label: r(label) });
  } else expect("cable: a box and a lid", false, app.doc.bodies.map((b) => b.name));
  await press("back");
  expect("cable: Back undoes the label's join (box, lid, 6 letters)", app.doc.bodies.length === 8, app.doc.bodies.map((b) => b.name));
  app.run("view.iso"); await press("do"); await sleep(300);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("cable scenario failed: " + JSON.stringify(failed));
  return [{ label: "cable box walkthrough", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Export only what prints: flat faces never (STEP too); solids that aren't closed and meshes with gaps are named first. */
const SCENARIO_PRINT = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  app.doc.reset([]);
  const q = { tolerance: 0.05, angle: 10 };
  const ball = K.parseStl(new Uint8Array(await K.exportStl([K.makeSphereAt([0, 0, 10], 10)], q)));
  const torn = new ball.constructor(ball.positions.slice(0, -9)); // (one triangle gone: a gap of 3 edges)
  const box = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 20, 20, 10), "Box");
  const closed = app.doc.makeBody(ball, "Ball", "mesh"), open = app.doc.makeBody(torn, "Torn", "mesh");
  const sheet = app.doc.makeBody(K.makeRectFace(G, [50, 0, 0], 10, 10), "Sheet", "solid"); // (a "solid" that is only a surface)
  const face = app.doc.makeBody(K.makeRectFace(G, [80, 0, 0], 10, 10), "Rect", "face");
  app.doc.commit([box, closed, open, sheet, face], "print bodies");
  const found = app.printProblems(app.doc.bodies).map((p) => [p.body.name, p.why]);
  expect("print check: a box and a closed mesh pass; a mesh with a missing triangle (3 open edges) and a \"solid\" that is only a surface are named; flat faces aren't checked",
    found.length === 2 && found[0][0] === "Torn 1" && /3 open edges/.test(found[0][1]) && found[1][0] === "Sheet 1" && /not a closed solid/.test(found[1][1]), found);
  // A flat face alone: not even STEP takes it
  app.run("mode.body"); app.setSelection([{ kind: "body", body: face.id, id: 0 }]);
  await app.fileExport("step"); await sleep(20);
  const toasts = [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent).slice(-2);
  expect("print check: STEP skips flat faces too — a face alone: nothing to export", /STEP skips flat faces/.test(toasts[0] ?? "") && /Nothing to export/.test(toasts[1] ?? ""), toasts);
  app.setSelection([]); app.doc.reset([]);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("print scenario failed: " + JSON.stringify(failed));
  return [{ label: "print check at export", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Cone (B O): a sharp tip, a flat top (Tab: top size), downwards, typed height,top; exact volumes, prints clean. */
const SCENARIO_CONE = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, vp = app.viewport, K = window.ydddKernel, V = vp.camera.position.constructor;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const ev = (type, p) => { const s = vp.toScreen(new V(...p)); vp.canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
  const key = (k, code) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
  const dialog = (vals) => { const d = document.getElementById("props-dlg"); const q = [...d.querySelectorAll("input")]; vals.forEach((v, i) => (q[i].value = String(v))); d.requestSubmit(); };
  const box = (b) => { const [a, c] = b.shape.boundingBox.bounds; return [...a, ...c].map((v) => Math.round(v * 1000) / 1000); };
  const was = localStorage.getItem("yddd.circleSize");
  localStorage.setItem("yddd.circleSize", "r");
  app.doc.reset([]); app.run("mode.body"); app.run("view.top"); vp.fit(); await sleep(30);
  // B then O (the solid chord) starts the Cone tool
  key("b", "KeyB"); await sleep(10); key("o", "KeyO"); await sleep(10);
  expect("cone: B O starts the Cone tool", app.tool && app.tool.name === "Cone", app.tool && app.tool.name);
  key("Escape", "Escape"); await sleep(10);
  const make = async (vals) => {
    app.run("tool.cone"); ev("pointermove", [0, 0, 0]); key("Tab", "Tab"); await sleep(20);
    const labels = [...document.querySelectorAll("#props-dlg label span")].map((s) => s.textContent);
    dialog(vals); await sleep(50);
    const b = app.doc.bodies[app.doc.bodies.length - 1];
    key("Escape", "Escape"); await sleep(10);
    return { b, labels };
  };
  const PI = Math.PI;
  const sharp = await make([10, 0, 30]);
  const sv = K.solidVolume(sharp.b.shape), cones = sharp.b.shape.faces.filter((f) => f.geomType === "CONE").length;
  expect("cone: Tab asks Radius / Top radius / Height; 10, 0, 30 → a sharp cone (volume π·10²·30/3, 20×20×30, one cone face + the base, valid)",
    sharp.labels.length === 3 && /^Top radius/.test(sharp.labels[1]) && sharp.b.name === "Cone 1" && Math.abs(sv - PI * 100 * 30 / 3) < 1e-6
      && box(sharp.b).join() === "-10,-10,0,10,10,30" && cones === 1 && sharp.b.shape.faces.length === 2 && K.isValidShape(sharp.b.shape),
    { labels: sharp.labels, name: sharp.b.name, sv, box: box(sharp.b), cones, faces: sharp.b.shape.faces.length });
  const cut = await make([10, 4, 20]);
  const cv = K.solidVolume(cut.b.shape);
  expect("cone: top radius 4 → a flat-topped cone (volume π·20/3·(10² + 10·4 + 4²), 3 faces)",
    Math.abs(cv - PI * 20 / 3 * (100 + 40 + 16)) < 1e-6 && cut.b.shape.faces.length === 3 && K.isValidShape(cut.b.shape), { cv, faces: cut.b.shape.faces.length });
  const down = await make([5, 0, -15]);
  expect("cone: a negative height points it down (base on the plane, tip at z = -15)", box(down.b).join() === "-5,-5,-15,5,5,0", box(down.b));
  // Typed: radius + Enter, then height,top + Enter
  app.run("tool.cone"); ev("pointermove", [50, 0, 0]); ev("pointerdown", [50, 0, 0]); await sleep(10);
  for (const k of "8") key(k, "Digit" + k); key("Enter", "Enter"); await sleep(10);
  for (const k of "12,3") key(k, k === "," ? "Comma" : "Digit" + k); key("Enter", "Enter"); await sleep(50);
  const typed = app.doc.bodies[app.doc.bodies.length - 1];
  key("Escape", "Escape"); await sleep(10);
  const tv = K.solidVolume(typed.shape);
  expect("cone: typed 8 Enter, 12,3 Enter → base radius 8, height 12, top radius 3", typed !== down.b && Math.abs(tv - PI * 12 / 3 * (64 + 24 + 9)) < 1e-6 && box(typed).join() === "42,-8,0,58,8,12", { tv, box: box(typed) });
  // Diameter setting: the fields ask for diameters
  localStorage.setItem("yddd.circleSize", "d");
  const dia = await make([20, 0, 10]);
  expect("cone: with Diameter set, Tab asks Diameter / Top diameter (20 → 20 across)", dia.labels[0] === "Diameter" && /^Top diameter/.test(dia.labels[1]) && box(dia.b).slice(0, 2).join() === "-10,-10", { labels: dia.labels, box: box(dia.b) });
  expect("cone: cones pass the print check", app.printProblems(app.doc.bodies).length === 0, app.printProblems(app.doc.bodies).map((p) => p.why));
  if (was === null) localStorage.removeItem("yddd.circleSize"); else localStorage.setItem("yddd.circleSize", was);
  app.doc.reset([]);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("cone scenario failed: " + JSON.stringify(failed));
  return [{ label: "cone tool", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** A flat face's centre dot + G: pull the face to a point — a cone, a pyramid, a flat top, onto / into a solid. */
const SCENARIO_POINT = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, vp = app.viewport, K = window.ydddKernel, V = vp.camera.position.constructor;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const key = (k, code) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
  const clickAt = (p) => { const s = vp.toScreen(new V(...p)); for (const t of ["pointermove", "pointerdown", "pointerup"]) vp.canvas.dispatchEvent(new PointerEvent(t, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
  const opValue = (k, v) => { const i = document.querySelector("#op-panel input[data-key=" + k + "]"); if (i) { i.value = String(v); i.dispatchEvent(new Event("input", { bubbles: true })); } };
  const vol = (b) => K.solidVolume(b.shape);
  const near = (a, b) => Math.abs(a - b) < 1e-6 * Math.max(1, Math.abs(b));
  const cdot = () => app.dots.find((d) => d.face !== undefined);
  const dotAt = () => cdot() && cdot().at.map((v) => Math.round(v * 1000) / 1000).join();
  // Pull the selected thing's centre dot: click the dot, G, set the fields, apply
  const pull = async (h, top = 0) => {
    clickAt(cdot().at); await sleep(20);
    const picked = app.selDot >= 0 && app.dots[app.selDot].face !== undefined && app.selection.length === 0;
    app.chord = null; // (not G G: the last pull's G was a moment ago)
    key("g", "KeyG"); await sleep(30);
    const title = app.op ? app.op.spec.title : null;
    opValue("h", h); opValue("top", top); await sleep(30);
    const err = document.querySelector("#op-panel .op-error")?.textContent || "";
    app.applyOp(); await sleep(50);
    if (app.op) key("Escape", "Escape");
    return { picked, title, err };
  };
  try {
    app.doc.reset([]); app.run("mode.body"); app.run("view.iso"); vp.fit(); await sleep(30);
    // A circle face → a cone
    const circle = app.doc.makeBody(K.makeCircleFace(G, [0, 0, 0], 10), "Circle", "face");
    app.doc.commit([circle], "circle"); vp.fit(); await sleep(30);
    app.setSelection([{ kind: "body", body: circle.id, id: 0 }]); await sleep(10);
    expect("point: a selected circle face shows its centre dot", dotAt() === "0,0,0", dotAt());
    if (!cdot()) return [{ label: "pull a face to a point", passed: 0, total: 1, checks }];
    const c = await pull(30);
    const cone = app.doc.bodies[0];
    expect("point: click the dot (the face lets go), G → Pull to a point; 30 → a cone (volume π·10²·30/3, one cone face, valid, named Cone)",
      c.picked && /Pull to a point/.test(c.title) && app.doc.bodies.length === 1 && cone.kind === "solid" && /^Cone/.test(cone.name) && near(vol(cone), Math.PI * 100 * 30 / 3)
        && cone.shape.faces.filter((f) => f.geomType === "CONE").length === 1 && K.isValidShape(cone.shape), { ...c, n: app.doc.bodies.length, name: cone.name, kind: cone.kind, v: vol(cone) });
    // A rectangle face, top 50% → a flat-topped pyramid
    app.doc.reset([]);
    const rect = app.doc.makeBody(K.makeRectFace(G, [0, 0, 0], 20, 10), "Rectangle", "face");
    app.doc.commit([rect], "rect"); vp.fit(); await sleep(30);
    app.setSelection([{ kind: "body", body: rect.id, id: 0 }]); await sleep(10);
    const fr = await pull(10, 50);
    const frustum = app.doc.bodies[0];
    expect("point: a rectangle, Top size 50% → a flat-topped pyramid (10/3·(200 + 50 + √(200·50)), 6 faces, named Block: not a point)",
      /^Block/.test(frustum.name) && near(vol(frustum), 10 / 3 * (200 + 50 + 100)) && frustum.shape.faces.length === 6 && K.isValidShape(frustum.shape), { ...fr, name: frustum.name, v: vol(frustum), faces: frustum.shape.faces.length });
    // The planter's way: a 220 square, Height 450, Top size "300mm" → widens to 300 at the top
    app.doc.reset([]);
    const base = app.doc.makeBody(K.makeRectFace(G, [0, 0, 0], 220, 220), "Rectangle", "face");
    app.doc.commit([base], "base"); vp.fit(); await sleep(30);
    app.setSelection([{ kind: "body", body: base.id, id: 0 }]); await sleep(10);
    const fl = await pull(450, "300mm");
    const flared = app.doc.bodies[0], fb = flared.shape.boundingBox.bounds.map((q) => q.map((v) => Math.round(v * 1000) / 1000));
    expect("point: Top size 300mm on a 220 square, height 450 → it widens: 300 × 300 at the top, frustum volume, named Block",
      !fl.err && flared.name === "Block 1" && fb.join() === "-150,-150,0,150,150,450" && near(vol(flared), 450 / 3 * (300 * 300 + 220 * 220 + 300 * 220)), { ...fl, name: flared.name, fb, v: vol(flared) });
    // A box's top face: out → a roof on it (one solid); into it → a pyramid-shaped pocket
    app.doc.reset([]);
    const box = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 20, 20, 10), "Box");
    app.doc.commit([box], "box"); vp.fit(); await sleep(30);
    app.run("mode.face");
    const topFace = () => app.doc.bodies[0].shape.faces.find((f) => f.geomType === "PLANE" && Math.abs(f.center.z - 10) < 1e-6 && Math.abs(f.normalAt().z - 1) < 1e-6);
    app.setSelection([{ kind: "face", body: box.id, id: topFace().hashCode }]); await sleep(10);
    expect("point: a box's top face shows the dot in its middle", dotAt() === "0,0,10", dotAt());
    await pull(6);
    const roofed = app.doc.bodies[0];
    expect("point: out of the box's top (6) → added to the box: one solid, 4000 + 20²·6/3", app.doc.bodies.length === 1 && near(vol(roofed), 4000 + 800) && K.isValidShape(roofed.shape), { n: app.doc.bodies.length, v: vol(roofed) });
    app.run("edit.undo"); await sleep(20);
    app.run("mode.face");
    app.setSelection([{ kind: "face", body: app.doc.bodies[0].id, id: topFace().hashCode }]); await sleep(10);
    const pk = await pull(-6);
    expect("point: into the top (-6) → a pyramid pocket cut out: 4000 − 800", near(vol(app.doc.bodies[0]), 3200) && K.isValidShape(app.doc.bodies[0].shape), { ...pk, v: vol(app.doc.bodies[0]) });
    // No dot: a curved face, two faces; Esc lets the point go
    app.doc.reset([]);
    const cyl = app.doc.makeBody(K.makeCylinder(G, [0, 0, 0], 5, 10), "Cylinder");
    app.doc.commit([cyl], "cyl"); await sleep(20);
    app.run("mode.face");
    const side = cyl.shape.faces.find((f) => f.geomType === "CYLINDRE"), cap = cyl.shape.faces.find((f) => f.geomType === "PLANE" && f.center.z > 5);
    app.setSelection([{ kind: "face", body: cyl.id, id: side.hashCode }]); await sleep(10);
    const sideDot = cdot();
    app.setSelection([{ kind: "face", body: cyl.id, id: side.hashCode }, { kind: "face", body: cyl.id, id: cap.hashCode }]); await sleep(10);
    const twoDot = cdot();
    app.setSelection([{ kind: "face", body: cyl.id, id: cap.hashCode }]); await sleep(10);
    clickAt(cdot().at); await sleep(20);
    const sel = app.selDot >= 0;
    key("Escape", "Escape"); await sleep(10);
    expect("point: no dot on a curved face or with two faces; a cylinder's top has one; Esc lets the point go",
      !sideDot && !twoDot && sel && app.selDot < 0 && !cdot(), { sideDot: !!sideDot, twoDot: !!twoDot, sel, after: app.selDot });
  } catch (e) {
    expect("point: no errors", false, String(e && e.stack || e));
  }
  app.doc.reset([]); app.run("mode.body");
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("point scenario failed: " + JSON.stringify(failed));
  return [{ label: "pull a face to a point", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** F on a tip's dot: round a cone's / pyramid's point (exact ball), not box corners or a pocket's bottom; too big says so. */
const SCENARIO_TIP = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, vp = app.viewport, K = window.ydddKernel, V = vp.camera.position.constructor;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const key = (k, code) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
  const clickAt = (p) => { const s = vp.toScreen(new V(...p)); for (const t of ["pointermove", "pointerdown", "pointerup"]) vp.canvas.dispatchEvent(new PointerEvent(t, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
  const opValue = (k, v) => { const i = document.querySelector("#op-panel input[data-key=" + k + "]"); if (i) { i.value = String(v); i.dispatchEvent(new Event("input", { bubbles: true })); } };
  const tipDots = () => app.dots.filter((d) => d.tip);
  const zmax = (b) => b.shape.boundingBox.bounds[1][2];
  const show = (shape, name) => { app.doc.reset([]); const b = app.doc.makeBody(shape, name); app.doc.commit([b], name); app.run("mode.body"); vp.fit(); app.setSelection([{ kind: "body", body: b.id, id: 0 }]); return b; };
  // Click the tip's dot, F, the radius, apply
  const round = async (r) => {
    clickAt(tipDots()[0].at); await sleep(20);
    const picked = app.selDot >= 0 && !!app.dots[app.selDot].tip && app.selection.length === 0;
    app.chord = null;
    key("f", "KeyF"); await sleep(30);
    const title = app.op ? app.op.spec.title : null;
    opValue("r", r); await sleep(30);
    app.applyOp(); await sleep(50);
    const open = !!app.op, err = document.querySelector("#op-panel .op-error")?.textContent || "";
    if (open) key("Escape", "Escape");
    return { picked, title, err, open };
  };
  try {
    app.run("view.iso");
    // A cone (half-angle atan(10/30)): its tip has a dot; F 2 → a ball tip, exactly r/sin − r lower, no sharp tip left
    const cone = show(K.makeCone(G, [0, 0, 0], 10, 0, 30), "Cone"); await sleep(30);
    const coneDots = app.dots.length;
    const c = await round(2);
    const g = Math.atan(10 / 30), cb = app.doc.bodies[0];
    expect("tip: a selected cone shows one dot, at its tip; click it, F → Round tip; 2 → a ball tip (2/sin − 2 lower, valid, no sharp tip left)",
      coneDots === 1 && c.picked && c.title === "Round tip" && !c.open && Math.abs(zmax(cb) - (30 - (2 / Math.sin(g) - 2))) < 1e-6 && K.isValidShape(cb.shape) && K.solidTips(cb.shape).length === 0 && K.solidVolume(cb.shape) < K.solidVolume(cone.shape),
      { coneDots, ...c, z: zmax(cb), tips: K.solidTips(cb.shape).length });
    app.run("edit.undo"); await sleep(20);
    expect("tip: undo brings the sharp tip back", Math.abs(zmax(app.doc.bodies[0]) - 30) < 1e-9, zmax(app.doc.bodies[0]));
    // A square pyramid's point
    const sq = K.makeRectFace(G, [0, 0, 0], 40, 40);
    show(K.pullToPoint(sq, sq.hashCode, 28), "Pyramid"); await sleep(30);
    const pyrDots = tipDots().length;
    const p = await round(3);
    const pb = app.doc.bodies[0], half = Math.atan(Math.hypot(20, 20) / 28);
    expect("tip: a square pyramid's point (one tip dot) rounds too: 3 → 3/sin(edge angle) − 3 lower, valid",
      pyrDots === 1 && !p.open && Math.abs(zmax(pb) - (28 - (3 / Math.sin(half) - 3))) < 1e-6 && K.isValidShape(pb.shape), { pyrDots, ...p, z: zmax(pb) });
    // Too big: the panel says the most it takes
    show(K.makeCone(G, [0, 0, 0], 10, 0, 30), "Cone"); await sleep(30);
    const big = await round(50);
    expect("tip: a radius too big for the tip: the panel says so (under … mm), nothing changes", big.open && /too big .* under/.test(big.err) && Math.abs(zmax(app.doc.bodies[0]) - 30) < 1e-9, big);
    // No tip dots: a box's corners, a pyramid-shaped pocket's bottom, a cone-shaped hole's bottom
    const box = K.makeBox(G, [0, 0, 0], 40, 40, 20), top = box.faces.find((f) => f.geomType === "PLANE" && Math.abs(f.center.z - 20) < 1e-6);
    show(box, "Box"); await sleep(10); const boxDots = tipDots().length;
    show(K.booleanOp("subtract", box, [K.pullToPoint(box, top.hashCode, -10)]), "Pocket"); await sleep(10); const pocketDots = tipDots().length;
    show(K.booleanOp("subtract", box, [K.makeCone(G, [0, 0, 20], 8, 0, -10)]), "Hole"); await sleep(10); const holeDots = tipDots().length;
    expect("tip: no tip dots on a box's corners, a pyramid pocket's or a cone hole's bottom", boxDots + pocketDots + holeDots === 0, { boxDots, pocketDots, holeDots });
    // A pencil (cylinder + cone): its tip; F on a face's centre dot doesn't round
    show(K.booleanOp("union", K.makeCylinder(G, [0, 0, 0], 5, 40), [K.makeCone(G, [0, 0, 40], 5, 0, 15)]), "Pencil"); await sleep(30);
    const pencil = await round(0.3);
    expect("tip: a pencil's (cylinder + cone) tip rounds", !pencil.open && K.isValidShape(app.doc.bodies[0].shape) && zmax(app.doc.bodies[0]) < 55, { ...pencil, z: zmax(app.doc.bodies[0]) });
  } catch (e) {
    expect("tip: no errors", false, String(e && e.stack || e));
  }
  app.doc.reset([]); app.run("mode.body");
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("tip scenario failed: " + JSON.stringify(failed));
  return [{ label: "round a tip", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Sketch Spline (Shift+A / its button): a smooth curve through clicked points — open (a path) or closed (a face); drag its points in Select; K brings them back. */
const SCENARIO_SPLINE = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  localStorage.removeItem("yddd.pro"); document.body.classList.remove("pro");
  for (let k = 0; k < 3 && app.tool; k++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  app.doc.reset([]); app.run("mode.body"); app.setSelection([]); vp.setView("top"); await sleep(30);
  const key = async (k, extra = {}) => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra })); await sleep(10); };
  const pe = (t, p) => { const sc = window.__see(new V(p[0], p[1], 0)); canvas.dispatchEvent(new PointerEvent(t, { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); };
  const click = async (p) => { pe("pointermove", p); pe("pointerdown", p); pe("pointerup", p); await sleep(450); }; // (apart: not double-clicks)
  const near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 1e-6;
  const collinear = (a, m, b) => Math.abs((m[0] - a[0]) * (b[1] - m[1]) - (m[1] - a[1]) * (b[0] - m[0])) < 1e-6;
  try {
    await key("k", { code: "KeyK" }); await sleep(50);
    const T = () => app.tool;
    // Fit the area we draw in
    vp.fit(); await sleep(30);
    await key("A", { shiftKey: true, code: "KeyA" });
    const btn = document.querySelector("#sketch-panel button[data-mode=spline]");
    expect("spline: Shift+A in the sketch → Spline; its button (Spline Shift+A) lit", T() && T().mode === "spline" && btn && /Spline/.test(btn.textContent) && /Shift\+A/.test(btn.textContent) && btn.classList.contains("primary"), { mode: T() && T().mode, btn: btn && btn.textContent });
    // Open: 4 points, Enter → a path through all of them, smooth at each
    const open = [[0, 0], [20, 10], [40, 0], [60, 10]];
    for (const p of open) await click(p);
    await key("Enter");
    const o = T().opens[0], g = o && o[0];
    const thruOk = g && g.kind === "spline" && g.thru.length === 4 && open.every((p, i) => near(g.pts[4 * i], p));
    const smooth = g && [1, 2].every((i) => collinear(g.pts[4 * i - 1], g.pts[4 * i], g.pts[4 * i + 1]));
    expect("spline: 4 clicks + Enter → an open path through every point, smooth at each (no corners)", T().opens.length === 1 && o.length === 1 && thruOk && smooth, { opens: T().opens.length, thru: g && g.thru, smooth });
    // Closed: 4 points, then the start point
    const ring = [[0, 30], [20, 50], [0, 70], [-20, 50]];
    for (const p of ring) await click(p);
    await click(ring[0]);
    const l = T().loops[0], lg = l && l.segs && l.segs[0];
    expect("spline: back on the start point → a closed outline (smooth all round, start included)",
      T().loops.length === 1 && lg && lg.kind === "spline" && lg.closed && near(lg.a, lg.b) && collinear(lg.pts[lg.pts.length - 2], lg.pts[0], lg.pts[1]) && T().first === null, { loops: T().loops.length, closed: lg && lg.closed });
    // Select it, drag its point (20,50) → (30,50); undo puts it back
    await key("Escape");
    await click([20, 50]);
    const handles = T().splineHandles().length;
    pe("pointermove", [20, 50]); pe("pointerdown", [20, 50]); pe("pointermove", [25, 50]); pe("pointermove", [30, 50]); pe("pointerup", [30, 50]); await sleep(20);
    const moved = T().loops[0].segs[0];
    const dragOk = moved.thru && near(moved.thru[1], [30, 50]) && near(moved.pts[4], [30, 50]) && near(moved.thru[0], [0, 30]);
    await key("z", { ctrlKey: true });
    const back = T().loops[0].segs[0];
    expect("spline: selected, its 4 points show; drag one → the curve runs through the new place; Ctrl+Z puts it back",
      T().mode === "select" && handles === 4 && dragOk && near(back.thru[1], [20, 50]), { mode: T().mode, handles, moved: moved.thru, back: back.thru });
    // Done → a flat face (the closed one) and a path (the open one)
    document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(50);
    const face = app.doc.bodies.find((b) => b.kind === "face"), path = app.doc.bodies.find((b) => b.kind === "path");
    const solid = face && K.extrudeFace(face.shape, face.shape.faces[0].hashCode, 10);
    expect("spline: Done → a flat face (pushes into a valid solid) and a path", !app.tool && face && path && solid && K.isValidShape(solid) && K.solidVolume(solid) > 100, { tool: app.tool && app.tool.name, kinds: app.doc.bodies.map((b) => b.kind) });
    // Edge mode (3): a click on the path picks its line — Del still deletes the path; undo brings it back
    const pathId = path.id, mid = path.shape.edges[0].pointAt(0.5).toTuple();
    app.run("mode.edge"); app.setSelection([]);
    pe("pointermove", mid); pe("pointerdown", mid); pe("pointerup", mid); await sleep(30);
    const picked = app.selection.length === 1 && app.selection[0].kind === "edge" && app.selection[0].body === pathId;
    await key("Delete", { code: "Delete" });
    const gone = !app.doc.get(pathId) && app.doc.bodies.length === 1;
    app.run("edit.undo"); await sleep(20);
    expect("spline: Edge mode, click the path (its line), Del → the path is deleted; undo brings it back", picked && gone && !!app.doc.get(pathId), { picked, gone, back: !!app.doc.get(pathId) });
    app.run("mode.body");
    // A circle swept along a long Spline (12 points): its heavy tube face is drawn coarser — quick, not 400 000 triangles
    {
      const q = Array.from({ length: 12 }, (_, i) => [i * 4, (i % 2 ? 6 : -6) + i, 0]);
      const nq = q.length, add = (u, v) => u.map((x, i) => x + v[i]), sub = (u, v) => u.map((x, i) => x - v[i]), mul = (u, k) => u.map((x) => x * k);
      const tan = (i) => (i === 0 ? sub(q[1], q[0]) : i === nq - 1 ? sub(q[nq - 1], q[nq - 2]) : mul(sub(q[i + 1], q[i - 1]), 0.5));
      const pts = [q[0]];
      for (let i = 0; i + 1 < nq; i++) { const A = add(q[i], mul(tan(i), 0.25)), B = sub(q[i + 1], mul(tan(i + 1), 0.25)); pts.push(A, mul(add(A, B), 0.5), B, q[i + 1]); }
      const wire = K.sketchPath([{ kind: "spline", pts, w: pts.map(() => 1) }]);
      const disc = K.makeCircleFace({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, [0, 40, 0], 1.5);
      const tube = K.sweepFace(disc, disc.faces[0].hashCode, wire, true, false, 0);
      const t0 = performance.now(), mesh = K.tessellate(tube), ms = performance.now() - t0, tris = mesh.faces.triangles.length / 3;
      expect("spline: a circle swept along a 12-point Spline — valid, drawn in well under a second (its heavy face coarser: under 100 000 triangles)",
        K.isValidShape(tube) && ms < 1500 && tris < 100000, { ms: Math.round(ms), tris, valid: K.isValidShape(tube) });
    }
    // K on the face again: its curve comes back as a Spline, points to drag
    app.setSelection([{ kind: "body", body: face.id, id: 0 }]);
    await key("k", { code: "KeyK" }); await sleep(50);
    const again = T() && T().loops[0] && T().loops[0].segs && T().loops[0].segs[0];
    expect("spline: K on its face → back in the sketch as a Spline (its 4 points again, to drag)", again && again.thru && again.thru.length === 4 && again.closed && ring.every((p) => again.thru.some((q) => near(p, q))), again && again.thru);
    document.querySelector("#sketch-panel button[data-act=cancel]")?.click(); await sleep(20);
  } catch (e) {
    expect("spline: no errors", false, String(e && e.stack || e));
  }
  for (let k = 0; k < 3 && app.tool; k++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  app.doc.reset([]); app.run("mode.body"); app.run("view.iso");
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("spline scenario failed: " + JSON.stringify(failed));
  return [{ label: "sketch spline", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Measure (=): hovering a corner, an edge, faces and a circle shows their sizes in the HUD. */
const SCENARIO_MEASURE = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  document.getElementById("tutorial").hidden = true; document.body.classList.remove("tutorial-open");
  app.doc.dirty = false;
  app.doc.reset([]);
  const box = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 40, 30, 20), "Box");
  const cyl = app.doc.makeBody(K.makeCylinder(G, [60, 0, 0], 10, 30), "Cylinder");
  app.doc.commit([box, cyl], "shapes");
  app.run("mode.body"); app.setSelection([]); vp.setView("iso"); vp.fit(); await sleep(100);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "=", code: "Equal", bubbles: true, cancelable: true }));
  await sleep(20);
  expect("measure: = starts the Measure tool", app.tool && app.tool.name === "Measure", app.tool && app.tool.name);
  // (the HUD follows on the next frame: wait for it to change — up to 300 ms on a busy machine)
  const hud = () => (app.hudEl.hidden ? null : app.hudEl.textContent);
  const hover = async (p) => {
    const was = hud(), sc = window.__see(new V(p[0], p[1], p[2]));
    canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true }));
    for (let i = 0; i < 15; i++) { await sleep(20); if (hud() !== was) break; }
    return hud();
  };
  const cases = [
    ["corner", [20, -15, 20], "Corner\nX 20  Y -15  Z 20"],
    ["edge", [5, -15, 20], "Edge\nLength 40 mm"],
    ["flat face", [-8, -5, 20], "Flat face\n40 × 30 mm\nArea 1,200 mm²"],
    ["cylinder side", [60 + 10 * Math.cos(-1.2), 10 * Math.sin(-1.2), 12], "Cylinder\nR 10  ·  Ø 20  ·  Height 30\nArea 1,884.96 mm²"],
    ["circle edge", [60 + 10 * Math.cos(-0.9), 10 * Math.sin(-0.9), 30], "Circle\nR 10  ·  Ø 20\nLength 62.83 mm"],
  ];
  for (const [what, p, want] of cases) {
    const got = await hover(p);
    expect("measure: hover " + what, got === want, got);
  }
  expect("measure: the hovered face is highlighted, nothing selected", app.selection.length === 0, app.selection);
  const click = async (p) => { await hover(p); const sc = window.__see(new V(p[0], p[1], p[2])); canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); await sleep(20); };
  const esc = async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20); };
  const panel = () => document.getElementById("measure-panel")?.textContent.replace(/\s+/g, " ") ?? "";
  await click([20, -15, 20]); await click([-20, -15, 20]);
  expect("measure: 2 clicks → length in the corner panel", /Length 40 mm\s*ΔX -40\s*ΔY 0\s*ΔZ 0\s*Slope 0° from level/.test(panel()) && !/Angle/.test(panel()), panel());
  await click([-20, -15, 0]);
  expect("measure: 3rd click → angle at the 2nd point", /Angle 90°/.test(panel()) && /Second length 20 mm/.test(panel()), panel());
  await esc();
  expect("measure: Esc after a result clears it, still measuring", app.tool && app.tool.name === "Measure" && !/Length/.test(panel()), { tool: app.tool && app.tool.name, panel: panel() });
  await click([20, -15, 20]); await hover([20, -15, 0]);
  expect("measure: live length while choosing the 2nd point (slope 90°)", /Length 20 mm/.test(panel()) && /Slope 90°/.test(panel()), panel());
  {
    // Off any snap point, a few pixels beside the X direction from the 1st point: locked onto the X axis
    // (a spot with no point or edge under it — those win over the lock)
    const s1 = window.__see(new V(20, -15, 20));
    const spot = [20, 25, 30, 35, 40, 45].map((dx) => {
      const s2 = window.__see(new V(20 + dx, -15, 20)), ux = s2.x - s1.x, uy = s2.y - s1.y, ul = Math.hypot(ux, uy);
      return { dx, x: s2.x - uy / ul * 2, y: s2.y + ux / ul * 2 };
    }).find((q) => !vp.snapPoint(q.x, q.y) && !vp.pick(q.x, q.y, "edge"));
    if (spot) canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: spot.x, clientY: spot.y, button: 0, bubbles: true })); await sleep(20);
    const hud = app.hudEl.hidden ? null : app.hudEl.textContent;
    expect("measure: 2nd point locks onto the X axis through the 1st", spot && new RegExp("ΔX " + spot.dx + "(\\.\\d+)?ΔY 0ΔZ 0").test(panel()) && /^On X axis/.test(hud ?? ""), { spot, panel: panel(), hud });
  }
  await esc();
  // Cylinder height: a point on the bottom circle, then the top circle a little off straight up → the point on the top circle straight above
  app.run("tool.measure"); await sleep(20);
  const rim = (a, z) => [60 + 10 * Math.cos(a), 10 * Math.sin(a), z];
  // (on the side facing the camera — the default view: -1.2)
  const facing = Math.atan2(vp.camera.position.y - vp.controls.target.y, vp.camera.position.x - vp.controls.target.x) - 0.324;
  await click(rim(facing, 0)); await hover(rim(facing + 0.05, 30));
  const hudH = app.hudEl.hidden ? null : app.hudEl.textContent;
  expect("measure: on a curve near the Z direction → the curve's point straight above (cylinder height 30)", /Length 30 mm ΔX 0ΔY 0ΔZ 30/.test(panel()) && /^On Z axis/.test(hudH ?? ""), { panel: panel(), hud: hudH });
  await esc();
  expect("measure: Esc after only the 1st click exits the tool", !app.tool && !document.getElementById("measure-panel"), app.tool && app.tool.name);
  app.run("tool.measure"); await sleep(20);
  const doneBtn = document.querySelector("#measure-panel button[data-act=cancel]"), doneText = doneBtn.textContent;
  doneBtn.click(); await sleep(20);
  expect("measure: Done exits the tool", doneText === "Done" && !app.tool && !document.getElementById("measure-panel"), { doneText, tool: app.tool && app.tool.name });
  app.run("tool.measure"); await sleep(20);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  await sleep(20);
  expect("measure: Esc ends it and hides the HUD", !app.tool && app.hudEl.hidden, { tool: app.tool && app.tool.name, hud: app.hudEl.hidden });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", code: "Equal", shiftKey: true, bubbles: true, cancelable: true }));
  await sleep(20);
  expect("measure: + (Shift+=) is still Union, not Measure", !app.tool, app.tool && app.tool.name);
  // Cone faces (a triangle revolved: like a profile swept along an arc): per-axis scale stretches them exactly,
  // Measure knows them (gp_Cone isn't in the wasm build — read from the surface instead)
  {
    const tri = K.makePolygonFace({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] }, [20, 0, 10], 8, 3, 10);
    const ring = K.translateShape(K.revolveFace(tri, tri.faces[0].hashCode, { origin: [0, 0, 0], dir: [0, 0, 1] }, 90), [3, -4, 2]); // (90°: one arc span — measureVolume is exact on it)
    const cones = ring.faces.filter((f) => f.geomType === "CONE");
    const v0 = K.solidVolume(ring), f = [1.5, 0.8, 2];
    let err = null, ratio = null, valid = false;
    try { const st = K.scaleShape(ring, f, [10, 10, 5]); valid = K.isValidShape(st); ratio = K.solidVolume(st) / v0 / (f[0] * f[1] * f[2]); } catch (e) { err = String(e); }
    const info = K.faceInfo(ring, cones[0].hashCode);
    expect("scale: a solid with cone faces stretches per axis (valid, volume × 1.5 × 0.8 × 2); Measure reads a cone face",
      cones.length >= 2 && !err && valid && Math.abs(ratio - 1) < 1e-6 && info && info.type === "cone" && info.halfAngle > 0,
      { cones: cones.length, err, valid, ratio, info });
  }
  const failed = checks.filter((c) => !c.ok);
  // Tab over an edge → dimension: Esc cancels, click places it; text = length; select + Del, undo, save/load
  const key = async (k, code) => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true })); await sleep(20); };
  const labels = () => [...document.querySelectorAll("#dim-labels .dim-label:not(.preview)")].map((l) => l.textContent);
  app.run("tool.measure"); await sleep(20);
  await hover([5, -15, 20]); await key("Tab", "Tab"); await hover([5, -15, 32]);
  const preview = document.querySelector("#dim-labels .dim-label.preview")?.textContent;
  const pl = document.querySelector("#dim-labels .dim-label.preview"), pcs = pl && getComputedStyle(pl);
  expect("dimension: the label being placed is black on yellow", pcs && pcs.color === "rgb(0, 0, 0)" && pcs.backgroundColor === "rgb(255, 209, 102)", pcs && [pcs.color, pcs.backgroundColor]);
  await key("Escape", "Escape");
  expect("dimension: Tab on an edge previews it, Esc cancels and stays in Measure", preview === "40" && app.doc.dimensions.length === 0 && app.tool && app.tool.name === "Measure", { preview, dims: app.doc.dimensions.length, tool: app.tool && app.tool.name });
  await hover([5, -15, 20]); await key("Tab", "Tab"); await hover([5, -15, 32]);
  const sc = window.__see(new V(5, -15, 32)); canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); await sleep(30);
  const dim = app.doc.dimensions[0];
  const near = (p, q) => p.every((v, k) => Math.abs(v - q[k]) < 1e-6);
  expect("dimension: placed on the edge's ends, offset square to it, text 40", app.doc.dimensions.length === 1 && [dim.a, dim.b].some((p) => near(p, [20, -15, 20])) && [dim.a, dim.b].some((p) => near(p, [-20, -15, 20])) && Math.abs(dim.o[0]) < 1e-6 && Math.hypot(...dim.o) > 2 && labels().join() === "40",
    { dim, labels: labels() });
  const saved = app.modelText();
  app.run("edit.undo"); await sleep(20);
  const undone = app.doc.dimensions.length === 0 && labels().length === 0;
  app.run("edit.redo"); await sleep(20);
  expect("dimension: undo / redo", undone && app.doc.dimensions.length === 1 && labels().join() === "40", { undone, dims: app.doc.dimensions.length });
  await key("Escape", "Escape"); await key("Escape", "Escape");
  const lab = document.querySelector("#dim-labels .dim-label");
  const lcs = lab && getComputedStyle(lab);
  expect("dimension: a placed label is black on white", lcs && lcs.color === "rgb(0, 0, 0)" && lcs.backgroundColor === "rgb(255, 255, 255)", lcs && [lcs.color, lcs.backgroundColor]);
  if (!lab) expect("dimension: label present before selecting", false, { html: document.getElementById("dim-labels")?.outerHTML, dims: app.doc.dimensions.length, tool: app.tool && app.tool.name });
  lab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await sleep(20);
  const selected = document.querySelector("#dim-labels .dim-label.sel") !== null;
  await key("Delete", "Delete");
  expect("dimension: click its text selects it, Del removes it", selected && app.doc.dimensions.length === 0 && labels().length === 0, { selected, dims: app.doc.dimensions.length });
  app.doc.dirty = false; app.loadModel(saved, null); await sleep(50);
  expect("dimension: saved in the .yddd file", app.doc.dimensions.length === 1 && labels().join() === "40", app.doc.dimensions);
  // Linked to the edge: push/pull the box's +X end → 50; move the box → the dimension moves with it; undo → back
  {
    const boxB = app.doc.bodies.find((b) => b.name === "Box 1");
    if (!boxB || !app.doc.dimensions.length) {
      expect("dimension: the reopened file has Box 1 and its dimension", false, { names: app.doc.bodies.map((b) => b.name), dims: app.doc.dimensions });
      console.error("measure scenario failed: " + JSON.stringify(checks.filter((c) => !c.ok)));
      return [{ label: "measure tool", passed: checks.filter((c) => c.ok).length, total: checks.length, checks }];
    }
    expect("dimension: linked to the box after reopening", app.doc.dimensions[0].body === boxB.id, { dim: app.doc.dimensions[0], box: boxB.id });
    const endFace = boxB.shape.faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[0] > 0.99).hashCode;
    app.doc.replaceShapes(new Map([[boxB.id, K.pushPull(boxB.shape, endFace, 10)]]), "Push/Pull"); await sleep(20);
    const d1 = app.doc.dimensions[0], l1 = labels().join();
    app.doc.replaceShapes(new Map([[boxB.id, K.translateShape(app.doc.get(boxB.id).shape, [0, 30, 0])]]), "Move"); await sleep(20);
    const d2 = app.doc.dimensions[0], l2 = labels().join();
    const topFace = app.doc.get(boxB.id).shape.faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[2] > 0.99).hashCode;
    app.doc.replaceShapes(new Map([[boxB.id, K.pushPull(app.doc.get(boxB.id).shape, topFace, 5)]]), "Push/Pull"); await sleep(20);
    const d3 = app.doc.dimensions[0], l3 = labels().join();
    app.run("edit.undo"); app.run("edit.undo"); app.run("edit.undo"); await sleep(20);
    const d4 = app.doc.dimensions[0], l4 = labels().join();
    const ends = (d) => [d.a, d.b].map((p) => p.map((v) => +v.toFixed(3)).join(" ")).sort().join(" | ");
    expect("dimension: follows its edge — longer (50), moved (+30 Y), raised (top +5); undo puts it back", l1 === "50" && ends(d1) === "-20 -15 20 | 30 -15 20" && l2 === "50" && ends(d2) === "-20 15 20 | 30 15 20" && l3 === "50" && ends(d3) === "-20 15 25 | 30 15 25" && d3.body === boxB.id && l4 === "40" && ends(d4) === "-20 -15 20 | 20 -15 20",
      { l1, d1: ends(d1), l2, d2: ends(d2), l3, d3: ends(d3), l4, d4: ends(d4) });
  }
  // "Delete all dimensions" in the Measure panel: one undo step; disabled with none
  {
    app.run("tool.measure"); await sleep(20);
    const btn = () => document.querySelector("#measure-panel button[data-act=clear-dims]");
    const before = app.doc.dimensions.length, enabled = btn() && !btn().disabled;
    btn().click(); await sleep(20);
    const cleared = app.doc.dimensions.length === 0 && labels().length === 0 && btn()?.disabled;
    app.run("edit.undo"); await sleep(20); // (undo ends the tool, as for every tool)
    app.run("tool.measure"); await sleep(20);
    expect("dimension: Delete all in the Measure panel, undo brings them back", before >= 1 && enabled && cleared && app.doc.dimensions.length === before && labels().length === before && btn() && !btn().disabled,
      { before, enabled, cleared, after: app.doc.dimensions.length, disabled: btn() && btn().disabled });
    await key("Escape", "Escape");
  }
  // 2 clicks then Tab → a dimension of that length (not linked to an edge); the measurement is cleared once it's placed
  {
    app.run("tool.measure"); await sleep(20);
    const n0 = app.doc.dimensions.length;
    await click([-20, -15, 20]); await click([20, 15, 20]); await key("Tab", "Tab");
    // Place it 60 px beside the line on screen (from any view, well off the line)
    const sa = window.__see(new V(-20, -15, 20)), sb = window.__see(new V(20, 15, 20)), ll = Math.hypot(sb.x - sa.x, sb.y - sa.y) || 1;
    const at = { clientX: (sa.x + sb.x) / 2 - ((sb.y - sa.y) / ll) * 60, clientY: (sa.y + sb.y) / 2 + ((sb.x - sa.x) / ll) * 60, button: 0, bubbles: true };
    canvas.dispatchEvent(new PointerEvent("pointermove", at)); await sleep(20);
    const preview = document.querySelector("#dim-labels .dim-label.preview")?.textContent;
    canvas.dispatchEvent(new PointerEvent("pointerdown", at)); canvas.dispatchEvent(new PointerEvent("pointerup", at)); await sleep(20);
    const d = app.doc.dimensions[n0];
    const near = (p, q) => p.every((v, k) => Math.abs(v - q[k]) < 1e-6);
    expect("dimension: 2 clicks + Tab dimensions the measured length (50), then a new measurement", preview === "50" && app.doc.dimensions.length === n0 + 1 && d.body === undefined && near(d.a, [-20, -15, 20]) && near(d.b, [20, 15, 20]) && Math.hypot(...d.o) > 2 && labels().includes("50") && !/Length/.test(panel()),
      { preview, dims: app.doc.dimensions.length, d, labels: labels(), panel: panel() });
    app.run("edit.undo"); await sleep(20);
  }
  // 3 clicks then Tab → an angle dimension (90°); the arc goes through the mouse; the measurement is cleared once it's placed
  {
    app.run("tool.measure"); await sleep(20);
    const n0 = app.doc.dimensions.length;
    await click([-20, -15, 20]); await click([20, -15, 20]); await click([20, 15, 20]); await key("Tab", "Tab"); await hover([12, -7, 20]);
    const preview = document.querySelector("#dim-labels .dim-label.preview")?.textContent;
    await click([12, -7, 20]);
    const d = app.doc.dimensions[n0];
    const near = (p, q) => p.every((v, k) => Math.abs(v - q[k]) < 1e-6);
    expect("dimension: 3 clicks + Tab adds the angle (90°), its arc through the mouse", preview === "90°" && d && d.kind === "angle" && near(d.a, [-20, -15, 20]) && near(d.b, [20, -15, 20]) && near(d.c, [20, 15, 20]) && Math.abs(d.r - Math.hypot(8, 8)) < 1e-6 && labels().includes("90°") && !/Angle/.test(panel()),
      { preview, d, labels: labels(), panel: panel() });
    app.run("edit.undo"); await sleep(20);
  }
  // Tab over a circle → radius dimension "R 10", pointing where the mouse is; it follows the circle (resized, moved, pushed up)
  {
    app.run("tool.measure"); await sleep(20);
    const n0 = app.doc.dimensions.length;
    const cylB = app.doc.bodies.find((b) => b.name.startsWith("Cylinder"));
    const rim = (a, z, r = 10) => [60 + r * Math.cos(a), r * Math.sin(a), z];
    await hover(rim(-0.9, 30)); await key("Tab", "Tab"); await hover(rim(-1.6, 30, 25));
    const preview = document.querySelector("#dim-labels .dim-label.preview")?.textContent;
    await click(rim(-1.6, 30, 25));
    const d = app.doc.dimensions[n0];
    const near = (p, q) => p.every((v, k) => Math.abs(v - q[k]) < 1e-6);
    expect("dimension: Tab on a circle adds its radius (R 10), pointing at the mouse", preview === "R 10" && d && d.kind === "radius" && d.body === cylB.id && near(d.a, [60, 0, 30]) && near(d.b, rim(-1.6, 30)) && labels().includes("R 10"),
      { preview, d, labels: labels() });
    const lab = () => labels()[n0];
    app.doc.replaceShapes(new Map([[cylB.id, K.makeCylinder(G, [60, 0, 0], 12, 30)]]), "Resize"); await sleep(20);
    const l1 = lab(), d1 = app.doc.dimensions[n0];
    app.doc.replaceShapes(new Map([[cylB.id, K.translateShape(app.doc.get(cylB.id).shape, [0, 30, 0])]]), "Move"); await sleep(20);
    const l2 = lab(), d2 = app.doc.dimensions[n0];
    const top = app.doc.get(cylB.id).shape.faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[2] > 0.99).hashCode;
    app.doc.replaceShapes(new Map([[cylB.id, K.pushPull(app.doc.get(cylB.id).shape, top, 5)]]), "Push/Pull"); await sleep(20);
    const l3 = lab(), d3 = app.doc.dimensions[n0];
    app.run("edit.undo"); app.run("edit.undo"); app.run("edit.undo"); await sleep(20);
    const l4 = lab();
    expect("dimension: a radius follows its circle — resized (R 12), moved (+30 Y), raised (top +5); undo puts it back", l1 === "R 12" && near(d1.a, [60, 0, 30]) && near(d1.b, rim(-1.6, 30, 12)) && l2 === "R 12" && near(d2.a, [60, 30, 30]) && l3 === "R 12" && near(d3.a, [60, 30, 35]) && d3.body === cylB.id && l4 === "R 10",
      { l1, l2, l3, l4, d1, d2, d3 });
    app.run("edit.undo"); await sleep(20);
    expect("dimension: undo removes the radius", app.doc.dimensions.length === n0, app.doc.dimensions.length);
  }
  app.run("tool.measure"); await click([-20, -15, 20]); await click([20, -15, 20]); await click([20, 15, 20]); await hover([60 + 10 * Math.cos(-1.2), 10 * Math.sin(-1.2), 12]); // left on for the screenshot
  if (failed.length) console.error("measure scenario failed: " + JSON.stringify(failed));
  return [{ label: "measure tool", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Array copy (Shift+D on objects): a circle face on a box (like ~/untitled.yddd) → a row of copies, gap edge to edge. */
/** Text (T): flat letter faces — a capital H the height tall, from the baseline — one group; P pushes them all; upright on a wall. */
const SCENARIO_TEXT = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const key = (k, code, o = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true, ...o }));
  const opValue = (k, v) => { const i = document.querySelector("#op-panel [data-key=" + k + "]"); if (i) { i.value = String(v); i.dispatchEvent(new Event(i.tagName === "SELECT" ? "change" : "input", { bubbles: true })); } };
  const r = (n) => +n.toFixed(3);
  try {
    await K.loadTextFont();
    const T0 = { height: 10, align: "left", lineSpacing: 1 };
    const hi = K.makeTextFaces(G, [0, 0, 0], "Hi", T0), hb = hi[0].boundingBox.bounds;
    const o = K.makeTextFaces(G, [0, 0, 0], "o", T0), two = K.makeTextFaces(G, [0, 0, 0], "H\nH", T0);
    const ctr = K.makeTextFaces(G, [0, 0, 0], "H", { ...T0, align: "center" })[0].boundingBox.bounds;
    expect("text: \"Hi\" → 3 faces (H, the i's stem and dot), H from the baseline up 10 mm, flat; o has a hole; 2 lines → 2 faces; centred H about x 0; spaces → none",
      hi.length === 3 && Math.abs(hb[0][1]) < 0.01 && Math.abs(hb[1][1] - 10) < 0.01 && Math.abs(hb[0][2]) < 1e-6 && Math.abs(hb[1][2]) < 1e-6 &&
        o.length === 1 && o[0].wires.length === 2 && two.length === 2 && Math.abs(ctr[0][0] + ctr[1][0]) < 0.1 && K.makeTextFaces(G, [0, 0, 0], "  ", T0).length === 0,
      { n: hi.length, hb: hb.map((p) => p.map(r)), o: o.length && o[0].wires.length, two: two.length, ctr: ctr.map((p) => r(p[0])) });
    // Built-in fonts: Noto Serif Bold's H is 10 mm too; Thai in Noto Sans comes from Noto Sans Thai, Latin in Noto Sans Thai from Noto Sans
    const top = (fs) => Math.max(...fs.map((f) => f.boundingBox.bounds[1][1]));
    const serifH = K.makeTextFaces(G, [0, 0, 0], "H", { ...T0, font: "builtin:NotoSerif-Bold" });
    const latin = K.makeTextFaces(G, [0, 0, 0], "Bird", T0), mixed = K.makeTextFaces(G, [0, 0, 0], "Bird บ้าน", T0);
    const thaiAB = K.makeTextFaces(G, [0, 0, 0], "AB ก", { ...T0, font: "builtin:NotoSansThai-Regular" });
    const right = (fs) => Math.max(...fs.map((f) => f.boundingBox.bounds[1][0]));
    expect("text: built-in fonts — Noto Serif Bold H 10 mm; \"Bird บ้าน\" (Noto Sans) has its Thai letters too; \"AB ก\" in Noto Sans Thai has its A, B (from Noto Sans) and ก",
      serifH.length === 1 && Math.abs(top(serifH) - 10) < 0.01 && mixed.length >= latin.length + 4 && right(mixed) > right(latin) + 10 && thaiAB.length === 3 && K.BUILT_IN_FONTS.length === 6,
      { serif: serifH.length && r(top(serifH)), latin: latin.length, mixed: mixed.length, wMixed: r(right(mixed)), wLatin: r(right(latin)), thaiAB: thaiAB.length });
    // Letter spacing: each next letter that much further along; centred text stays centred
    const xs = (sp, align = "left") => K.makeTextFaces(G, [0, 0, 0], "HH", { ...T0, align, letterSpacing: sp }).map((f) => f.boundingBox.bounds);
    const h0 = xs(0), h2 = xs(2), hn = xs(-1), c2 = xs(2, "center");
    expect("text: letter spacing 2 mm → the 2nd H 2 mm further along (−1 → 1 mm closer), the 1st stays; centred: still about x 0",
      Math.abs(h2[1][0][0] - h0[1][0][0] - 2) < 1e-6 && Math.abs(hn[1][0][0] - h0[1][0][0] + 1) < 1e-6 && Math.abs(h2[0][0][0] - h0[0][0][0]) < 1e-6 && Math.abs(c2[0][0][0] + c2[1][1][0]) < 0.1,
      { h0: h0.map((b) => r(b[0][0])), h2: h2.map((b) => r(b[0][0])), hn: hn.map((b) => r(b[0][0])), c2: [r(c2[0][0][0]), r(c2[1][1][0])] });
    const see = (p) => window.__see(new (vp.camera.position.constructor)(p[0], p[1], p[2]));
    const tap = (p) => { const s = see(p); for (const t of ["pointermove", "pointerdown", "pointerup"]) vp.canvas.dispatchEvent(new PointerEvent(t, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
    const typeText = async (text) => {
      const ta = document.querySelector("#tool-panel textarea");
      if (!ta) return false;
      ta.value = text; ta.dispatchEvent(new Event("input", { bubbles: true }));
      ta.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); await sleep(50);
      return true;
    };
    app.doc.reset([]); vp.setView("top"); vp.fit(); await sleep(50);
    key("t", "KeyT"); await sleep(200);
    const tool = app.tool && app.tool.name;
    tap([0, 0, 0]); await sleep(50);
    const typed = await typeText("Hi");
    const made = app.doc.bodies, groups = [...new Set(made.map((b) => b.group))];
    expect("text: T, a click on the ground, \"Hi\" + Enter → 3 face objects in one new group named Text \"Hi\", all selected",
      tool === "Text" && typed && made.length === 3 && made.every((b) => b.kind === "face") && groups.join() === 'Text "Hi"' && app.selection.length === 3,
      { tool, typed, n: made.length, groups, sel: app.selection.length });
    key("p", "KeyP"); await sleep(50); opValue("d", 2); await sleep(300);
    // The drag preview: the letters drawn as prisms from their display meshes (instant) — as tall as the real ones
    const fast = app.op.spec.fastDrag({ d: 2 }), gl = [1e9, 1e9, 1e9], gh = [-1e9, -1e9, -1e9];
    vp.ghostRoot.traverse((m) => { if (!m.isMesh) return; m.geometry.computeBoundingBox(); const b = m.geometry.boundingBox; [b.min.x, b.min.y, b.min.z].forEach((x, k) => (gl[k] = Math.min(gl[k], x))); [b.max.x, b.max.y, b.max.z].forEach((x, k) => (gh[k] = Math.max(gh[k], x))); });
    const want = made.map((b) => b.shape.boundingBox.bounds);
    const span = (k, f, i) => f(...want.map((w) => w[i][k]));
    expect("text: P's drag preview for the 3 letters is instant (prisms, no kernel) and the size of the real solids (z 0 – 2)",
      fast && [0, 1].every((k) => Math.abs(gl[k] - span(k, Math.min, 0)) < 1e-3 && Math.abs(gh[k] - span(k, Math.max, 1)) < 1e-3) && Math.abs(gl[2]) < 1e-3 && Math.abs(gh[2] - 2) < 1e-3,
      { fast, gl: gl.map(r), gh: gh.map(r) });
    app.applyOp(); await sleep(50);
    const solids = app.doc.bodies, zs = solids.map((b) => b.shape.boundingBox.bounds.map((p) => r(p[2])).join(" "));
    expect("text: P pushes all 3 letters 2 mm up → 3 valid solids (z 0 – 2), still in Text \"Hi\"",
      solids.length === 3 && solids.every((b) => b.kind === "solid" && b.group === 'Text "Hi"' && K.isValidShape(b.shape)) && zs.every((z) => z === "0 2"),
      { n: solids.length, kinds: solids.map((b) => b.kind), groups: solids.map((b) => b.group), zs });
    // Font: DejaVu Sans Bold from the system's fonts → the text redrawn in it (wider H), remembered for the next text
    app.setSelection([]); key("t", "KeyT"); await sleep(200); tap([0, 80, 0]); await sleep(50);
    const pick = async (k, label) => { const sel = document.querySelector("#tool-panel [data-k=" + k + "]"); const o = sel && [...sel.options].find((x) => x.textContent === label); if (o) { sel.value = o.value; sel.dispatchEvent(new Event("change", { bubbles: true })); } await sleep(300); return !!o; };
    const fams = document.querySelectorAll("#tool-panel [data-k=family] option").length;
    const picked = (await pick("family", "DejaVu Sans")) && (await pick("font", "Bold"));
    const font = app.tool && app.tool.constructor.settings.font;
    await typeText("H");
    const dv = app.doc.bodies.at(-1).shape.boundingBox.bounds, dvW = dv[1][0] - dv[0][0], nW = hb[1][0] - hb[0][0];
    app.setSelection([]); key("t", "KeyT"); await sleep(200); tap([0, 120, 0]); await sleep(50);
    const kept = [document.querySelector("#tool-panel [data-k=family]").value, document.querySelector("#tool-panel [data-k=font]").selectedOptions[0]?.textContent].join(" ");
    await pick("family", "Noto Sans (built in)"); key("Escape", "Escape"); await sleep(20);
    expect("text font: DejaVu Sans Bold chosen from the system's fonts → the H made in it (wider than Noto Sans', still 10 mm tall); the next text starts with it",
      fams > 10 && picked && /DejaVuSans-Bold\.ttf$/.test(font) && dvW > nW + 0.5 && Math.abs(dv[1][1] - 80 - 10) < 0.01 && kept === "DejaVu Sans Bold",
      { fams, picked, font, dvW: r(dvW), nW: r(nW), top: r(dv[1][1]), kept });
    // A long text: the name cut short; the same words again: a number after it
    const nameOf = async (text) => { app.setSelection([]); key("t", "KeyT"); await sleep(200); tap([0, 40, 0]); await sleep(50); await typeText(text); return app.doc.bodies.at(-1).group; };
    const long = await nameOf("I love my cat\nand my dog"), again = await nameOf("I love my cat\nand my dog");
    expect("text: group names — a long text cut short (lines joined), the same words again → a 2 after it",
      long === 'Text "I love my cat a…"' && again === 'Text "I love my cat a…" 2', { long, again });
    // S on a text group: only the ring and one Scale % (no X / Y / Z stretching) — evenly, so the letters keep their shape
    app.setSelection(app.doc.bodies.filter((b) => b.group === 'Text "Hi"').map((b) => ({ kind: "body", body: b.id, id: 0 })));
    const before = app.doc.bodies.filter((b) => b.group === 'Text "Hi"').map((b) => b.shape.boundingBox.bounds);
    key("s", "KeyS"); await sleep(50);
    const keys = [...document.querySelectorAll("#op-panel [data-key]")].map((i) => i.dataset.key).join();
    const drags = [].concat(app.op.spec.drag || []).map((d) => d.look).join();
    opValue("s", 200); await sleep(200); app.applyOp(); await sleep(50);
    const after = app.doc.bodies.filter((b) => b.group === 'Text "Hi"').map((b) => b.shape.boundingBox.bounds);
    const ext = (bs, k) => Math.max(...bs.map((b) => b[1][k])) - Math.min(...bs.map((b) => b[0][k]));
    expect("text: S on a text group → only Scale % and the ring (no X / Y / Z); 200% → twice as wide, tall and thick",
      keys === "s,center" && drags === "ring" && [0, 1, 2].every((k) => Math.abs(ext(after, k) - 2 * ext(before, k)) < 1e-3),
      { keys, drags, before: [0, 1, 2].map((k) => r(ext(before, k))), after: [0, 1, 2].map((k) => r(ext(after, k))) });
    // Edit (T with a letter selected): the pushed (2 mm) and scaled (200%) "Hi" — the panel as made, 20 mm tall
    // now; "Hey" → 3 new solids where it was, as thick (4 mm), the group renamed; one undo brings "Hi" back
    const hiNow = app.doc.bodies.filter((b) => b.group === 'Text "Hi"'), hiBox = hiNow.map((b) => b.shape.boundingBox.bounds);
    // (T with it selected starts a new text — editing is the pencil by its group in the Bodies panel)
    app.setSelection([{ kind: "body", body: hiNow[0].id, id: 0 }]);
    key("t", "KeyT"); await sleep(200);
    const tNew = app.tool && app.tool.name === "Text" && !app.tool.placed && !document.querySelector("#tool-panel");
    key("Escape", "Escape"); await sleep(20);
    const pen = [...document.querySelectorAll(".ol-group")].find((g) => g.dataset.group === 'Text "Hi"')?.querySelector(".ol-edit");
    pen?.click(); await sleep(300);
    const title = document.querySelector("#tool-panel h4")?.textContent, shown = document.querySelector("#tool-panel textarea")?.value;
    const hShown = document.querySelector("#tool-panel [data-k=height]")?.value;
    await typeText("Hey");
    const hey = app.doc.bodies.filter((b) => b.group === 'Text "Hey"'), heyBox = hey.map((b) => b.shape.boundingBox.bounds);
    const near = (a, b) => Math.abs(a - b) < 1e-3;
    expect("text edit: T with a text selected starts a new one; the pencil by its group (pushed, scaled) → \"Edit text\" with \"Hi\", 20 mm; \"Hey\" → 3 solids in its place (H where the H was, z 0 – 4), group Text \"Hey\"",
      tNew && !!pen && title === "Edit text" && shown === "Hi" && hShown === "20" && hey.length === 3 && hey.every((b) => b.kind === "solid" && K.isValidShape(b.shape) && b.text && b.text.text === "Hey") &&
        !app.doc.bodies.some((b) => b.group === 'Text "Hi"') && [0, 1, 2].every((k) => near(heyBox[0][0][k], hiBox[0][0][k]) && near(heyBox[0][1][k], hiBox[0][1][k])) && heyBox.every((b) => near(b[0][2], 0) && near(b[1][2], 4)),
      { tNew, pen: !!pen, title, shown, hShown, n: hey.length, H: heyBox[0] && heyBox[0].map((p) => p.map(r)), was: hiBox[0].map((p) => p.map(r)) });
    app.run("edit.undo"); await sleep(20);
    const back = app.doc.bodies.filter((b) => b.group === 'Text "Hi"').length, heyLeft = app.doc.bodies.filter((b) => b.group === 'Text "Hey"').length;
    expect("text edit: one undo → the \"Hi\" letters back", back === 3 && heyLeft === 0, { back, heyLeft });
    // Flat text turned 30° about Z and moved, then saved and opened again: T finds it where it is; "HI" → its H on the old H
    {
      app.doc.reset([]);
      const rec = { text: "Hi", font: "", height: 8, align: "left", letterSpacing: 0, lineSpacing: 1, frame: { ...G, origin: [0, 0, 0] } };
      const moved = K.makeTextFaces(G, [0, 0, 0], "Hi", rec).map((f) => K.translateShape(K.rotateShape(f, 30, [0, 0, 0], [0, 0, 1]), [15, -7, 3]));
      app.doc.commit(moved.map((f) => ({ ...app.doc.makeBody(f, "Text", "face"), group: 'Text "Hi"', text: rec })), "turned text");
      app.loadModel(app.modelText(), null); await sleep(50);
      const H0 = app.doc.bodies[0].shape.boundingBox.bounds;
      await sleep(100);
      [...document.querySelectorAll(".ol-group")].find((g) => g.dataset.group === 'Text "Hi"')?.querySelector(".ol-edit")?.click(); await sleep(300);
      await typeText("HI");
      const now = app.doc.bodies, H1 = now[0] && now[0].shape.boundingBox.bounds, rc = now[0] && now[0].text;
      expect("text edit: turned 30° + moved, saved and reopened → the pencil edits it in place (\"HI\": its H exactly on the old H, flat, still facing up; the record turned too)",
        now.length === 2 && now.every((b) => b.kind === "face") && [0, 1, 2].every((k) => near(H1[0][k], H0[0][k]) && near(H1[1][k], H0[1][k])) && near(rc.frame.x[0], Math.cos(Math.PI / 6)) && near(rc.frame.z[2], 1) && now[0].shape.normalAt().toTuple()[2] > 0.999,
        { n: now.length, H1: H1 && H1.map((p) => p.map(r)), H0: H0.map((p) => p.map(r)), x: rc && rc.frame.x.map(r) });
    }
    // The pencil goes grey (saying why) once a letter is cut in two; undo → usable again
    {
      app.doc.reset([]);
      const rec = { text: "Hi", font: "", height: 8, align: "left", letterSpacing: 0, lineSpacing: 1, frame: { ...G, origin: [0, 0, 0] } };
      const letters = K.makeTextFaces(G, [0, 0, 0], "Hi", rec).map((f) => K.extrudeFace(f, f.faces[0].hashCode, 2));
      app.doc.commit(letters.map((sh) => ({ ...app.doc.makeBody(sh, "Text", "solid"), group: 'Text "Hi"', text: rec })), "pushed text"); await sleep(400);
      const pen = () => [...document.querySelectorAll(".ol-group")].find((g) => g.dataset.group === 'Text "Hi"')?.querySelector(".ol-edit");
      const okBefore = pen() && !pen().classList.contains("off");
      const h = app.doc.bodies[0], cut = K.splitByPlane(h.shape, [2, 0, 0], [1, 0, 0]);
      app.doc.commit([{ ...h, shape: cut.above }, { ...app.doc.makeBody(cut.below, "Text", "solid"), group: h.group, text: h.text }, ...app.doc.bodies.slice(1)], "cut H"); await sleep(400);
      const offAfter = pen()?.classList.contains("off"), why = pen()?.title;
      app.run("edit.undo"); await sleep(400);
      const okAgain = pen() && !pen().classList.contains("off");
      expect("text edit: the pencil is usable on a pushed text; its H cut in two → grey, saying the letters were changed; undo → usable again",
        okBefore && offAfter && /changed/.test(why || "") && okAgain, { okBefore, offAfter, why, okAgain });
    }
    // Macro → Box from Face: a 60 × 40 rectangle is the inside of an open box (wall 2 out, bottom 3 down, inside depth 20);
    // round edges R 5 (outside R 7); a circle → a cup; on a solid's top face → a new box from it; radius too big → an error, nothing made
    {
      const vol = (b) => K.solidVolume(b.shape);
      const boxOn = async (body, faceSel, v) => {
        app.setSelection([faceSel]); app.run("macro.box"); await sleep(50);
        for (const [k, x] of Object.entries(v)) { const i = document.querySelector("#op-panel [data-key=" + k + "]"); if (!i) continue; if (i.type === "checkbox") i.checked = !!x; else i.value = String(x); i.dispatchEvent(new Event(i.type === "checkbox" ? "change" : "input", { bubbles: true })); }
        await sleep(300);
        const err = document.querySelector("#op-panel .op-error")?.textContent || "";
        app.applyOp(); await sleep(50);
        return err;
      };
      app.doc.reset([]);
      const rect = app.doc.makeBody(K.makeRectFace(G, [0, 0, 0], 60, 40), "Rectangle", "face");
      app.doc.commit([rect], "rect"); app.run("mode.body");
      await boxOn(rect, { kind: "body", body: rect.id, id: 0 }, { wall: 2, bottom: 3, height: 20, round: 0 });
      const b1 = app.doc.bodies[0], v1 = b1 && b1.kind === "solid" ? vol(b1) : 0, bb1 = b1.shape.boundingBox.bounds;
      app.run("edit.undo"); await sleep(20);
      await boxOn(rect, { kind: "body", body: rect.id, id: 0 }, { wall: 2, bottom: 3, height: 20, round: 1, radius: 5 });
      // inside: 60×40 with R 5 corners; outside: that grown 2 (perimeter × 2 + π·2²)
      const inA = 2400 - (4 - Math.PI) * 25, inP = 200 - 8 * 5 + 2 * Math.PI * 5;
      const v2 = vol(app.doc.bodies[0]), want2 = (inA + inP * 2 + Math.PI * 4) * 23 - inA * 20;
      app.doc.reset([]);
      const circ = app.doc.makeBody(K.makeCircleFace(G, [0, 0, 0], 20), "Circle", "face"), blk = app.doc.makeBody(K.makeBox(G, [100, 0, 0], 50, 50, 10), "Block");
      app.doc.commit([circ, blk], "circle, block");
      await boxOn(circ, { kind: "body", body: circ.id, id: 0 }, { wall: 2, bottom: 3, height: 20, round: 0 });
      const cup = app.doc.bodies.find((b) => b.id !== blk.id), v3 = vol(cup);
      const top = blk.shape.faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[2] > 0.99);
      await boxOn(blk, { kind: "face", body: blk.id, id: top.hashCode }, { wall: 2, bottom: 3, height: 20, round: 0 });
      const onTop = app.doc.bodies.at(-1), bt = onTop.shape.boundingBox.bounds;
      const n0 = app.doc.bodies.length;
      const err = await boxOn(blk, { kind: "face", body: blk.id, id: top.hashCode }, { wall: 2, bottom: 3, height: 20, round: 1, radius: 30 });
      if (app.op) app.cancelOp && app.cancelOp();
      const nAfter = app.doc.bodies.length;
      // Nothing selected: the panel opens at once and waits; a click on a face object picks it
      app.doc.reset([]);
      const rect2 = app.doc.makeBody(K.makeRectFace(G, [0, 0, 0], 60, 40), "Rectangle", "face");
      app.doc.commit([rect2], "rect"); vp.setView("iso"); vp.fit(); await sleep(50);
      app.setSelection([]); app.run("macro.box"); await sleep(300);
      const waitMsg = document.querySelector("#op-panel .op-error.waiting")?.textContent || "", opened = !!app.op;
      const sc = window.__see(new (vp.camera.position.constructor)(5, 5, 0));
      app.op && app.op.spec.pick(new PointerEvent("pointerdown", { clientX: sc.x, clientY: sc.y, button: 0 })); await sleep(300);
      const note = document.querySelector("#op-panel .op-note")?.textContent || "";
      app.applyOp(); await sleep(50);
      const picked = app.doc.bodies.length === 1 && app.doc.bodies[0].kind === "solid" && Math.abs(K.solidVolume(app.doc.bodies[0].shape) - (64 * 44 * 23 - 48000)) < 1e-3;
      expect("macro box: nothing selected → the panel opens and waits (\"click a flat face\"); a click on the rectangle picks it → its box",
        opened && /click a flat face/i.test(waitMsg) && /Rectangle/.test(note) && picked, { opened, waitMsg, note, picked });
      // Other outlines (kernel): a hexagon (sharp: walls of even thickness, sharp outside corners; R 3: round), an oval
      // (a circle stretched 1.5× in X: freeform curves), a ring face (a hole in it → a tube up the middle)
      const opt = { wall: 2, bottom: 3, height: 20, radius: 0 }, ok = (sh) => sh && K.isValidShape(sh);
      const hex = K.makePolygonFace(G, [0, 0, 0], 20, 6, 0), hexBox = K.boxFromFace(hex, hex.faces[0].hashCode, opt);
      const ap = 20 * Math.sqrt(3) / 2, hexWant = 2 * Math.sqrt(3) * ((ap + 2) ** 2 * 23 - ap ** 2 * 20);
      const hexRound = K.boxFromFace(hex, hex.faces[0].hashCode, { ...opt, radius: 3 });
      const oval = K.scaleShape(K.makeCircleFace(G, [0, 0, 0], 20), [1.5, 1, 1], [0, 0, 0]), ovalBox = K.boxFromFace(oval, oval.faces[0].hashCode, opt);
      const oa = 30, ob = 20, oh = ((oa - ob) / (oa + ob)) ** 2, oP = Math.PI * (oa + ob) * (1 + 3 * oh / (10 + Math.sqrt(4 - 3 * oh))), oA = K.solidVolume(K.extrudeFace(oval, oval.faces[0].hashCode, 1)); // (its real area: the stretch is a close B-spline, not an exact ellipse)
      const ovalWant = (oA + oP * 2 + Math.PI * 4) * 23 - oA * 20;
      const disk = K.makeCircleFace(G, [0, 0, 0], 20), ring = K.offsetRing(disk, disk.faces[0].hashCode, -12)[0];
      const ringBox = ring && K.boxFromFace(ring, ring.faces[0].hashCode, opt), ringWant = Math.PI * ((22 ** 2 - 6 ** 2) * 23 - (20 ** 2 - 8 ** 2) * 20);
      const vols = { hex: r(K.solidVolume(hexBox)), hexWant: r(hexWant), hexRound: ok(hexRound) && r(K.solidVolume(hexRound)), oval: r(K.solidVolume(ovalBox)), ovalWant: r(ovalWant), ring: ringBox && r(K.solidVolume(ringBox)), ringWant: r(ringWant) };
      expect("macro box: a hexagon (exact; R 3 round: valid, a little less), an oval (freeform outline: valid, within 1% of an ellipse\'s estimate) and a ring face (a tube up the middle, exact) all make valid boxes",
        ok(hexBox) && Math.abs(vols.hex - hexWant) < 1e-2 && vols.hexRound > 0 && vols.hexRound < vols.hex && ok(ovalBox) && Math.abs(vols.oval - ovalWant) < 1e-2 * ovalWant && ok(ringBox) && Math.abs(vols.ring - ringWant) < 0.05,
        vols);
      const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;
      const bx = [0, 1, 2].map((k) => r(bb1[1][k] - bb1[0][k])).join(" × ");
      expect("macro box: 60×40 rect = the inside → 64 × 44 × 23 outside (z −3 – 20), vol 64·44·23 − 60·40·20; R 5 → exact; circle R 20 → cup R 22; on a block's top (z 10) → z 7 – 30; radius 30 → error, nothing made",
        b1.kind === "solid" && K.isValidShape(b1.shape) && near(v1, 64 * 44 * 23 - 48000) && bx === "64 × 44 × 23" && near(bb1[0][2], -3) && near(bb1[1][2], 20) && near(v2, want2, 0.05) && near(v3, Math.PI * (484 * 23 - 400 * 20), 0.05) &&
          nAfter === n0 && near(bt[0][2], 7) && near(bt[1][2], 30) && onTop.id !== blk.id && /radius/i.test(err),
        { v1: r(v1), bx, v2: r(v2), want2: r(want2), v3: r(v3), want3: r(Math.PI * (484 * 23 - 400 * 20)), bt: bt.map((p) => r(p[2])), err, n: nAfter, n0 });
    }
    // Macro → Box Lid: for a 60 × 40 (inside) box, wall 2, rim at z 20 — Inside Lip (plate 64 × 44 × 2 on the rim, a
    // lip 3 deep, 1.5 wall, 0.2 clearance); Over the Box (cap: skirt 5 deep, 1.5 wall, 0.2 off the outside); waits for the box
    {
      app.doc.reset([]);
      const rectF = K.makeRectFace(G, [0, 0, 0], 60, 40);
      const box = app.doc.makeBody(K.boxFromFace(rectF, rectF.faces[0].hashCode, { wall: 2, bottom: 3, height: 20, radius: 0 }), "Box");
      const block = app.doc.makeBody(K.makeBox(G, [100, 0, 0], 20, 20, 10), "Block");
      app.doc.commit([box, block], "box"); vp.setView("iso"); vp.fit(); await sleep(50);
      const set = (v) => { for (const [k, x] of Object.entries(v)) { const i = document.querySelector("#op-panel [data-key=" + k + "]"); if (i) { i.value = String(x); i.dispatchEvent(new Event("input", { bubbles: true })); } } };
      app.setSelection([]); app.run("macro.lidIn"); await sleep(300);
      const waiting = document.querySelector("#op-panel .op-error.waiting")?.textContent || "";
      app.op.spec.pickBody(block.id); await sleep(50);
      const stillWaiting = !!document.querySelector("#op-panel .op-error.waiting");
      app.op.spec.pickBody(box.id); await sleep(50);
      const note = document.querySelector("#op-panel .op-note")?.textContent || "";
      set({ thickness: 2, depth: 3, wall: 1.5, clearance: 0.2 }); await sleep(300);
      const inErr = document.querySelector("#op-panel .op-error")?.textContent || "";
      app.applyOp(); await sleep(50);
      const lidIn = app.doc.bodies.at(-1), inV = K.solidVolume(lidIn.shape), inZ = lidIn.shape.boundingBox.bounds.map((p) => r(p[2]));
      const inOverlap = K.solidVolume(K.booleanOp("intersect", lidIn.shape, [box.shape]));
      app.setSelection([{ kind: "body", body: box.id, id: 0 }]); app.run("macro.lidOver"); await sleep(50);
      set({ thickness: 2, depth: 5, wall: 1.5, clearance: 0.2 }); await sleep(300); app.applyOp(); await sleep(50);
      const lidOver = app.doc.bodies.at(-1), ovV = K.solidVolume(lidOver.shape), ovB = lidOver.shape.boundingBox.bounds;
      const ovOverlap = K.solidVolume(K.booleanOp("intersect", lidOver.shape, [box.shape]));
      const flat = K.solidVolume(K.boxLid(box.shape, { over: false, thickness: 2, lipDepth: 0, lipWall: 1.5, clearance: 0 }));
      // Rounded (R 5) and oval boxes: both lid types valid and clear of the box
      const rounded = K.boxFromFace(rectF, rectF.faces[0].hashCode, { wall: 2, bottom: 3, height: 20, radius: 5 });
      const ovalF = K.scaleShape(K.makeCircleFace(G, [0, 0, 0], 20), [1.5, 1, 1], [0, 0, 0]), ovalBox = K.boxFromFace(ovalF, ovalF.faces[0].hashCode, { wall: 2, bottom: 3, height: 20, radius: 0 });
      const others = [rounded, ovalBox].flatMap((bx) => [false, true].map((over) => {
        try { const l = K.boxLid(bx, { over, thickness: 2, lipDepth: 4, lipWall: 1.5, clearance: 0.2 }); return K.isValidShape(l) && K.solidVolume(K.booleanOp("intersect", l, [bx])) < 1e-6; } catch (e) { return String(e); }
      }));
      const wantIn = 64 * 44 * 2 + (59.6 * 39.6 - 56.6 * 36.6) * 3, wantOver = 67.4 * 47.4 * 2 + (67.4 * 47.4 - 64.4 * 44.4) * 5;
      const ovSize = [0, 1, 2].map((k) => r(ovB[1][k] - ovB[0][k])).join(" × ");
      expect("box lid: waits for the box (a plain block refused); inside lip → plate + lip (exact, z 17 – 22, not into the box); over the box → 67.4 × 47.4 × 7 cap (exact, z 15 – 22, not into the box); lip depth 0 → a flat plate; rounded and oval boxes: both types valid, clear of the box",
        /click the open-top box/i.test(waiting) && stillWaiting && /Box/.test(note) && lidIn.kind === "solid" && K.isValidShape(lidIn.shape) && Math.abs(inV - wantIn) < 1e-3 && inZ.join() === "17,22" && inOverlap < 1e-6 &&
          K.isValidShape(lidOver.shape) && Math.abs(ovV - wantOver) < 1e-3 && ovSize === "67.4 × 47.4 × 7" && Math.abs(ovB[0][2] - 15) < 1e-6 && ovOverlap < 1e-6 && Math.abs(flat - 64 * 44 * 2) < 1e-3 && others.every((x) => x === true),
        { others, waiting, stillWaiting, note, inErr, inV: r(inV), wantIn: r(wantIn), inZ, inOverlap, ovV: r(ovV), wantOver: r(wantOver), ovSize, ovOverlap, flat: r(flat) });
    }
    // The background kernel (a second OpenCascade in a worker): loaded; a fillet there = the same fillet here (edges
    // picked by place in the edge list); the app stays live while a heavy one runs; Esc stops it, the model unchanged
    {
      for (let i = 0; i < 300 && !app.bgKernel.ready; i++) await sleep(50);
      const ready = app.bgKernel.ready;
      const blk = K.makeBox(G, [0, 0, 0], 30, 20, 4), all = blk.edges.map((e) => e.hashCode), pick = [0, 3, 7];
      const here = K.roundSome("fillet", blk, new Set(pick.map((i) => all[i])), 5);
      const there = await app.bgKernel.run({ op: "round", kind: "fillet", brep: K.serializeShape(blk), edges: pick, size: 5 });
      const thereShape = K.deserialize(there.brep);
      const same = Math.abs(K.solidVolume(thereShape) - K.solidVolume(here.shape)) < 1e-6 && there.skipped.length === here.skipped.length && there.asked === here.asked;
      // A heavy one: a plate with 49 round holes, every edge R 0.4 — the longest gap between this thread's timer ticks meanwhile
      let plate = K.makeBox(G, [0, 0, 0], 140, 140, 6);
      const holes = []; for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) holes.push(K.makeCylinder(G, [-60 + 20 * i, -60 + 20 * j, 0], 4, 6));
      plate = K.booleanOp("subtract", plate, holes);
      app.doc.reset([]);
      const pb = app.doc.makeBody(plate, "Holes"); app.doc.commit([pb], "plate"); vp.fit(); app.run("mode.body"); await sleep(100);
      const t0 = performance.now(); let last = t0, gap = 0, ticks = 0;
      const tick = setInterval(() => { const t = performance.now(); gap = Math.max(gap, t - last); last = t; ticks++; }, 10);
      app.setSelection([{ kind: "body", body: pb.id, id: 0 }]); app.run("op.fillet"); await sleep(30);
      opValue("r", 0.4); await sleep(100);
      const working = document.querySelector("#op-panel .op-error.waiting")?.textContent || "";
      for (let i = 0; i < 300 && (app.op?.job || app.op?.wanted); i++) await sleep(20);
      const took = performance.now() - t0;
      clearInterval(tick);
      const shown = !!(app.op && app.op.result);
      // its display mesh came from the background kernel: every face / edge group names one of this shape's faces / edges
      const res0 = app.op && app.op.result && [...app.op.result.ghost.values()][0], tm = res0 && K.tessellate(res0);
      const fIds = res0 ? new Set(res0.faces.map((f) => f.hashCode)) : new Set(), eIds = res0 ? new Set(res0.edges.map((e) => e.hashCode)) : new Set();
      const idsOk = !!tm && tm.faces.faceGroups.length === fIds.size && tm.faces.faceGroups.every((g) => fIds.has(g.faceId)) && tm.edges.edgeGroups.every((g) => eIds.has(g.edgeId));
      // Esc while it works: stopped, panel closed, the model as it was; the background kernel back after
      opValue("r", 0.6);
      for (let i = 0; i < 50 && !app.op?.job; i++) await sleep(20);
      const busy = !!app.op?.job;
      key("Escape", "Escape"); await sleep(50);
      const closed = !app.op, unchanged = app.doc.bodies.length === 1 && app.doc.bodies[0].shape === plate;
      for (let i = 0; i < 300 && !app.bgKernel.ready; i++) await sleep(50);
      expect("background kernel: loaded; its fillet = this one (3 edges by place); a heavy fillet (49 holes) shown — meshed there too, its faces / edges this shape's — this thread never stalling 150 ms; Esc stops it (model unchanged), it comes back",
        ready && same && /Working/.test(working) && shown && idsOk && gap < 150 && busy && closed && unchanged && app.bgKernel.ready,
        { ready, same, working, took: Math.round(took), gap: Math.round(gap), ticks, shown, idsOk, busy, closed, unchanged, readyAgain: app.bgKernel.ready });
    }
    // Background kernel, more: Shell through the panel; a heavy Subtract (7 solids: the busy dialog, with Stop) = the same
    // here; Esc stops one (nothing changes); exports written there = the same files; a STEP read there = the same solid
    {
      for (let i = 0; i < 300 && !app.bgKernel.ready; i++) await sleep(50);
      const settle = async () => { for (let i = 0; i < 300 && (app.op?.job || app.op?.wanted); i++) await sleep(20); };
      app.doc.reset([]);
      const cube = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 20, 20, 20), "Cube");
      app.doc.commit([cube], "cube"); vp.fit(); app.run("mode.face");
      const topF = cube.shape.faces.find((f) => f.geomType === "PLANE" && f.normalAt().toTuple()[2] > 0.99).hashCode;
      app.setSelection([{ kind: "face", body: cube.id, id: topF }]); app.run("op.shell"); await sleep(30);
      opValue("t", 2); await sleep(150); await settle();
      app.applyOp(); await sleep(100);
      const shellV = K.solidVolume(app.doc.bodies[0].shape);
      // heavy Subtract: a block and 6 pegs
      app.doc.reset([]); app.run("mode.body");
      const mk = () => { const blk = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 70, 20, 10), "Block"); const pegs = [0, 1, 2, 3, 4, 5].map((i) => app.doc.makeBody(K.makeCylinder(G, [-25 + 10 * i, 0, 0], 3, 10), "Peg")); return [blk, ...pegs]; };
      let parts = mk(); app.doc.commit(parts, "pegs");
      const want = K.solidVolume(K.booleanOp("subtract", parts[0].shape, parts.slice(1).map((b) => b.shape)));
      app.setSelection(parts.map((b) => ({ kind: "body", body: b.id, id: 0 })));
      app.run("bool.subtract");
      const stopBtn = !!document.querySelector("#busy .busy-stop");
      for (let i = 0; i < 300 && document.getElementById("busy"); i++) await sleep(20);
      const subV = app.doc.bodies.length === 1 ? K.solidVolume(app.doc.bodies[0].shape) : -1;
      // again, Esc right away: stopped, the 7 solids as they were
      app.doc.reset([]); parts = mk(); app.doc.commit(parts, "pegs");
      app.setSelection(parts.map((b) => ({ kind: "body", body: b.id, id: 0 })));
      app.run("bool.subtract");
      key("Escape", "Escape");
      for (let i = 0; i < 300 && document.getElementById("busy"); i++) await sleep(20);
      const stoppedKept = app.doc.bodies.length === 7;
      for (let i = 0; i < 300 && !app.bgKernel.ready; i++) await sleep(50);
      // exports there = here; a STEP read there = the solid
      const q = { tolerance: 0.02, angle: 8 }, solid = parts[0].shape;
      const stlHere = new Uint8Array(await K.exportStl([solid], q)), stlThere = (await app.bgKernel.run({ op: "exportStl", items: [{ brep: K.serializeShape(solid) }], quality: q })).data;
      const mfHere = await K.write3mf([{ name: "Block", mesh: K.meshForExport(solid, q) }]), mfThere = (await app.bgKernel.run({ op: "export3mf", items: [{ brep: K.serializeShape(solid), name: "Block" }], quality: q })).data;
      const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
      const step = (await app.bgKernel.run({ op: "exportStep", items: [{ brep: K.serializeShape(solid), name: "Block" }] })).data;
      const back = (await app.bgKernel.run({ op: "importStep", data: step })).solids;
      const backV = back.length === 1 ? K.solidVolume(K.deserialize(back[0].brep)) : -1;
      expect("background kernel: Shell (top open, 2) through the panel = 20³ − 16²·18; a 7-solid Subtract there (busy dialog with Stop) = here; Esc stops one, the 7 kept; STL / 3MF there = here byte for byte; its STEP read back = the solid",
        Math.abs(shellV - (8000 - 16 * 16 * 18)) < 1e-6 && stopBtn && Math.abs(subV - want) < 1e-6 && stoppedKept && same(stlHere, stlThere) && same(mfHere, mfThere) && Math.abs(backV - K.solidVolume(solid)) < 1e-6,
        { shellV: r(shellV), stopBtn, subV: r(subV), want: r(want), stoppedKept, stl: [stlHere.length, stlThere.length], mf: [mfHere.length, mfThere.length], backV: r(backV) });
    }
    // Fillet that can't do every edge: a 40 × 40 × 4 plate, all edges R 5 → its 4 corners rounded, the 8 edges round
    // the 4 mm faces left sharp, the panel says so (orange) and offers the largest R that does all; that button → no
    // warning, every edge rounded. One edge that can't be done at all → an error naming the largest that works.
    {
      app.doc.reset([]);
      const plate = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 40, 40, 4), "Plate");
      app.doc.commit([plate], "plate"); app.run("mode.body");
      app.setSelection([{ kind: "body", body: plate.id, id: 0 }]);
      app.run("op.fillet"); await sleep(50);
      opValue("r", 5); await sleep(150);
      for (let i = 0; i < 100 && (app.op?.job || app.op?.wanted); i++) await sleep(50); // (worked out in the background kernel)
      const msg = document.querySelector("#op-panel .op-error"), warn = msg?.classList.contains("warn"), text = msg?.textContent || "";
      const useBtn = document.querySelector("#op-panel .op-warn-act"), useLabel = useBtn?.textContent || "";
      const partial = app.op && app.op.result && [...app.op.result.ghost.values()][0];
      const partialCyl = partial ? partial.faces.filter((f) => f.geomType === "CYLINDRE").length : -1;
      useBtn?.click(); await sleep(150);
      for (let i = 0; i < 100 && (app.op?.job || app.op?.wanted); i++) await sleep(50);
      const r2 = Number(document.querySelector("#op-panel [data-key=r]")?.value), after = document.querySelector("#op-panel .op-error")?.textContent || "";
      app.applyOp(); await sleep(50);
      const done = app.doc.bodies[0].shape, plain = done.faces.filter((f) => f.geomType === "PLANE").length;
      expect("fillet: a 4 mm plate, all edges R 5 → corners rounded, 8 edges left sharp, an orange note + \"Use R …\"; that → all 12 rounded (6 flat faces left), applied",
        warn && /8 of 12 edges can't be rounded at R 5/.test(text) && /^Use R /.test(useLabel) && partialCyl === 4 && r2 > 1 && r2 < 2.01 && after === "" && K.isValidShape(done) && plain === 6,
        { warn, text, useLabel, partialCyl, r2, after, plain });
      const cube = K.makeBox(G, [0, 0, 0], 10, 10, 10), e0 = cube.edges[0].hashCode;
      let err = ""; try { K.roundSome("fillet", cube, new Set([e0]), 12); } catch (e) { err = String(e); }
      expect("fillet: one cube edge at R 12 → an error saying the largest that works", /can't round this edge at 12 mm — the largest that works is about 9\.\d/.test(err), err);
    }
    // Export 3MF: each body an indexed mesh, closed (every edge in exactly 2 triangles, opposite ways) with the solid's
    // volume; the file a valid ZIP (names, CRCs) holding one named object per body in mm — a solid and an STL mesh
    {
      const plate = K.booleanOp("subtract", K.makeBox(G, [0, 0, 0], 30, 20, 5), [K.makeCylinder(G, [5, 0, 0], 4, 5)]);
      const q = { tolerance: 0.02, angle: 8 };
      const closed = (m) => {
        const dir = new Map();
        const T = m.triangles;
        for (let k = 0; k < T.length; k += 3) for (const [a, b] of [[T[k], T[k + 1]], [T[k + 1], T[k + 2]], [T[k + 2], T[k]]]) { const key = a + "," + b; dir.set(key, (dir.get(key) || 0) + 1); }
        for (const [key, n] of dir) { const [a, b] = key.split(","); if (n !== 1 || dir.get(b + "," + a) !== 1) return false; }
        return true;
      };
      const vol = (m) => { const P = m.positions, T = m.triangles; let v = 0; for (let k = 0; k < T.length; k += 3) { const [a, b, c] = [T[k], T[k + 1], T[k + 2]].map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]); v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6; } return v; };
      const m1 = K.meshForExport(plate, q);
      const stlMesh = K.parseStl(new Uint8Array(await K.exportStl([K.makeSphereAt([60, 0, 10], 10)], q))), m2 = K.meshForExport(stlMesh, q);
      const file = await K.write3mf([{ name: "Plate & <hole>", mesh: m1 }, { name: "Ball", mesh: m2 }]);
      // read it back: local headers, inflate, CRC
      const dv = new DataView(file.buffer), files = {};
      let o = 0, crcOk = true;
      const crc = (d) => { let c = 0xffffffff; for (let i = 0; i < d.length; i++) { c ^= d[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; };
      while (dv.getUint32(o, true) === 0x04034b50) {
        const csize = dv.getUint32(o + 18, true), nlen = dv.getUint16(o + 26, true), name = new TextDecoder().decode(file.subarray(o + 30, o + 30 + nlen));
        const packed = file.subarray(o + 30 + nlen, o + 30 + nlen + csize);
        const data = new Uint8Array(await new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
        if (crc(data) !== dv.getUint32(o + 14, true)) crcOk = false;
        files[name] = new TextDecoder().decode(data);
        o += 30 + nlen + csize;
      }
      const model = files["3D/3dmodel.model"] || "";
      const objs = [...model.matchAll(/<object id="(\d+)" type="model" name="([^"]*)"/g)].map((x) => x[2]);
      const nv = (model.match(/<vertex /g) || []).length;
      // both moved together onto the plate's middle (128, 128), bottom at z 0: plate x −15 … 70, y −10 … 10, z 0 … 20 → shift 100.5 (the ball's mesh just inside 70), 128, 0
      const place = [...model.matchAll(/<item objectid="\d+" transform="([^"]*)"/g)].map((x) => x[1]);
      expect("3MF: solid and STL mesh → closed meshes with the right volume; a valid ZIP (3 files, CRCs) with 2 named objects in mm, all vertices written, both moved together onto the plate's middle",
        closed(m1) && Math.abs(vol(m1) - K.solidVolume(plate)) < 0.01 * K.solidVolume(plate) && closed(m2) && Math.abs(vol(m2) - (4 / 3) * Math.PI * 1000) < 0.02 * 4189 &&
          crcOk && Object.keys(files).sort().join() === "3D/3dmodel.model,[Content_Types].xml,_rels/.rels" && /unit="millimeter"/.test(model) && objs.join("|") === "Plate &amp; &lt;hole&gt;|Ball" &&
          nv === m1.positions.length / 3 + m2.positions.length / 3 && (model.match(/<item /g) || []).length === 2 && place.length === 2 && place.every((t) => { const v = t.split(" ").map(Number); return t.startsWith("1 0 0 0 1 0 0 0 1 ") && Math.abs(v[9] - 100.5) < 0.01 && v[10] === 128 && v[11] === 0; }),
        { closed1: closed(m1), v1: r(vol(m1)), want1: r(K.solidVolume(plate)), closed2: closed(m2), v2: r(vol(m2)), crcOk, files: Object.keys(files), objs, nv, place });
      window.__3mf = file;
    }
    // On a box's front wall (y = −5), seen from the front: the H stands up the wall, facing out
    app.doc.reset([]);
    const wall = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 40, 10, 20), "Box");
    app.doc.commit([wall], "box"); vp.setView("front"); vp.fit(); await sleep(50);
    key("t", "KeyT"); await sleep(200);
    tap([-15, -5, 5]); await sleep(50);
    await typeText("H");
    const hf = app.doc.bodies.find((b) => b.kind === "face"), wb = hf && hf.shape.boundingBox.bounds;
    const nrm = hf && hf.shape.normalAt().toTuple();
    expect("text on a wall: the H lies on the box's front face (y −5), upright from z 5 to 15, starting by x −15, facing out (−Y)",
      hf && Math.abs(wb[0][1] + 5) < 1e-6 && Math.abs(wb[1][1] + 5) < 1e-6 && Math.abs(wb[0][2] - 5) < 0.01 && Math.abs(wb[1][2] - 15) < 0.01 && wb[0][0] > -15 && wb[0][0] < -13 && nrm[1] < -0.999,
      { wb: wb && wb.map((p) => p.map(r)), nrm: nrm && nrm.map(r) });
  } catch (e) {
    expect("text threw", false, String(e && e.stack || e));
  }
  if (app.tool) key("Escape", "Escape");
  app.doc.reset([]);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("text scenario failed: " + JSON.stringify(failed));
  return [{ label: "text", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

const SCENARIO_ARRAY = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const key = (k, code, o = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true, ...o }));
  const opValue = (k, v) => { const i = document.querySelector("#op-panel [data-key=" + k + "]"); if (i) { i.value = String(v); i.dispatchEvent(new Event(i.tagName === "SELECT" ? "change" : "input", { bubbles: true })); } };
  const r = (n) => +n.toFixed(3);
  const arrayBtn = () => document.querySelector("#corner-tools button[data-cmd='edit.array']");
  const ol = () => document.getElementById("outliner");
  document.getElementById("tutorial").hidden = true; document.body.classList.remove("tutorial-open");
  app.doc.reset([]);
  const box = app.doc.makeBody(K.makeBox(G, [60, 20, 0], 120, 40, 8.5), "Solid");
  const circle = app.doc.makeBody(K.makeCircleFace({ ...G, origin: [0, 0, 8.5] }, [20, 20, 8.5], 10), "Circle", "face");
  app.doc.commit([box, circle], "shapes");
  app.run("mode.body"); vp.setView("iso"); vp.fit(); await sleep(50);
  // G on a face off the grid (z 7.63): the gizmo sits in the face's plane, not rounded to the grid above it
  const offGrid = app.doc.makeBody(K.makeCircleFace({ ...G, origin: [0, 0, 7.63] }, [20, 80, 7.63], 10), "Circle", "face");
  app.doc.commit([...app.doc.bodies, offGrid], "off-grid circle");
  app.setSelection([{ kind: "face", body: offGrid.id, id: 0 }]); app.run("xf.move");
  const gz = r(vp.pivot.position.z);
  expect("G on a face at z 7.63: the gizmo is in its plane", app.xf && gz === 7.63, gz);
  const gizmoOp = [];
  vp.tc.getHelper().traverse((o) => { if (o.isMesh && o.material.visible) gizmoOp.push(+o.material.opacity.toFixed(2)); });
  const tcSize = vp.tc.size, maxOp = Math.max(...gizmoOp);
  expect("move gizmo: smaller (size 0.75), a little see-through (no handle fully opaque)", tcSize === 0.75 && gizmoOp.length > 0 && maxOp < 1, { tcSize, maxOp, n: gizmoOp.length });
  key("Escape", "Escape"); app.run("edit.undo");
  // Face mode, a face picked: each gizmo drag moves it by that drag only (the moved face stays
  // selected, so the gizmo restarts from where it is — not the 2nd drag counting the 1st again)
  {
    app.run("mode.face");
    app.setSelection([{ kind: "face", body: circle.id, id: app.doc.get(circle.id).shape.faces[0].hashCode }]); app.run("xf.move");
    const cx = () => { const b = app.doc.get(circle.id).shape.boundingBox.bounds; return r((b[0][0] + b[1][0]) / 2); };
    const xs = [cx()];
    for (const d of [10, 7, 5]) { vp.pivot.position.x += d; vp.finishTransformDrag(); xs.push(cx()); }
    const piv = r(vp.pivot.position.x), sel = app.selection.map((s) => s.kind + ":" + s.body);
    expect("face mode: 3 gizmo drags (10, 7, 5) on a picked face move it 10, 7, 5; face stays picked, gizmo on it", xs.join() === "20,30,37,42" && piv === 42 && sel.join() === "face:" + circle.id, { xs, piv, sel });
    key("Escape", "Escape"); for (let k = 0; k < 3; k++) app.run("edit.undo");
    app.run("mode.body");
  }
  // A face off the grid (drawn at a guide crossing): G puts the gizmo at its exact centre; a grid-snapped
  // drag moves it in whole steps from there (not onto grid lines)
  {
    const off = app.doc.makeBody(K.makeCircleFace({ ...G, origin: [0, 0, 8.5] }, [39.3, 24.5, 8.5], 6), "Circle", "face");
    app.doc.commit([...app.doc.bodies, off], "off-grid circle");
    app.setSelection([{ kind: "body", body: off.id, id: 0 }]); app.run("xf.move");
    const piv = vp.pivot.position.toArray().map(r);
    vp.tc.translationSnap = 1; vp.tc.axis = "X"; vp.tc.dragging = true;
    vp.pivot.position.x = 45; // (what the gizmo's own grid snapping leaves for a drag of about 5.7)
    vp.tc.dispatchEvent({ type: "objectChange" });
    vp.tc.dragging = false; vp.tc.axis = null;
    const b = app.doc.get(off.id).shape.boundingBox.bounds, cx = r((b[0][0] + b[1][0]) / 2);
    expect("off-grid face (39.3, 24.5): gizmo at its centre; a grid-snapped drag moves it 6 (→ 45.3), not onto the grid", piv.join() === "39.3,24.5,8.5" && cx === 45.3, { piv, cx });
    key("Escape", "Escape"); app.run("edit.undo"); app.run("edit.undo");
  }
  // Edge mode: the pointer is the arrow with an "E" (back to the plain one in Solid mode; a tool's crosshair wins)
  {
    const cur = () => vp.canvas.style.cursor;
    app.run("mode.edge"); const edge = cur();
    app.run("tool.box"); const tool = cur(); key("Escape", "Escape"); const after = cur();
    app.run("mode.body"); const body = cur();
    expect("edge mode: arrow + E cursor; Solid mode: default; a tool: crosshair", /^url\("data:image\/svg\+xml,.*%3EE%3C/.test(edge) && tool === "crosshair" && after === edge && body === "default", { edge: edge.slice(0, 40), tool, after: after.slice(0, 40), body });
  }
  app.setSelection([{ kind: "body", body: circle.id, id: 0 }]);
  const n0 = app.doc.bodies.length;
  const corner = [...document.querySelectorAll("#corner-tools button")].map((b) => b.dataset.cmd);
  const vr = document.getElementById("viewport").getBoundingClientRect(), cr = document.getElementById("corner-tools").getBoundingClientRect();
  expect("array: corner buttons Revolve, Circular copy, Sweep, Array copy, bottom left", corner.join() === "op.revolve,edit.circular,op.sweep,edit.array" && cr.left - vr.left < 30 && vr.bottom - cr.bottom < 60, { corner, left: cr.left - vr.left, bottom: vr.bottom - cr.bottom });
  key("D", "KeyD", { shiftKey: true }); await sleep(20);
  const plain = { added: app.doc.bodies.length - n0, gizmo: !!app.xf, panel: !document.getElementById("op-panel").hidden };
  expect("array: Shift+D is still the plain duplicate on the move gizmo", plain.added === 1 && plain.gizmo && !plain.panel, plain);
  key("Escape", "Escape"); app.run("edit.undo");
  app.setSelection([{ kind: "body", body: circle.id, id: 0 }]);
  arrayBtn().click(); await sleep(20);
  const panel = document.getElementById("op-panel");
  const title = panel.hidden ? null : panel.querySelector("h4")?.textContent;
  const fields = [...panel.querySelectorAll("[data-key]")].map((i) => i.dataset.key);
  expect("array: the corner button on a circle opens Array copy (copies, gap, direction)", title === "Array copy" && fields.join() === "n,gap,total,dir,centre" && app.doc.bodies.length === n0, { title, fields });
  opValue("n", 5); opValue("gap", 5); await sleep(200);
  const ghosts = app.op && app.op.result ? app.op.result.ghost.size : 0;
  expect("array: Copies 5 (the original counts) → live preview of 4 new, nothing added yet", ghosts === 4 && app.doc.bodies.length === n0, { ghosts, bodies: app.doc.bodies.length });
  app.applyOp();
  const made = app.doc.bodies.slice(n0);
  const xs = made.map((b) => { const [lo, hi] = b.shape.boundingBox.bounds; return r((lo[0] + hi[0]) / 2); });
  expect("array: 4 faces, centres 25 apart (Ø20 + gap 5) along +X", made.length === 4 && made.every((b) => b.kind === "face") && xs.join() === "45,70,95,120", xs);
  // The whole row (original + copies) stays selected → Array copy again along +Y: a 5 × 3 grid
  const sel = app.selection.map((x) => x.body).sort((p, q) => p - q).join();
  const rowIds = [circle.id, ...made.map((b) => b.id)].sort((p, q) => p - q).join();
  arrayBtn().click(); await sleep(20);
  opValue("n", 3); opValue("gap", 5); opValue("total", 0); opValue("dir", 2); app.applyOp();
  const grid = app.doc.bodies.slice(n0 + 4).map((b) => { const [lo, hi] = b.shape.boundingBox.bounds; return r((lo[1] + hi[1]) / 2); });
  const ys2 = [...new Set(grid)].sort((p, q) => p - q);
  expect("array: after Apply the whole row is selected; Array copy again along Y → a grid", sel === rowIds && grid.length === 10 && ys2.join() === "45,70" && app.selection.length === 15,
    { sel, rowIds, newRows: grid.length, ys: ys2, selected: app.selection.length });
  const groups = [...new Set(app.doc.bodies.slice(n0 - 1).map((b) => b.group))];
  expect("array: the row and then the grid are one group (Array 1)", groups.join() === "Array 1" && app.doc.bodies.slice(n0 - 1).length === 15, groups);
  app.run("edit.undo"); app.run("edit.undo");
  expect("array: one undo step for each array", app.doc.bodies.length === n0, app.doc.bodies.length);
  // Direction −Y, gap remembered (5)
  app.setSelection([{ kind: "body", body: circle.id, id: 0 }]);
  arrayBtn().click(); await sleep(20);
  const gapKept = panel.querySelector("[data-key=gap]")?.value;
  opValue("n", 3); opValue("dir", 3); app.applyOp();
  const ys = app.doc.bodies.slice(n0).map((b) => { const [lo, hi] = b.shape.boundingBox.bounds; return r((lo[1] + hi[1]) / 2); });
  expect("array: −Y direction, gap remembered", gapKept === "5" && ys.join() === "-5,-30", { gapKept, ys });
  app.run("edit.undo");
  // Align centre: a click on an edge (the box's front top edge, X 0..120) or a path (longest along Y, -140..-40):
  // the original and its copies fill it, centred, equal gaps between them and at both ends; typing a gap turns that off
  const path = app.doc.makeBody(K.sketchPath([{ kind: "line", a: [0, -40, 0], b: [30, -40, 0] }, { kind: "line", a: [30, -40, 0], b: [30, -140, 0] }]), "Path", "path");
  app.doc.commit([...app.doc.bodies, path], "path"); vp.fit(); await sleep(50);
  app.setSelection([{ kind: "body", body: circle.id, id: 0 }]);
  arrayBtn().click(); await sleep(20);
  const centreOff = !panel.querySelector("[data-key=centre]").checked;
  const opCheck = (k, on) => { const i = panel.querySelector("[data-key=" + k + "]"); i.checked = on; i.dispatchEvent(new Event("change", { bubbles: true })); };
  opCheck("centre", true);
  opValue("dir", 3); opValue("n", 5);
  const V = vp.camera.position.constructor;
  const val = (k) => panel.querySelector("[data-key=" + k + "]").value;
  const clickAt = async (p) => { const sc = window.__see(new V(p[0], p[1], p[2])); const e = new PointerEvent("pointermove", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true }); app.op.spec.hover(e); app.op.spec.pick(e); await sleep(150); return [val("total"), r(+val("gap")), val("dir")]; };
  const mid = (g, k) => { const [lo, hi] = g.boundingBox.bounds; return r((lo[k] + hi[k]) / 2); };
  const byEdge = await clickAt([70, 0, 8.5]);
  const ghostXs = app.op.result ? [...app.op.result.ghost.values()].map((g) => mid(g, 0)) : [];
  opValue("n", 3);
  const byPath = await clickAt([30, -90, 0]);
  const ghostYs = app.op.result ? [...app.op.result.ghost.values()].map((g) => mid(g, 1)) : [];
  opValue("gap", 3); await sleep(150);
  const typed = [val("total"), val("gap")];
  expect("array: an edge / a path — the original + copies fill it, centred, equal gaps at the ends too; typing a gap turns it off",
    centreOff && byEdge.join() === "120,3.33,0" && ghostXs.join() === "13.333,36.667,60,83.333,106.667" &&
      byPath.join() === "100,10,3" && ghostYs.join() === "-60,-90,-120" && typed.join() === "0,3" && app.doc.bodies.length === n0 + 1,
    { centreOff, byEdge, ghostXs, byPath, ghostYs, typed });
  // Apply along the edge: the original moved into the first place, one undo step puts it back
  opValue("n", 5); await clickAt([70, 0, 8.5]); app.applyOp();
  const row = [circle.id, ...app.doc.bodies.slice(n0 + 1).map((b) => b.id)].map((id) => mid(app.doc.get(id).shape, 0));
  app.run("edit.undo");
  const back = mid(app.doc.get(circle.id).shape, 0);
  expect("array: applied along the edge (original moved first), undo puts the original back", row.join() === "13.333,36.667,60,83.333,106.667" && back === 20 && app.doc.bodies.length === n0 + 1, { row, back });
  app.setSelection([{ kind: "body", body: path.id, id: 0 }]); app.run("edit.delete");
  // Align centre off (the default): the original stays put, the copies spread toward the far end, the last one as
  // far from it as the original is from the near end (circle at 20 on 0..120, 5 → 20, 40, 60, 80, 100)
  app.setSelection([{ kind: "body", body: circle.id, id: 0 }]);
  arrayBtn().click(); await sleep(20);
  const remembered = panel.querySelector("[data-key=centre]").checked;
  opCheck("centre", false); opValue("dir", 1); opValue("n", 5);
  const offEdge = await clickAt([70, 0, 8.5]);
  const offGhost = app.op.result ? [...app.op.result.ghost.keys()].includes(circle.id) : null;
  // Changing the gap after the edge click (mouse wheel, or typing) leaves the edge: the copies follow the gap
  const ghostX = () => (app.op.result ? [...app.op.result.ghost.values()].map((g) => mid(g, 0)) : []);
  const gapIn = panel.querySelector("[data-key=gap]");
  gapIn.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true })); await sleep(200);
  const wheeled = { total: val("total"), gap: val("gap"), xs: ghostX() };
  await clickAt([70, 0, 8.5]);
  gapIn.focus(); gapIn.value = "5"; gapIn.dispatchEvent(new Event("input", { bubbles: true })); await sleep(200);
  const typedGap = { total: val("total"), gap: val("gap"), xs: ghostX() };
  expect("array: after an edge click, changing the gap (wheel / typing) takes effect", wheeled.total === "0" && wheeled.gap === "0.5" && wheeled.xs.join() === "40.5,61,81.5,102" &&
    typedGap.total === "0" && typedGap.xs.join() === "45,70,95,120", { wheeled, typedGap });
  await clickAt([70, 0, 8.5]);
  app.applyOp();
  const offRow = [circle.id, ...app.doc.bodies.slice(n0).map((b) => b.id)].map((id) => mid(app.doc.get(id).shape, 0));
  expect("array: Align centre off — the original stays, copies to the far end (direction turned toward it), balanced",
    remembered && offEdge.join() === "120,0,0" && offGhost === false && offRow.join() === "20,40,60,80,100", { remembered, offEdge, offGhost, offRow });
  app.run("edit.undo");
  // An edge whose length isn't a round number (the field shows it rounded): still exactly centred, equal end gaps
  {
    const box2 = app.doc.makeBody(K.makeBox(G, [61.065, 300, 0], 83.714, 40, 8.5), "Solid");
    const c2 = app.doc.makeBody(K.makeCircleFace({ ...G, origin: [0, 0, 8.5] }, [28.73, 310, 8.5], 5.219), "Circle", "face");
    app.doc.commit([...app.doc.bodies, box2, c2], "odd box"); vp.fit(); await sleep(50);
    app.setSelection([{ kind: "body", body: c2.id, id: 0 }]);
    arrayBtn().click(); await sleep(20);
    opValue("n", 4); opCheck("centre", true);
    await clickAt([61.065, 280, 8.5]);
    app.applyOp();
    const cs = [c2.id, ...app.doc.bodies.slice(-3).map((x) => x.id)].map((id) => app.doc.get(id).shape.boundingBox.bounds);
    const left = cs[0][0][0] - 19.208, right = 102.922 - cs[3][1][0];
    const gaps = cs.slice(1).map((bb, k) => bb[0][0] - cs[k][1][0]);
    expect("array: a non-round edge (83.714), Align centre — end gaps = gaps between, centred", Math.abs(left - right) < 1e-3 && gaps.every((g) => Math.abs(g - left) < 1e-3),
      { left: r(left), right: r(right), gaps: gaps.map(r) });
    app.run("edit.undo");
    // ... and Align centre off: the original (9.522 from the left end) stays, the last copy 9.522 from the right end
    app.setSelection([{ kind: "body", body: c2.id, id: 0 }]);
    arrayBtn().click(); await sleep(20);
    opValue("n", 4); opCheck("centre", false);
    await clickAt([61.065, 280, 8.5]);
    app.applyOp();
    const ms = [c2.id, ...app.doc.bodies.slice(-3).map((x) => x.id)].map((id) => mid(app.doc.get(id).shape, 0));
    const pitches = ms.slice(1).map((x, k) => r(x - ms[k]));
    expect("array: a non-round edge, Align centre off — original stays, last copy mirrors it, equal pitch",
      Math.abs(ms[0] - 28.73) < 1e-3 && Math.abs((102.922 - ms[3]) - (ms[0] - 19.208)) < 1e-3 && pitches.every((p) => Math.abs(p - pitches[0]) < 1e-3), { ms, pitches });
    app.run("edit.undo");
    app.setSelection([box2.id, c2.id].map((id) => ({ kind: "body", body: id, id: 0 }))); app.run("edit.delete");
  }
  // Copies 2 → 2 circles (the original + 1 new); 1 is refused (nothing to copy)
  app.setSelection([{ kind: "body", body: circle.id, id: 0 }]);
  arrayBtn().click(); await sleep(20);
  const startN = val("n");
  opValue("n", 1); await sleep(150);
  const refused = panel.querySelector(".op-error")?.textContent;
  opValue("n", 2); opValue("total", 0); opValue("gap", 5); opValue("dir", 0); app.applyOp();
  const two = app.doc.bodies.slice(n0).map((b) => mid(b.shape, 0));
  expect("array: starts at 2; Copies 2 = the original + 1 copy; 1 refused", startN === "2" && /2 or more/.test(refused || "") && two.join() === "45", { startN, refused, two });
  app.run("edit.undo");
  // Esc on the panel: nothing added
  const n1 = app.doc.bodies.length;
  app.setSelection([{ kind: "body", body: circle.id, id: 0 }]);
  arrayBtn().click(); await sleep(20);
  panel.querySelector("[data-key=n]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect("array: Esc cancels, nothing added", app.doc.bodies.length === n1 && panel.hidden, { bodies: app.doc.bodies.length, hidden: panel.hidden });
  // Direction marks: ±X / ±Y / ±Z round the objects while Array copy is open; a click picks the direction
  {
    app.doc.reset([]);
    const cube = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 20, 20, 20), "Box");
    app.doc.commit([cube], "cube"); vp.setView("iso"); vp.fit(); await sleep(50);
    app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
    arrayBtn().click(); await sleep(50);
    opValue("n", 3); opValue("gap", 5); opValue("total", 0); opValue("dir", 0); await sleep(150);
    const marks = () => [...document.querySelectorAll("#op-choices .op-choice")];
    const shown = { labels: marks().map((m) => m.textContent).join(), lit: marks().filter((m) => m.classList.contains("on")).map((m) => m.textContent).join() };
    const vr = document.getElementById("viewport").getBoundingClientRect();
    const where = marks().map((m) => { const b = m.getBoundingClientRect(); return [m.textContent, Math.round(b.left - vr.left), Math.round(b.top - vr.top), Math.round(vr.right - b.right), Math.round(vr.bottom - b.bottom)].join(" "); });
    const inView = marks().every((m) => { const b = m.getBoundingClientRect(); return b.left >= vr.left && b.right <= vr.right && b.top >= vr.top && b.bottom <= vr.bottom; });
    marks().find((m) => m.textContent === "−Y").click(); await sleep(200);
    const picked = { dir: val("dir"), lit: marks().filter((m) => m.classList.contains("on")).map((m) => m.textContent).join(), ys: app.op.result ? [...app.op.result.ghost.values()].map((g) => mid(g, 1)).sort((p, q) => p - q).join() : "" };
    panel.querySelector("[data-key=n]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await sleep(20);
    expect("array: ±X / ±Y / ±Z marks round the objects (the direction's lit); a click on −Y picks it — the preview follows; gone after Esc",
      shown.labels === "+X,−X,+Y,−Y,+Z,−Z" && shown.lit === "+X" && inView && picked.dir === "3" && picked.lit === "−Y" && picked.ys === "-50,-25" && marks().length === 0,
      { shown, inView, where, picked, after: marks().length });
  }
  // Mirror (M): ±X / ±Y / ±Z marks; the copy lands beyond that side of the objects' box, touching it
  {
    const mark = async (label) => { [...document.querySelectorAll("#op-choices .op-choice")].find((m) => m.textContent === label)?.click(); await sleep(150); };
    const vol = (id) => K.solidVolume(app.doc.get(id).shape);
    const bb = (id) => app.doc.get(id).shape.boundingBox.bounds.map((p) => p.map(r).join(" ")).join(" / ");
    // A half dome on its flat side (z = 0), −Z with Join: one whole ball, no seam round the middle
    app.doc.reset([]);
    const dome = app.doc.makeBody(K.booleanOp("intersect", K.makeSphereAt([0, 0, 0], 10), [K.makeBox(G, [0, 0, 0], 30, 30, 15)]), "Dome");
    app.doc.commit([dome], "dome"); vp.setView("iso"); vp.fit(); await sleep(50);
    app.setSelection([{ kind: "body", body: dome.id, id: 0 }]);
    await key("m", "KeyM"); await sleep(50);
    const labels = [...document.querySelectorAll("#op-choices .op-choice")].map((m) => m.textContent).join();
    await mark("−Z"); opCheck("join", true); await sleep(300);
    app.applyOp(); await sleep(50);
    // (a seam stays round the middle: OpenCascade doesn't merge two sphere faces whose axes point opposite ways)
    const ball = app.doc.bodies, flat = ball.length === 1 ? ball[0].shape.faces.filter((f) => f.geomType === "PLANE").length : -1;
    expect("mirror: M → ±X / ±Y / ±Z marks; a half dome on z = 0, −Z + Join → one closed ball (volume 4/3·π·10³, valid, no flat face left inside)",
      labels === "+X,−X,+Y,−Y,+Z,−Z" && ball.length === 1 && Math.abs(vol(ball[0].id) - (4 / 3) * Math.PI * 1000) < 1e-3 && K.isValidShape(ball[0].shape) && flat === 0 && bb(ball[0].id) === "-10 -10 -10 / 10 10 10",
      { labels, n: ball.length, vol: ball.length && r(vol(ball[0].id)), flat, box: ball.length && bb(ball[0].id) });
    app.run("edit.undo"); await sleep(20);
    expect("mirror: one undo brings the half dome back", app.doc.bodies.length === 1 && Math.abs(vol(dome.id) - (2 / 3) * Math.PI * 1000) < 1e-3, app.doc.bodies.length);
    // An L-shaped solid, its whole group selected, +X (Join off): a reflected copy in a new group, the same size, right way out
    app.doc.reset([]);
    const ell = { ...app.doc.makeBody(K.booleanOp("union", K.makeBox(G, [5, 10, 0], 10, 20, 5), [K.makeBox(G, [15, 2.5, 0], 30, 5, 5)]), "Bracket"), group: "Bracket 1" };
    app.doc.commit([ell], "L"); vp.fit(); await sleep(50);
    app.setSelection([{ kind: "body", body: ell.id, id: 0 }]);
    await key("m", "KeyM"); await sleep(50); await mark("+X"); app.applyOp(); await sleep(50);
    const cp = app.doc.bodies.find((b) => b.id !== ell.id);
    const cpBox = cp && bb(cp.id), want = "30 0 0 / 60 20 5";
    // (the copy's long arm along Y is at the far end: the L is mirrored, not just moved)
    const arm = cp && K.solidVolume(K.booleanOp("intersect", cp.shape, [K.makeBox(G, [55, 10, 0], 10, 20, 5)]));
    expect("mirror: an L-shaped group, +X → a mirrored copy beyond its right side (same volume, valid, its long arm at the far end) in a new group Bracket 2",
      cp && cpBox === want && Math.abs(vol(cp.id) - vol(ell.id)) < 1e-6 && vol(cp.id) > 0 && K.isValidShape(cp.shape) && Math.abs(arm - 1000) < 1e-6 && cp.group === "Bracket 2" && app.doc.get(ell.id).group === "Bracket 1",
      { cpBox, want, vol: cp && r(vol(cp.id)), arm: arm && r(arm), group: cp?.group });
    // Join: only a solid touching its copy joins (the far one is copied); a flat face is copied
    app.doc.reset([]);
    const a = app.doc.makeBody(K.makeBox(G, [5, 5, 0], 10, 10, 10), "A"), b = app.doc.makeBody(K.makeBox(G, [25, 5, 0], 10, 10, 10), "B");
    const f = app.doc.makeBody(K.makeCircleFace(G, [25, 25, 0], 5), "Circle", "face");
    app.doc.commit([a, b, f], "A, B, circle"); vp.fit(); await sleep(50);
    app.setSelection([a, b, f].map((x) => ({ kind: "body", body: x.id, id: 0 })));
    await key("m", "KeyM"); await sleep(50); await mark("+X"); opCheck("join", true); await sleep(300); app.applyOp(); await sleep(50);
    const all = app.doc.bodies, solids = all.filter((x) => x.kind === "solid"), faces = all.filter((x) => x.kind === "face");
    expect("mirror +X with Join: B (at the side) joins its copy (twice the volume), A's copy stays apart, the circle face is copied (3 → 5 objects)",
      all.length === 5 && Math.abs(vol(b.id) - 2000) < 1e-6 && bb(b.id) === "20 0 0 / 40 10 10" && solids.length === 3 && faces.length === 2 &&
        solids.some((x) => x.id !== a.id && x.id !== b.id && bb(x.id) === "50 0 0 / 60 10 10"),
      { n: all.length, b: bb(b.id), solids: solids.map((x) => bb(x.id)) });
  }
  // A guide line as the span (like ~/untitled.yddd: a guide from the box's corner along its top-front edge, on past it):
  // where it lies on the edge the edge wins; past the box the guide is picked — the copies fill it
  {
    app.doc.reset([]);
    const bx = app.doc.makeBody(K.makeBox(G, [58.85, 256.75, 0], 36.4, 157, 20.8), "Box");
    app.doc.commit([bx], "box");
    app.doc.setGuides([{ a: [40.65, 178.25, 20.8], b: [368.74, 178.25, 20.8], n: [0, 0, 1] }], "guide");
    vp.setView("iso"); vp.fit(); await sleep(50);
    app.setSelection([{ kind: "body", body: bx.id, id: 0 }]);
    arrayBtn().click(); await sleep(20);
    const hoverAt = async (p) => { const sc = window.__see(new V(p[0], p[1], p[2])); app.op.spec.hover(new PointerEvent("pointermove", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); await sleep(20); return app.hudEl.hidden ? "" : app.hudEl.textContent; };
    const onEdge = await hoverAt([58, 178.25, 20.8]);
    const onGuide = await hoverAt([250, 178.25, 20.8]);
    const lit = app.hoverGuide;
    opCheck("centre", true); opValue("n", 4);
    const picked = await clickAt([250, 178.25, 20.8]);
    app.applyOp();
    const row = app.doc.bodies.map((b) => b.shape.boundingBox.bounds).map(([lo, hi]) => [lo[0], hi[0]]).sort((p, q) => p[0] - q[0]);
    const gaps = [row[0][0] - 40.65, ...row.slice(1).map((r, k) => r[0] - row[k][1]), 368.74 - row[row.length - 1][1]].map(r);
    expect("array: a guide line as the span — the edge wins where they overlap; past the box the guide: the copies fill it (Align centre)",
      /^Edge/.test(onEdge) && /^Guide: 328\.09/.test(onGuide) && lit === 0 && picked.join() === "328.09," + picked[1] + ",0" && row.length === 4 &&
        gaps.every((g) => Math.abs(g - gaps[0]) < 1e-3) && app.hoverGuide === -1,
      { onEdge, onGuide, lit, picked, gaps, after: app.hoverGuide });
    app.run("edit.undo");
  }
  // Changing an array later (select its group, Array copy: its settings come back) — and undo kept in the saved file
  {
    app.doc.reset([]);
    const plate = app.doc.makeBody(K.makeBox(G, [60, 20, 0], 120, 40, 8.5), "Solid");
    const dot = app.doc.makeBody(K.makeCircleFace({ ...G, origin: [0, 0, 8.5] }, [20, 20, 8.5], 10), "Circle", "face");
    app.doc.commit([plate, dot], "shapes"); vp.fit(); await sleep(30);
    app.setSelection([{ kind: "body", body: dot.id, id: 0 }]);
    arrayBtn().click(); await sleep(20);
    opValue("n", 5); opValue("gap", 5); opValue("total", 0); opValue("dir", 0); opCheck("centre", false); app.applyOp();
    const grp = app.doc.get(dot.id).group;
    const members = () => app.doc.bodies.filter((b) => b.group === grp);
    const xsOf = () => members().map((b) => mid(b.shape, 0)).sort((p, q) => p - q).join();
    const pickGroup = () => app.setSelection(members().map((b) => ({ kind: "body", body: b.id, id: 0 })));
    // Array copy (the corner button) on the group makes new copies (a grid): its own panel, no "change" option
    const title = () => (panel.hidden ? null : panel.querySelector("h4")?.textContent);
    app.setSelection([]); pickGroup();
    arrayBtn().click(); await sleep(20);
    const asNew = { title: title(), n: val("n"), option: !!panel.querySelector("[data-key=edit]") };
    panel.querySelector("[data-key=n]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect("array: Array copy on an array's group makes new copies (titled Array copy, count from 2, no change option)", asNew.title === "Array copy" && asNew.n === "2" && !asNew.option, asNew);
    // ...and a grid: the whole row along +Y (still one group)
    pickGroup(); arrayBtn().click(); await sleep(20);
    opValue("n", 2); opValue("gap", 5); opValue("total", 0); opValue("dir", 2); app.applyOp();
    const grid = { n: members().length, ys: [...new Set(members().map((b) => mid(b.shape, 1)))].sort((p, q) => p - q).join() };
    app.run("edit.undo");
    expect("array: select the array's group later → Array copy along Y → a grid (10 in the group)", grid.n === 10 && grid.ys === "20,45", grid);
    // The Bodies panel: the array's group has an array icon beside the eye — a click changes the array
    app.setSelection([]); await sleep(20);
    const icon = ol().querySelector(".ol-group[data-group='" + grp + "'] .ol-array");
    const iconOn = !!icon && !icon.classList.contains("off");
    icon?.click(); await sleep(20);
    const byIcon = { on: iconOn, title: title(), n: val("n"), selected: app.selection.length };
    panel.querySelector("[data-key=n]")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect("array: in the Bodies panel the array's group has an icon beside the eye; a click opens Change the array", byIcon.on && byIcon.title === "Change " + grp && byIcon.n === "5" && byIcon.selected === 5, byIcon);
    // The Properties panel says it's an array (no buttons there: its icon changes it)
    app.setSelection([]); pickGroup(); await sleep(20);
    const props = document.getElementById("props").textContent;
    const propsButtons = document.querySelectorAll("#props button").length;
    ol().querySelector(".ol-group[data-group='" + grp + "'] .ol-array")?.click(); await sleep(20);
    const opened = { props: /5 in a row/.test(props) && propsButtons === 0, title: title(), n: val("n"), gap: val("gap"), dir: val("dir") };
    opValue("n", 3); await sleep(200);
    const pre = app.op.result ? { ghosts: app.op.result.ghost.size, hidden: app.op.result.hide.length } : null;
    app.applyOp();
    const changed = { xs: xsOf(), group: members().length, label: app.doc.undoLabel };
    app.run("edit.undo"); const undone = xsOf();
    app.run("edit.redo"); const redone = xsOf();
    expect("array: the group selected → Properties shows Array (5 in a row), no buttons; its icon opens titled Change Array N with its settings; 5 → 3 rebuilds the row; undo / redo",
      opened.props && opened.title === "Change " + grp && opened.n === "5" && opened.gap === "5" && opened.dir === "0" && pre && pre.ghosts === 2 && pre.hidden === 4 &&
        changed.xs === "20,45,70" && changed.group === 3 && /^Change /.test(changed.label) && undone === "20,45,70,95,120" && redone === "20,45,70",
      { opened, pre, changed, undone, redone });
    // The whole group moved together (+10, +7, +3): still changeable; rebuilt where it is now
    {
      const moveAll = new Map(members().map((b) => [b.id, K.translateShape(b.shape, [10, 7, 3])]));
      app.doc.replaceShapes(moveAll, "Move"); await sleep(20);
      app.setSelection([]); await sleep(20);
      const ic = ol().querySelector(".ol-group[data-group='" + grp + "'] .ol-array");
      const on = !!ic && !ic.classList.contains("off");
      ic?.click(); await sleep(20);
      const t = title();
      opValue("n", 4); app.applyOp();
      const moved = { on, title: t, xs: xsOf(), ys: [...new Set(members().map((b) => mid(b.shape, 1)))].join(), zs: [...new Set(members().map((b) => mid(b.shape, 2)))].join() };
      app.run("edit.undo"); app.run("edit.undo");
      expect("array: the whole group moved together is still changeable — rebuilt where it is now", moved.on && moved.title === "Change " + grp && moved.xs === "30,55,80,105" && moved.ys === "27" && moved.zs === "11.5", moved);
    }
    // A copy moved on its own: the array can't be changed any more (Array copy makes new copies, and says why)
    const lone = members().find((b) => mid(b.shape, 0) === 70);
    app.doc.replaceShapes(new Map([[lone.id, K.translateShape(lone.shape, [0, 3, 0])]]), "Move");
    pickGroup(); await sleep(20);
    const dim = ol().querySelector(".ol-group[data-group='" + grp + "'] .ol-array");
    const refused = { button: !!document.querySelector("#props button"), said: document.getElementById("props").textContent, icon: dim ? dim.classList.contains("off") && /can't be changed/.test(dim.title) : null };
    app.run("edit.undo");
    expect("array: after a copy is moved on its own, it can't be changed (Properties says why, no Change button; the icon dims)", !refused.button && /can't be changed any more/.test(refused.said) && refused.icon === true, refused);
    // Saved and opened again: Undo / Redo go on where they were, and the array can still be changed
    app.run("edit.undo"); // (back to 5: the change becomes a Redo step)
    const before = { n: app.doc.bodies.length, undo: app.doc.undoLabel, xs: xsOf() };
    const text = app.modelText();
    app.loadModel(text, null); await sleep(30);
    const after = { n: app.doc.bodies.length, undo: app.doc.undoLabel, redo: app.doc.canRedo, dirty: app.doc.dirty, xs: xsOf() };
    app.run("edit.redo"); const reRedo = xsOf();
    app.run("edit.undo"); app.run("edit.undo"); const firstUndo = { n: app.doc.bodies.length, grouped: members().length };
    app.run("edit.redo");
    pickGroup(); await sleep(20); app.run("edit.arrayChange"); await sleep(20);
    const stillEditable = title() === "Change " + grp && val("n") === "5";
    panel.querySelector("[data-key=n]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect("array: saved with its undo history — reopened, Undo / Redo carry on and the array can still be changed",
      after.n === before.n && after.undo === before.undo && after.redo && !after.dirty && after.xs === before.xs && reRedo === "20,45,70" &&
        firstUndo.n === 2 && firstUndo.grouped === 0 && stillEditable,
      { before, after, reRedo, firstUndo, stillEditable, bytes: text.length });
    // A file without the history (an older YDDD's): opens as before, no undo — the array can still be changed
    const plain = JSON.parse(text); delete plain.history;
    app.loadModel(JSON.stringify(plain), null); await sleep(30);
    pickGroup(); await sleep(20); app.run("edit.arrayChange"); await sleep(20);
    const oldFile = { undo: app.doc.canUndo, n: app.doc.bodies.length, edit: title() === "Change " + grp };
    panel.querySelector("[data-key=n]").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect("array: a file without history opens without undo; its array can still be changed", !oldFile.undo && oldFile.n === 6 && oldFile.edit, oldFile);
  }
  // Stretched circles pushed into solids (like ~/untitled.yddd): their extruded sides are drawn with few triangles,
  // and moving / turning them reuses the triangles (no meshing again) — still the right faces to pick
  {
    app.doc.reset([]);
    const circle = K.makeCircleFace(G, [0, 0, 0], 4);
    const oval = K.scaleShape(circle, [1.3, 0.8, 1], [0, 0, 0]);
    const post = K.extrudeFace(oval, oval.faces[0].hashCode, 74);
    const types = post.faces.map((f) => f.geomType).sort().join();
    const tris = K.tessellate(post).faces.triangles.length / 3;
    // A stretched dome (half sphere, 60% wide): drawn close to the true half-ellipsoid — not a faceted tent
    const half = K.booleanOp("subtract", K.makeSphereAt([0, 0, 0], 36.5), [K.makeBox(G, [0, 0, -100], 200, 200, 100)]);
    const dome = K.scaleShape(half, [0.6, 1, 1], [0, 0, 0]);
    const dm = K.tessellate(dome).faces, ax = [21.9, 36.5, 36.5];
    let domeOff = 0;
    for (let k = 0; k < dm.triangles.length; k += 3) {
      const p = [0, 1, 2].map((j) => (dm.vertices[dm.triangles[k] * 3 + j] + dm.vertices[dm.triangles[k + 1] * 3 + j] + dm.vertices[dm.triangles[k + 2] * 3 + j]) / 3);
      if (p[2] < 1e-6) continue; // (the base)
      domeOff = Math.max(domeOff, Math.abs(Math.hypot(p[0] / ax[0], p[1] / ax[1], p[2] / ax[2]) - 1) * 21.9);
    }
    const posts = [0, 1, 2].flatMap((i) => [0, 1, 2].map((j) => app.doc.makeBody(K.translateShape(post, [i * 15, j * 15, 0]), "Post")));
    app.doc.commit(posts, "posts"); vp.fit(); await sleep(50);
    app.setSelection(posts.map((b) => ({ kind: "body", body: b.id, id: 0 })));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "g", code: "KeyG", bubbles: true, cancelable: true })); await sleep(20);
    const t0 = performance.now();
    app.applyTransform({ type: "translate", vector: [5, -3, 2] });
    app.applyTransform({ type: "rotate", angleDeg: 30, center: [10, 10, 0], axis: [0, 0, 1] });
    const moveMs = performance.now() - t0;
    key("Escape", "Escape"); await sleep(50);
    /** Each body's display: its face ids are the shape's, and its triangles sit where the shape is. */
    const views = posts.map((p) => {
      const b = app.doc.get(p.id), v = vp.views.get(p.id), pos = v.mesh.geometry.attributes.position.array;
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < pos.length; i += 3) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], pos[i + k]); hi[k] = Math.max(hi[k], pos[i + k]); }
      const [L, H] = b.shape.boundingBox.bounds;
      const off = Math.max(...[0, 1, 2].map((k) => Math.max(Math.abs(lo[k] - L[k]), Math.abs(hi[k] - H[k]))));
      const same = v.faceIds.slice().sort().join() === b.shape.faces.map((f) => f.hashCode).sort().join() && v.edgeIds.every((id) => b.shape.edges.some((e) => e.hashCode === id));
      return { off: +off.toFixed(3), same };
    });
    // Click the side of a moved post: a face of that post
    const target = app.doc.get(posts[4].id), [L, H] = target.shape.boundingBox.bounds;
    vp.setView("top"); vp.fit(); await sleep(50);
    const sc = window.__see(new V((L[0] + H[0]) / 2, (L[1] + H[1]) / 2, H[2]));
    const hit = vp.pick(sc.x, sc.y, "face");
    const picked = hit && hit.body === target.id && target.shape.faces.some((f) => f.hashCode === hit.id);
    vp.setView("iso");
    expect("display: a stretched dome is drawn close to its true shape; a stretched circle pushed into a solid with few triangles; moved / turned, its triangles are reused — right place, right faces",
      types === "EXTRUSION_SURFACE,PLANE,PLANE" && tris < 2000 && views.every((v) => v.same && v.off < 0.05) && picked && domeOff < 0.5,
      { types, tris, views, picked, moveMs: Math.round(moveMs), domeOff: +domeOff.toFixed(3), domeTris: dm.triangles.length / 3 });
    app.setSelection(posts.map((b) => ({ kind: "body", body: b.id, id: 0 }))); app.run("edit.delete");
  }
  // Subtract a whole array group (like ~/untitled.yddd): the box, −, click the group in the Bodies panel →
  // the 36 boxes cut in one pass (one at a time was ~5× slower), one undo step
  {
    const plate = app.doc.makeBody(K.makeBox(G, [60, 500, 0], 120, 80, 8.5), "Plate");
    const holes = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 3; j++) holes.push({ ...app.doc.makeBody(K.makeBox(G, [10 + i * 9, 475 + j * 25, 4], 5, 5, 10), "Hole"), group: "Holes T" });
    app.doc.commit([...app.doc.bodies, plate, ...holes], "holes"); app.renderOutliner(); await sleep(50);
    const nb = app.doc.bodies.length;
    app.setSelection([{ kind: "body", body: plate.id, id: 0 }]);
    key("-", "Minus"); await sleep(20);
    const head = document.querySelector(".ol-group[data-group='Holes T'] .ol-name");
    const t0 = performance.now();
    head?.click();
    // (36 solids at once: a busy dialog is put up first, the cut runs after the next paint)
    const busy = !!document.getElementById("busy"), stillThere = app.doc.bodies.length === nb;
    const typed = (key("x", "KeyX"), !!app.tool); // (keys wait while it's up — X / Delete deletes nothing; Esc would stop it: see "background kernel")
    for (let i = 0; i < 100 && document.getElementById("busy"); i++) await sleep(20);
    const ms = performance.now() - t0, gone = !document.getElementById("busy");
    const cut = app.doc.get(plate.id);
    const vol = cut ? r(K.solidVolume(cut.shape)) : null, expected = r(120 * 80 * 8.5 - 36 * 5 * 5 * 4.5);
    expect("array: box, −, click a 36-box group → a busy dialog (keys wait), then all cut at once and it closes",
      !!head && busy && stillThere && typed && gone && app.doc.bodies.length === nb - 36 && vol === expected && K.isValidShape(cut.shape),
      { head: !!head, busy, stillThere, typed, gone, bodies: app.doc.bodies.length - nb, vol, expected, ms: Math.round(ms) });
    // Tick "Keep the clicked solid": the 36 come back (plain boxes: quick to draw, no busy dialog)
    {
      const box = document.querySelector("#tool-panel input[data-act=keep], .tool-panel input[data-act=keep], input[data-act=keep]");
      if (box) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); }
      const kBusy = !!document.getElementById("busy");
      for (let i = 0; i < 100 && document.getElementById("busy"); i++) await sleep(20);
      const back = app.doc.bodies.length - nb, kGone = !document.getElementById("busy");
      expect("array: then tick 'Keep the clicked solid' → the 36 come back at once (quick to draw: no busy dialog)", !!box && !kBusy && kGone && back === 0, { box: !!box, kBusy, kGone, back });
      app.run("edit.undo"); await sleep(20); // (the keep: back to the cut)
    }
    key("Escape", "Escape"); app.run("edit.undo");
    expect("array: the group cut is one undo step", app.doc.bodies.length === nb, app.doc.bodies.length - nb);
    app.setSelection([plate, ...holes].map((b) => ({ kind: "body", body: b.id, id: 0 }))); app.run("edit.delete");
  }
  // A busy shape (over 30 faces: the plate with 36 round holes) is drawn with coarser round edges; a simple one is not
  {
    const disc = K.makeCylinder(G, [0, 0, -1], 5, 10);
    const holes = Array.from({ length: 36 }, (_, i) => K.makeCylinder(G, [10 + (i % 12) * 9, (i / 12 | 0) * 25 - 25, -1], 2.5, 10));
    const plate = K.booleanOp("subtract", K.makeBox(G, [60, 0, 0], 120, 80, 8.5), holes);
    const ring = K.booleanOp("subtract", K.makeBox(G, [0, 0, 0], 20, 20, 8.5), [disc]);
    /** Segments of the longest round edge (a hole's rim). */
    const segs = (s) => Math.max(...K.tessellate(s).edges.edgeGroups.map((g) => g.count));
    const busy = segs(plate), simple = segs(K.booleanOp("subtract", K.makeBox(G, [0, 0, 0], 20, 20, 8.5), [K.makeCylinder(G, [0, 0, -1], 2.5, 10)]));
    expect("array: a busy shape (36 round holes) is drawn with fewer segments per hole; a simple one keeps full quality",
      plate.faces.length > 30 && ring.faces.length <= 30 && busy < simple * 0.8, { faces: plate.faces.length, busy, simple });
  }
  // Circular copy (corner button next to Revolve): round the Z axis, a guide line, a circle edge; Done / Cancel
  try {
    app.doc.reset([]);
    const blk = app.doc.makeBody(K.makeBox(G, [50, 0, 0], 20, 10, 5), "Block"); // (centre 50, 0: 50 mm from Z)
    app.doc.commit([blk], "block");
    app.run("mode.body"); vp.setView("iso"); vp.fit(); await sleep(50);
    const corner = [...document.querySelectorAll("#corner-tools button")].map((b) => b.dataset.cmd);
    expect("circular copy: its corner button is right after Revolve", corner.indexOf("edit.circular") === corner.indexOf("op.revolve") + 1, corner);
    const centres = () => app.doc.bodies.map((b) => { const [p, q] = b.shape.boundingBox.bounds; return [0, 1, 2].map((k) => (p[k] + q[k]) / 2); });
    const sizes = () => app.doc.bodies.map((b) => { const [p, q] = b.shape.boundingBox.bounds; return [0, 1, 2].map((k) => r(q[k] - p[k])); });
    const angles = () => centres().map((c) => r(((Math.atan2(c[1], c[0]) * 180) / Math.PI + 360) % 360)).sort((a, b) => a - b);
    app.setSelection([{ kind: "body", body: blk.id, id: 0 }]);
    document.querySelector("#corner-tools button[data-cmd='edit.circular']").click(); await sleep(50);
    const caps = [...document.querySelectorAll("#op-panel .op-buttons button")].map((b) => b.textContent);
    const ghosts = vp.ghostRoot.children.length;
    expect("circular copy: a dialog with Cancel / Done, previews the copies", app.op && app.op.spec.label === "Circular copy" && caps.join() === "Cancel,Done" && ghosts > 0, { caps, ghosts });
    document.querySelector("#op-panel [data-a=apply]").click(); await sleep(50);
    const a6 = angles(), rad = centres().map((c) => r(Math.hypot(c[0], c[1]))), grp = new Set(app.doc.bodies.map((b) => b.group));
    expect("circular copy: Done → 6 round Z, 60° apart, all 50 mm out, one group",
      !app.op && a6.join() === "0,60,120,180,240,300" && rad.every((x) => x === 50) && grp.size === 1 && /^Circular/.test([...grp][0]), { a6, rad, grp: [...grp] });
    // Change it later: the group's circular icon in the Bodies panel reopens it with its settings; 6 → 8
    {
      const g = [...grp][0], gsel = '.ol-group[data-group="' + g + '"] .ol-array';
      app.setSelection([]); await sleep(20);
      const ic = ol().querySelector(gsel), on = !!ic && !ic.classList.contains("off") && /Circular copy \(6 round\)/.test(ic.title);
      ic?.click(); await sleep(20);
      const val = (k) => document.querySelector("#op-panel [data-key=" + k + "]")?.value;
      const opened = { on, title: app.op && app.op.spec.title, n: val("n"), angle: val("angle"), axis: document.querySelector("#op-panel [data-key=axis]")?.selectedOptions[0]?.textContent };
      opValue("n", 8); await sleep(150);
      const hidden = app.op && app.op.result ? app.op.result.hide.length : -1;
      app.applyOp(); await sleep(50);
      const a8 = angles(), label = app.doc.undoLabel, n8 = app.doc.bodies.filter((b) => b.group === g).length;
      expect("circular copy: its icon in the Bodies panel opens Change (6, 360°, as before: Z axis); 6 → 8 replaces the copies, 45° apart, same group",
        opened.on && opened.title === "Change " + g && opened.n === "6" && opened.angle === "360" && opened.axis === "As before: Z axis" && hidden === 5 &&
          a8.join() === "0,45,90,135,180,225,270,315" && n8 === 8 && /^Change /.test(label), { opened, hidden, a8, n8, label });
      // Saved and opened again: still changeable
      const saved = app.modelText(); app.doc.dirty = false; app.loadModel(saved, null); await sleep(50);
      const ic2 = ol().querySelector(gsel), still = !!ic2 && !ic2.classList.contains("off");
      // The whole ring moved together: still changeable, round the moved axis
      const all = app.doc.bodies.filter((b) => b.group === g);
      app.doc.replaceShapes(new Map(all.map((b) => [b.id, K.translateShape(b.shape, [0, 0, 7])])), "Move"); await sleep(20);
      const ic3 = ol().querySelector(gsel), movedOk = !!ic3 && !ic3.classList.contains("off");
      app.run("edit.undo"); await sleep(20);
      // One copy moved on its own: the icon dims and says why
      const one = app.doc.bodies.filter((b) => b.group === g)[3];
      app.doc.replaceShapes(new Map([[one.id, K.translateShape(one.shape, [0, 3, 0])]]), "Move"); await sleep(20);
      const ic4 = ol().querySelector(gsel), dimmed = !!ic4 && ic4.classList.contains("off") && /can't be changed/.test(ic4.title);
      app.run("edit.undo"); await sleep(20);
      expect("circular copy: saved and reopened still changeable; the whole ring moved: still; one copy moved: the icon dims", still && movedOk && dimmed, { still, movedOk, dimmed });
      app.run("edit.undo"); app.run("edit.undo"); await sleep(20); // (the change, then the copy)
    }
    expect("circular copy: undo goes back a step at a time (change, then the copy) to the original", app.doc.bodies.length === 1, app.doc.bodies.length);
    // Linked copies: fillet / scale / rotate one object of the ring → every copy changes the same way; still changeable
    {
      app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]); app.run("edit.circular"); await sleep(20);
      app.applyOp(); await sleep(50);
      const g = app.doc.bodies[0].group, ring = () => app.doc.bodies.filter((b) => b.group === g);
      const on = () => { const ic = ol().querySelector('.ol-group[data-group="' + g + '"] .ol-array'); return !!ic && !ic.classList.contains("off"); };
      const third = ring()[2]; // (a copy, 120° round)
      app.doc.replaceShapes(new Map([[third.id, K.filletEdges(third.shape, null, 1)]]), "Fillet"); await sleep(30);
      const faces = ring().map((b) => b.shape.faces.length), vols = ring().map((b) => r(K.solidVolume(b.shape)));
      const fa = angles(), fr = centres().map((c) => r(Math.hypot(c[0], c[1])));
      const fOn = on(), fLabel = app.doc.undoLabel;
      app.run("edit.undo"); await sleep(20);
      const undone = ring().every((b) => b.shape.faces.length === 6);
      expect("linked copies: fillet one copy → all 6 filleted the same, still round Z at 50 mm, still changeable; one undo puts all back",
        faces.every((f) => f === faces[0] && f > 6) && vols.every((v) => v === vols[0]) && fa.join() === "0,60,120,180,240,300" && fr.every((x) => x === 50) && fOn && fLabel === "Fillet" && undone,
        { faces, vols, fa, fr, fOn, fLabel, undone });
      // Scale the original 2× about its centre → every copy 2× (the one opposite: 40 × 20 × 10 too)
      const src = ring()[0], [p0, q0] = src.shape.boundingBox.bounds, sc = [0, 1, 2].map((k) => (p0[k] + q0[k]) / 2);
      app.doc.replaceShapes(new Map([[src.id, K.scaleShape(src.shape, [2, 2, 2], sc)]]), "Scale"); await sleep(30);
      const ss = sizes(), sr = centres().map((c) => r(Math.hypot(c[0], c[1])));
      app.run("edit.undo"); await sleep(20);
      expect("linked copies: scale the original 2× → the copy opposite it is 40 × 20 × 10 too, all still 50 mm out", ss[0].join() === "40,20,10" && ss[3].join() === "40,20,10" && sr.every((x) => x === 50), { ss, sr });
      // Rotate the copy opposite (180°) a quarter turn about its own centre → the original turns too (10 × 20)
      const opp = ring()[3], [p1, q1] = opp.shape.boundingBox.bounds, oc = [0, 1, 2].map((k) => (p1[k] + q1[k]) / 2);
      app.doc.replaceShapes(new Map([[opp.id, K.rotateShape(opp.shape, 90, oc, [0, 0, 1])]]), "Rotate"); await sleep(30);
      const rs = sizes(), rOn = on();
      app.run("edit.undo"); await sleep(20);
      expect("linked copies: rotate one copy about its centre → the original turns the same (10 × 20), still changeable", rs[0].join() === "10,20,5" && rs[3].join() === "10,20,5" && rOn, { rs, rOn });
      app.run("edit.undo"); await sleep(20); // (the ring)
    }
    // Subtract the ring from a plate (click its group), tick Keep: the ring comes back still a circular copy (its icon
    // changes it); Undo that will take a while to draw puts up the busy dialog first
    {
      app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]); app.run("edit.circular"); await sleep(20);
      app.applyOp(); await sleep(50);
      const g = app.doc.bodies[0].group, ring = () => app.doc.bodies.filter((b) => b.group === g);
      const plate = app.doc.makeBody(K.makeBox(G, [0, 0, 2], 140, 140, 1), "Plate");
      app.doc.commit([...app.doc.bodies, plate], "plate"); app.renderOutliner(); await sleep(20);
      const waitBusy = async () => { for (let i = 0; i < 150 && document.getElementById("busy"); i++) await sleep(20); };
      app.setSelection([{ kind: "body", body: plate.id, id: 0 }]); key("-", "Minus"); await sleep(20);
      ol().querySelector('.ol-group[data-group="' + g + '"] .ol-name')?.click(); await waitBusy();
      const usedUp = ring().length === 0 && !app.doc.arrays.some((r) => r.group === g);
      const box = document.querySelector("input[data-act=keep]");
      if (box) { box.checked = true; box.dispatchEvent(new Event("change", { bubbles: true })); }
      await waitBusy();
      const ic = ol().querySelector('.ol-group[data-group="' + g + '"] .ol-array');
      const kept = { n: ring().length, rec: app.doc.arrays.some((r) => r.group === g && r.circular), icon: !!ic && !ic.classList.contains("off") };
      expect("subtract a circular group, tick Keep → the 6 come back still a circular copy (record and icon back)", usedUp && kept.n === 6 && kept.rec && kept.icon, { usedUp, kept });
      key("Escape", "Escape"); await sleep(20);
      // Undo with a slow draw ahead (as 17 sweeps would be): the busy dialog first, then the step
      const real = vp.drawCost; vp.drawCost = () => 1000;
      app.run("edit.undo");
      const uBusy = !!document.getElementById("busy"), notYet = app.doc.undoLabel === "Keep clicked solid";
      await waitBusy(); vp.drawCost = real;
      const undone = app.doc.undoLabel === "Subtract" && ring().length === 0;
      app.run("edit.undo"); const quick = !document.getElementById("busy"); // (a real, quick one: no dialog)
      expect("undo that will take a while to draw → a busy dialog first, then it undoes; a quick undo: none", uBusy && notYet && undone && quick && ring().length === 6, { uBusy, notYet, undone, quick, n: ring().length });
      app.run("edit.undo"); app.run("edit.undo"); await sleep(20); // (the plate, the ring)
    }
    // The group's copy icon (Bodies panel): its copies are a new group "Circular 2", still a circular copy (its icon changes it)
    {
      app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]); app.run("edit.circular"); await sleep(20);
      app.applyOp(); await sleep(50);
      const g1 = app.doc.bodies[0].group; app.setSelection([]); await sleep(20);
      const dup = ol().querySelector('.ol-group[data-group="' + g1 + '"] .ol-dup');
      dup?.click(); await sleep(50);
      const g2 = [...new Set(app.doc.bodies.map((b) => b.group))].filter((g) => g !== g1);
      const n2 = app.doc.bodies.filter((b) => b.group === g2[0]).length, gizmo = !!app.xf;
      key("Escape", "Escape"); await sleep(20);
      const ic = ol().querySelector('.ol-group[data-group="' + g2[0] + '"] .ol-array'), changeable = !!ic && !ic.classList.contains("off") && /Circular copy \(6 round\)/.test(ic.title);
      expect("circular copy: the group's copy icon → a new group (Circular 2) of 6 copies, moved with the gizmo, still changeable from its icon",
        !!dup && g2.length === 1 && g2[0] === "Circular 2" && n2 === 6 && gizmo && changeable, { dup: !!dup, g2, n2, gizmo, changeable });
      app.run("edit.undo"); app.run("edit.undo"); await sleep(20);
    }
    // 4 over 90°, copies not turned: 30° apart, each still 20 × 10
    app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]); app.run("edit.circular"); await sleep(20);
    opValue("n", 4); opValue("angle", 90); const tb = document.querySelector("#op-panel [data-key=turn]"); tb.checked = false; tb.dispatchEvent(new Event("change", { bubbles: true }));
    app.applyOp(); await sleep(50);
    const a4 = angles(), sz = sizes();
    expect("circular copy: 4 over 90° (Turn off) → 0 / 30 / 60 / 90°, none turned", a4.join() === "0,30,60,90" && sz.every((x) => x.join() === "20,10,5"), { a4, sz });
    app.run("edit.undo"); await sleep(20);
    // Cancel: nothing made
    app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]); app.run("edit.circular"); await sleep(20);
    document.querySelector("#op-panel [data-a=cancel]").click(); await sleep(20);
    expect("circular copy: Cancel makes nothing", !app.op && app.doc.bodies.length === 1, app.doc.bodies.length);
    // Cut the whole ring by a level guide (C): behind the busy dialog; every copy cut like the original (z 2: 400 + 600 mm³)
    {
      app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]); app.run("edit.circular"); await sleep(20);
      app.applyOp(); await sleep(50);
      const g = app.doc.bodies[0].group, ids = app.doc.bodies.map((b) => b.id);
      app.doc.setGuides([{ a: [-200, -80, 2], b: [200, -80, 2], n: [0, 0, 1] }], "guide");
      const pl = app.cutPlane(0, ids);
      app.setSelection(ids.map((id) => ({ kind: "body", body: id, id: 0 })));
      app.opCut(ids, 0);
      const busy = document.getElementById("busy")?.textContent || "";
      for (let i = 0; i < 150 && document.getElementById("busy"); i++) await sleep(20);
      const vols = app.doc.bodies.map((b) => r(K.solidVolume(b.shape))), valid = app.doc.bodies.every((b) => K.isValidShape(b.shape));
      const out = centres().map((c) => r(Math.hypot(c[0], c[1]))), lows = ids.map((id) => r(app.doc.get(id).shape.boundingBox.bounds[1][2]));
      const sel = app.selection.map((x) => x.body).filter((id) => !ids.includes(id)).length;
      const groups = [...new Set(app.doc.bodies.map((b) => b.group))], top = g + " cut";
      const split = ids.every((id) => app.doc.get(id).group === g) && app.doc.bodies.filter((b) => b.group === top).length === 6;
      const icon = (gr) => { const ic = ol().querySelector('.ol-group[data-group="' + gr + '"] .ol-array'); return !!ic && !ic.classList.contains("off"); };
      const still = [g, top].map((gr) => app.arrayToChange(app.doc.bodies.filter((b) => b.group === gr).map((b) => b.id))?.group === gr && icon(gr));
      expect("cut a whole circular copy by a level guide: busy dialog, 12 valid pieces (6 × 400 below, 6 × 600 above), all 50 mm out, the upper 6 selected",
        Math.abs(pl.normal[2]) > 0.999 && /Cutting 6 objects/.test(busy) && app.doc.bodies.length === 12 && valid && vols.slice(0, 6).every((v) => v === 400) &&
          vols.slice(6).every((v) => v === 600) && out.every((x) => x === 50) && lows.every((z) => z === 2) && sel === 6,
        { normal: pl.normal, busy, vols, valid, out, lows, sel });
      expect("cut a circular copy: more than 4 upper pieces → their own group (" + g + " cut); both halves still circular copies (icons on)",
        split && groups.length === 2 && still.every(Boolean), { groups, split, still });
      app.run("edit.undo"); await sleep(20);
      const back = app.doc.bodies.length === 6 && app.doc.bodies.every((b) => r(K.solidVolume(b.shape)) === 1000);
      expect("cut a circular copy: one undo puts the 6 back whole", back, app.doc.bodies.length);
      app.run("edit.undo"); app.run("edit.undo"); await sleep(20); // (the guide, the ring)
    }
    // Round a vertical guide line at x = 50, y = 30 (3 copies → 120° about it)
    app.doc.setGuides([{ a: [50, 30, -10], b: [50, 30, 10] }], "guide");
    app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]); app.run("edit.circular"); await sleep(20);
    opValue("n", 3); opValue("axis", 3); app.applyOp(); await sleep(50);
    const gr = centres().map((c) => r(Math.hypot(c[0] - 50, c[1] - 30)));
    expect("circular copy: round a guide line → 3, each 30 mm from it", app.doc.bodies.length === 3 && gr.every((x) => x === 30), gr);
    app.run("edit.undo"); app.doc.setGuides([], "no guide"); await sleep(20);
    // Round a circle edge: a cylinder (r 20) at x = -80; click its top rim
    const cyl = app.doc.makeBody(K.makeCylinder(G, [-80, 0, 0], 20, 10), "Cylinder");
    app.doc.commit([...app.doc.bodies, cyl], "cylinder"); vp.fit(); await sleep(50);
    app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]); app.run("edit.circular"); await sleep(20);
    opValue("n", 4);
    const rim = vp.toScreen(new (vp.camera.position.constructor)(-80, -20, 10));
    app.op.spec.pick(new PointerEvent("pointerdown", { clientX: rim.x, clientY: rim.y, button: 0 }));
    const picked = document.querySelector("#op-panel [data-key=axis]").value;
    app.applyOp(); await sleep(50);
    const blocks = app.doc.bodies.filter((b) => b.id !== cyl.id), cr = blocks.map((b) => { const [p, q] = b.shape.boundingBox.bounds; return r(Math.hypot((p[0] + q[0]) / 2 + 80, (p[1] + q[1]) / 2)); });
    expect("circular copy: click a circle edge → round its centre (4 blocks, 130 mm from it)", blocks.length === 4 && cr.every((x) => x === 130), { picked, cr });
    app.doc.reset([]);
  } catch (e) {
    expect("circular copy threw", false, String(e && e.stack || e));
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("array scenario failed: " + JSON.stringify(failed));
  return [{ label: "array copy", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Groups: Ctrl+G / Ctrl+Shift+G, and in the Bodies panel — select, rename, hide, fold; saved in the file. */
const SCENARIO_GROUPS = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const ol = document.getElementById("outliner");
  app.doc.reset([]);
  const [a, b, c] = [0, 30, 60].map((x) => app.doc.makeBody(K.makeBox(G, [x, 0, 0], 10, 10, 10), "Leg"));
  app.doc.commit([a, b, c], "legs");
  app.run("mode.body");
  app.setSelection([a, b].map((x) => ({ kind: "body", body: x.id, id: 0 })));
  app.run("edit.group"); await sleep(20);
  const head = () => ol.querySelector(".ol-group");
  expect("groups: Ctrl+G groups the selection — a header (name, count) with the members under it (no array icon)",
    !head()?.querySelector(".ol-array") && app.doc.get(a.id).group === "Group 1" && app.doc.get(b.id).group === "Group 1" && !app.doc.get(c.id).group &&
      head()?.querySelector(".ol-name")?.textContent === "Group 1" && head()?.querySelector(".ol-count")?.textContent === "2" && ol.querySelectorAll(".ol-row.in-group").length === 2,
    { groups: [a, b, c].map((x) => app.doc.get(x.id).group), rows: [...ol.children].map((r) => r.textContent) });
  app.setSelection([]);
  head().querySelector(".ol-name").click(); await sleep(20);
  expect("groups: clicking the header selects the whole group", app.selection.map((s) => s.body).sort().join() === [a.id, b.id].sort().join() && head().classList.contains("selected"), app.selection);
  head().querySelector(".ol-name").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  const input = head().querySelector("input");
  input.value = "Legs"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(20);
  expect("groups: double-click renames the group (one undo step)", app.doc.get(a.id).group === "Legs" && app.doc.get(b.id).group === "Legs" && head().querySelector(".ol-name").textContent === "Legs",
    { groups: [a, b].map((x) => app.doc.get(x.id).group) });
  head().querySelector(".ol-eye").click(); await sleep(20);
  const hid = app.hidden.has(a.id) && app.hidden.has(b.id) && !app.hidden.has(c.id);
  head().querySelector(".ol-eye").click(); await sleep(20);
  head().querySelector(".ol-caret").click(); await sleep(20);
  const folded = ol.querySelectorAll(".ol-row.in-group").length;
  head().querySelector(".ol-caret").click(); await sleep(20);
  expect("groups: the eye hides / shows the group, ▸ folds it", hid && !app.hidden.has(a.id) && folded === 0 && ol.querySelectorAll(".ol-row.in-group").length === 2, { hid, folded });
  const back = (() => { app.loadModel(app.modelText(), null); return app.doc.bodies.map((x) => x.group || "").join(); })();
  expect("groups: saved in the file and read back", back === "Legs,Legs,", back);
  const [a2, b2] = app.doc.bodies;
  app.setSelection([{ kind: "body", body: a2.id, id: 0 }]);
  app.run("edit.ungroup"); await sleep(20);
  const apart = app.doc.bodies.every((x) => !x.group) && !ol.querySelector(".ol-group");
  app.run("edit.undo"); await sleep(20);
  expect("groups: Ctrl+Shift+G takes the group apart (all its members), undo puts it back", apart && app.doc.get(b2.id).group === "Legs" && !!head(), { apart });
  // A group of flat circles (like an Array copy): select the group, Push/Pull, Enter → the solids are still the group
  {
    const opValue = (k, v) => { const i = document.querySelector("#op-panel [data-key=" + k + "]"); if (i) { i.value = String(v); i.dispatchEvent(new Event("input", { bubbles: true })); } };
    const circles = [0, 30, 60].map((x, k) => ({ ...app.doc.makeBody(K.makeCircleFace({ ...G, origin: [0, 0, 0] }, [x, 100, 0], 8), k === 2 ? "Circle" : "Hole", "face"), group: "Holes" }));
    app.doc.commit([...app.doc.bodies, ...circles], "holes"); await sleep(20);
    [...ol.querySelectorAll(".ol-group")].find((h) => h.dataset.group === "Holes").querySelector(".ol-name").click(); await sleep(20);
    app.run("op.pushpull"); opValue("d", 12); await sleep(200);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true })); await sleep(100);
    const holes = app.doc.bodies.filter((x) => x.group === "Holes");
    const names = holes.map((x) => x.name);
    expect("groups: Push/Pull on a selected group of flat faces → the solids stay in the group, given names kept (automatic ones → Solid N)",
      holes.length === 3 && holes.every((x) => x.kind === "solid") && !app.doc.bodies.some((x) => x.kind === "face") &&
        names[0] === "Hole 1" && names[1] === "Hole 2" && /^Solid \d+$/.test(names[2]), app.doc.bodies.map((x) => [x.name, x.kind, x.group]));
    // Select a plate, "−", then click the group in the Bodies panel: the whole group is subtracted (one step)
    const plate = app.doc.makeBody(K.makeBox(G, [30, 100, 2], 100, 30, 6), "Plate");
    app.doc.commit([...app.doc.bodies, plate], "plate"); await sleep(20);
    app.setSelection([{ kind: "body", body: plate.id, id: 0 }]);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "-", code: "Minus", bubbles: true, cancelable: true })); await sleep(20);
    const toolOn = app.tool && app.tool.name;
    [...ol.querySelectorAll(".ol-group")].find((h) => h.dataset.group === "Holes").querySelector(".ol-name").click(); await sleep(50);
    const after = { holesLeft: app.doc.bodies.filter((x) => x.group === "Holes").length, plateFaces: app.doc.get(plate.id)?.shape.faces.length, tool: app.tool && app.tool.name };
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    expect("groups: plate selected, − then click the group in the Bodies panel → all its solids subtracted",
      toolOn === "Subtract" && after.holesLeft === 0 && after.plateFaces === 6 + 3 && after.tool === "Subtract", { toolOn, after });
    app.run("edit.undo"); await sleep(20);
    app.run("edit.undo"); await sleep(20);
    app.run("edit.undo"); await sleep(20);
  }
  // Bodies panel: Shift+click selects the rows from the last clicked one down — or up — to it; Ctrl+Shift adds; Ctrl toggles one
  {
    const ps = [0, 1, 2, 3, 4, 5].map((k) => app.doc.makeBody(K.makeBox(G, [k * 20, 60, 0], 10, 10, 10), "Post"));
    app.doc.commit([...app.doc.bodies, ...ps], "posts"); await sleep(20);
    const click = (p, o = {}) => ol.querySelector(".ol-row[data-id='" + p.id + "'] .ol-name").dispatchEvent(new MouseEvent("click", { bubbles: true, ...o }));
    const sel = () => app.selection.map((s) => ps.findIndex((p) => p.id === s.body)).sort().join();
    click(ps[1]); click(ps[4], { shiftKey: true });
    const down = sel();
    click(ps[2], { shiftKey: true });
    const shrink = sel();
    click(ps[4]); click(ps[0], { shiftKey: true });
    const up = sel();
    click(ps[5], { ctrlKey: true }); const ctrlAdd = sel();
    click(ps[5], { ctrlKey: true }); const ctrlOff = sel();
    click(ps[0]); click(ps[1], { shiftKey: true }); click(ps[4], { ctrlKey: true }); click(ps[5], { shiftKey: true, ctrlKey: true });
    const added = sel();
    expect("groups: Shift+click selects a range down or up (from the last clicked row), Ctrl+Shift adds a range, Ctrl toggles one",
      down === "1,2,3,4" && shrink === "1,2" && up === "0,1,2,3,4" && ctrlAdd === "0,1,2,3,4,5" && ctrlOff === "0,1,2,3,4" && added === "0,1,4,5",
      { down, shrink, up, ctrlAdd, ctrlOff, added });
    app.setSelection(ps.map((p) => ({ kind: "body", body: p.id, id: 0 }))); app.run("edit.delete"); await sleep(20);
  }
  // Guide lines: more than 4 from one Guide tool run → one group in the Bodies panel (select, hide, Del, undo); 3 → none
  {
    const plate = app.doc.makeBody(K.makeBox(G, [0, 100, 0], 40, 40, 10), "Plate");
    app.doc.commit([...app.doc.bodies, plate], "plate"); app.setSelection([]);
    const near = (p, y, z) => Math.abs(p.y - y) < 1e-6 && Math.abs(p.z - z) < 1e-6;
    const edge = app.doc.get(plate.id).shape.edges.find((e) => e.geomType === "LINE" && near(e.pointAt(0), 80, 10) && near(e.pointAt(1), 80, 10));
    const g0 = app.doc.guides.length;
    const addGuides = async (count) => {
      app.startGuide(plate.id, edge.hashCode); await sleep(20);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true })); await sleep(20);
      const dlg = document.getElementById("props-dlg"), ins = dlg ? [...dlg.querySelectorAll("input")] : [];
      [3, 0, count].forEach((v, k) => { if (ins[k]) ins[k].value = String(v); });
      dlg?.requestSubmit(); await sleep(30);
    };
    await addGuides(3);
    const few = app.doc.guides.length - g0, fewGrouped = app.doc.guides.some((g) => g.group), fewRows = ol.querySelectorAll(".ol-guides").length;
    await addGuides(6);
    const gh = () => ol.querySelector(".ol-guides");
    const inGroup = app.doc.guides.filter((g) => g.group === "Guides 1").length;
    expect("guides: 3 at once — no group; 6 at once — group \"Guides 1\" in the Bodies panel (name, count 6)",
      few === 3 && !fewGrouped && fewRows === 0 && app.doc.guides.length === g0 + 9 && inGroup === 6 && gh()?.querySelector(".ol-name")?.textContent === "Guides 1" && gh()?.querySelector(".ol-count")?.textContent === "6",
      { few, fewGrouped, fewRows, all: app.doc.guides.length - g0, inGroup, row: gh()?.textContent });
    gh().querySelector(".ol-name").click(); await sleep(20);
    const picked = app.selGuideGroup === "Guides 1" && gh().classList.contains("selected");
    gh().querySelector(".ol-eye").click(); await sleep(20);
    const hid = app.hiddenGuideGroups.has("Guides 1") && app.viewport.hiddenGuides.size === 6 && gh().classList.contains("hidden");
    gh().querySelector(".ol-eye").click(); await sleep(20);
    const shown = app.viewport.hiddenGuides.size === 0;
    gh().querySelector(".ol-name").click(); await sleep(20);
    app.run("edit.delete"); await sleep(20);
    const deleted = app.doc.guides.length === g0 + 3 && !gh();
    app.run("edit.undo"); await sleep(20);
    const back = app.doc.guides.filter((g) => g.group === "Guides 1").length === 6 && !!gh();
    expect("guides: click the group lights its lines, the eye hides / shows them, Del removes the 6, undo brings them back",
      picked && hid && shown && deleted && back, { picked, hid, shown, deleted, back });
    app.run("edit.clearGuides"); await sleep(20);
    app.doc.commit(app.doc.bodies.filter((b) => b.id !== plate.id), "drop plate"); await sleep(20);
  }
  head().querySelector(".ol-name").click(); window.ydddApp.viewport.fit(); await sleep(50); // (selected, for the screenshot)
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("groups scenario failed: " + JSON.stringify(failed));
  return [{ label: "groups", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Recent strip: no view commands; slots stay put — a new command takes the least recently used one's slot. */
const SCENARIO_RECENTSTRIP = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const strip = () => [...document.querySelectorAll("#recent-list [data-cmd]")].map((b) => b.dataset.cmd);
  const saved = { recent: app.recent, use: app.recentUse };
  app.recent = []; app.recentUse = []; app.renderRecent();
  app.run("view.iso"); app.run("view.front"); app.run("view.top"); await sleep(20);
  expect("recent strip: view commands (Iso / Front / Top) don't go in", strip().length === 0, strip());
  const cmds = ["tool.box", "tool.rectangle", "op.pushpull", "op.fillet", "op.chamfer", "op.shell", "op.cut", "xf.move", "xf.rotate", "xf.scale", "bool.subtract", "bool.union"];
  for (const c of cmds.slice(0, 10)) app.pushRecent(c);
  const full = strip();
  app.pushRecent("tool.box"); app.pushRecent("op.fillet"); // used again: nothing moves
  const same = strip();
  app.pushRecent("tool.rectangle");
  app.pushRecent("bool.subtract"); // full: takes the slot of the least recently used one (op.pushpull)
  const after = strip();
  expect("recent strip: using a command again doesn't move it",
    full.join() === cmds.slice(0, 10).join() && same.join() === full.join(), { full, same });
  expect("recent strip: when full, a new command takes the least recently used one's slot — the others stay put",
    after.length === 10 && after[2] === "bool.subtract" && after.filter((c, i) => i !== 2).join() === full.filter((c, i) => i !== 2).join(), after);
  app.pushRecent("bool.union"); // next least recently used: op.chamfer (slot 4)
  expect("recent strip: the next one replaces the next least recently used", strip()[4] === "bool.union", strip());
  // Drag "xf.scale" (last) onto the top half of "tool.box" (first) → it goes first; then "tool.box" below "op.fillet"
  const drag = (from, to, low) => {
    const btn = (c) => document.querySelector("#recent-list [data-cmd='" + c + "']");
    const dt = new DataTransfer(), a = btn(from), b = btn(to), r = b.getBoundingClientRect();
    const at = { clientX: r.left + r.width / 2, clientY: low ? r.bottom - 2 : r.top + 2, bubbles: true, cancelable: true, dataTransfer: dt };
    a.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: dt }));
    b.dispatchEvent(new DragEvent("dragover", at));
    const line = b.classList.contains(low ? "drop-after" : "drop-before");
    b.dispatchEvent(new DragEvent("drop", at));
    a.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: dt }));
    return line;
  };
  const line1 = drag("xf.scale", "tool.box", false);
  const up = strip();
  const line2 = drag("tool.box", "op.fillet", true);
  const down = strip();
  const kept = JSON.parse(localStorage.getItem("yddd.recentCmds.v2") || "[]").join() === down.join();
  app.pushRecent("op.shell");
  expect("recent strip: drag a button onto another to reorder (line shows above / below), saved; later uses don't undo it",
    line1 && line2 && up[0] === "xf.scale" && up[1] === "tool.box" && down.indexOf("tool.box") === down.indexOf("op.fillet") + 1 && kept && strip().join() === down.join(),
    { line1, line2, up, down, kept });
  // Right-click: a menu — on an icon "Remove …" + "Clear recent", on the empty strip just "Clear recent"; View → Clear Recent Tools too
  const n0 = strip().length;
  const menuAt = (el) => { el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 30, clientY: 300 })); const m = document.getElementById("popup-menu"); return m ? [...m.querySelectorAll("button")].map((b) => b.textContent) : null; };
  const pickItem = (label) => { const b = [...document.querySelectorAll("#popup-menu button")].find((x) => x.textContent === label); b?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0 })); };
  const iconMenu = menuAt(document.querySelector("#recent-list [data-cmd='op.cut']"));
  const stillAll = strip().length === n0; // (the menu alone changes nothing)
  pickItem(iconMenu && iconMenu[0]);
  const one = strip(), closed = !document.getElementById("popup-menu");
  const emptyMenu = menuAt(document.getElementById("recent"));
  pickItem("Clear recent");
  const cleared = strip();
  app.pushRecent("op.shell");
  app.run("view.clearRecent");
  const none = strip();
  const stored = JSON.parse(localStorage.getItem("yddd.recentCmds.v2") || "null");
  app.run("view.clearRecent"); // already empty: just says so
  expect("recent strip: right-click an icon → menu (Remove it / Clear recent): Remove takes just that one off; on the empty strip → Clear recent empties it; View → Clear Recent Tools too (saved)",
    iconMenu && iconMenu.length === 2 && /^Remove Cut/.test(iconMenu[0]) && iconMenu[1] === "Clear recent" && stillAll && one.length === n0 - 1 && !one.includes("op.cut") && closed
      && emptyMenu && emptyMenu.join() === "Clear recent" && cleared.length === 0 && none.length === 0 && Array.isArray(stored) && stored.length === 0,
    { n0, iconMenu, stillAll, one, closed, emptyMenu, cleared, none, stored });
  app.recent = saved.recent; app.recentUse = saved.use; app.renderRecent();
  localStorage.setItem("yddd.recentCmds.v2", JSON.stringify(saved.recent)); localStorage.setItem("yddd.recentUse", JSON.stringify(saved.use));
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("recent strip scenario failed: " + JSON.stringify(failed));
  return [{ label: "recent strip", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Mug handle flush: select the handle, −, click the cup (it's used up), tick "Keep the clicked solid" (it comes back),
 *  Done; the user deletes the stub inside the cup and joins handle and cup. */
const SCENARIO_KEEPTOOL = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport;
  const V = vp.camera.position.constructor;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const ev = (type, p) => { const s = vp.toScreen(new V(...p)); vp.canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
  const key = (k, code) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
  const panel = () => document.getElementById("tool-panel");
  const keepBox = () => panel()?.querySelector("input[data-act=keep]");
  const tick = (on) => { const b = keepBox(); b.checked = on; b.dispatchEvent(new Event("change", { bubbles: true })); };
  app.doc.reset([]);
  // A hollow cup (wall 15..20 from the centre) and a bar from x 10 to 30 through its wall
  const cup = app.doc.makeBody(K.booleanOp("subtract", K.makeBox(G, [0, 0, 0], 40, 40, 40), [K.makeBox(G, [0, 0, 5], 30, 30, 40)]), "Cup");
  const bar = app.doc.makeBody(K.makeBox(G, [20, 0, 10], 20, 6, 6), "Handle");
  app.doc.commit([cup, bar], "mug");
  app.run("mode.body"); app.run("view.iso"); vp.fit(); await sleep(50);
  app.setSelection([{ kind: "body", body: bar.id, id: 0 }]);
  key("-", "Minus"); await sleep(20);
  const before = !keepBox();
  ev("pointermove", [-17.5, 0, 40]); ev("pointerdown", [-17.5, 0, 40]); await sleep(80);
  const gone = !app.doc.get(cup.id) && app.doc.bodies.length === 2;
  const offered = keepBox() && !keepBox().checked;
  tick(true); await sleep(30);
  const back = !!app.doc.get(cup.id) && app.doc.bodies.length === 3;
  tick(false); await sleep(30);
  const againGone = !app.doc.get(cup.id);
  tick(true); await sleep(30);
  expect("subtract: click the cup → it's used up; then the panel offers 'Keep the clicked solid' — ticking brings it back, unticking takes it away",
    before && gone && offered && back && againGone && !!app.doc.get(cup.id), { before, gone, offered, back, againGone });
  expect("subtract: the panel lists no pieces", !panel()?.querySelector(".tp-piece") && !/mm³/.test(panel()?.textContent), panel()?.textContent);
  panel()?.querySelector("button[data-act=done]")?.click(); await sleep(30);
  const vols = app.doc.bodies.filter((b) => b.id !== cup.id).map((b) => Math.round(K.solidVolume(b.shape))).sort((a, b) => a - b);
  expect("subtract: Done exits; the handle is in 2 pieces (outside, stub inside the cup), the target selected",
    !app.tool && !panel() && vols.join() === "180,360" && app.selection.length === 1 && app.selection[0].body === bar.id, { vols, sel: app.selection });
  // The user removes the stub, then joins
  const stub = app.doc.bodies.find((b) => b.id !== cup.id && Math.round(K.solidVolume(b.shape)) === 180);
  app.setSelection([{ kind: "body", body: stub.id, id: 0 }]); app.run("edit.delete"); await sleep(20);
  app.setSelection([{ kind: "body", body: cup.id, id: 0 }]);
  key("+", "Equal"); await sleep(20);
  const handle = app.doc.bodies.find((b) => b.id !== cup.id);
  app.outlinerPick && app.outlinerPick([handle.id]); await sleep(50);
  const unionBox = !!keepBox();
  panel()?.querySelector("button[data-act=done]")?.click(); await sleep(30);
  const one = app.doc.bodies.length === 1 && Math.round(K.solidVolume(app.doc.bodies[0].shape));
  const cupVol = 40 * 40 * 40 - 30 * 30 * 35;
  expect("then Del the stub and + joins handle and cup — one solid, nothing inside (Union has no Keep option)", one === cupVol + 360 && !unionBox, { one, want: cupVol + 360, unionBox });
  // Pro layout: the panel is short — target, count, option, Done
  {
    const wasPro = document.body.classList.contains("pro");
    document.body.classList.add("pro");
    const c2 = app.doc.makeBody(K.makeBox(G, [100, 0, 0], 10, 10, 10), "Peg");
    app.doc.commit([...app.doc.bodies, c2], "peg");
    app.setSelection([{ kind: "body", body: cup.id, id: 0 }]);
    key("-", "Minus"); await sleep(20);
    const first = panel()?.textContent;
    app.outlinerPick && app.outlinerPick([c2.id]); await sleep(50);
    const after = panel()?.textContent;
    key("Escape", "Escape"); await sleep(20);
    document.body.classList.toggle("pro", wasPro);
    expect("subtract, Pro layout: less text — no how-to lines; the count and Keep after a click",
      first === "SubtractTarget: " + app.doc.get(cup.id).name + "Done ⏎" && /1 done/.test(after) && /Keep the clicked solid/.test(after) && !/Click a solid|Esc/.test(after), { first, after });
  }
  app.doc.reset([]);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("keep tool scenario failed: " + JSON.stringify(failed));
  return [{ label: "subtract keep", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Subtract / Union / Intersect and Cut show a panel (target, what to click, count) with Done / Cancel. */
/** Resize holes / pins: Edge mode, click a round hole's rim (or several), S → its diameter. */
const SCENARIO_HOLES = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const r = (x) => Math.round(x * 1000) / 1000;
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const opValue = (k, v) => { const i = document.querySelector("#op-panel [data-key=" + k + "]"); if (i) { i.value = String(v); i.dispatchEvent(new Event("input", { bubbles: true })); } };
  const fieldVal = (k) => document.querySelector("#op-panel [data-key=" + k + "]")?.value;
  const vol = (id) => K.solidVolume(app.doc.get(id).shape);
  /** The circle edge of body id centred at (x, y, z) with radius rad. */
  const rimAt = (id, [x, y, z], rad) => {
    const b = app.doc.get(id);
    const e = b.shape.edges.find((e) => {
      if (e.geomType !== "CIRCLE") return false;
      const p = e.pointAt(0), q = e.pointAt(0.5);
      const c = [(p.x + q.x) / 2, (p.y + q.y) / 2];
      return Math.abs(p.z - z) < 1e-6 && Math.abs(Math.hypot(p.x - x, p.y - y) - rad) < 1e-6;
    });
    return e ? { kind: "edge", body: id, id: e.hashCode } : null;
  };
  /** The hole / pin through the rim at (x, y, z) now, from any of its rims there: its diameter. */
  const diaAt = (id, xyz) => {
    const b = app.doc.get(id);
    for (const e of b.shape.edges) {
      if (e.geomType !== "CIRCLE") continue;
      const rim = K.roundRim(b.shape, e.hashCode);
      if (rim && Math.abs(rim.center[0] - xyz[0]) < 1e-6 && Math.abs(rim.center[1] - xyz[1]) < 1e-6 && Math.abs(rim.center[2] - xyz[2]) < 1e-6) return r(rim.diameter);
    }
    return null;
  };
  const resize = async (items) => {
    app.run("mode.edge"); app.setSelection(items.filter(Boolean)); await sleep(20);
    app.run("xf.scale"); await sleep(50);
    return { title: app.op && app.op.spec.title, d: fieldVal("d"), c: fieldVal("c"), note: document.querySelector("#op-panel")?.textContent || "" };
  };
  try {
    app.doc.reset([]);
    // A 60 × 40 × 10 plate: through holes Ø8 at x −20 and 0, Ø6 at x 20; a blind Ø5 hole 6 deep at (0, 12)
    const through = [[-20, 0, 4], [0, 0, 4], [20, 0, 3]].map(([x, y, rad]) => K.makeCylinder(G, [x, y, -1], rad, 12));
    const plateShape = K.booleanOp("subtract", K.makeBox(G, [0, 0, 0], 60, 40, 10), [...through, K.makeCylinder(G, [0, 12, 4], 2.5, 7)]);
    const plate = app.doc.makeBody(plateShape, "Plate");
    // A block with a Ø10 pin 5 tall on top, at x 60
    const block = app.doc.makeBody(K.booleanOp("union", K.makeBox(G, [60, 0, 0], 20, 20, 10), [K.makeCylinder(G, [60, 0, 10], 5, 5)]), "Block");
    app.doc.commit([plate, block], "plate + block");
    vp.setView("iso"); vp.fit(); await sleep(50);
    const v0 = vol(plate.id);

    // One hole: its top rim, S → Resize hole, Diameter 8; type 8.4 → Ø8.4 through, the plate lost exactly that ring
    const one = await resize([rimAt(plate.id, [-20, 0, 10], 4)]);
    opValue("d", 8.4); await sleep(100);
    const ghost = app.op && app.op.result ? app.op.result.ghost.size : -1;
    app.applyOp(); await sleep(50);
    const d1 = diaAt(plate.id, [-20, 0, 10]), lost = r(v0 - vol(plate.id)), want = r(Math.PI * (4.2 * 4.2 - 16) * 10);
    expect("resize hole: rim + S → 'Resize hole (1 hole)', Diameter 8; 8.4 → the hole is Ø8.4, the plate exactly the ring less, valid, one step",
      one.title === "Resize hole (1 hole)" && one.d === "8" && ghost === 1 && d1 === 8.4 && Math.abs(lost - want) < 1e-3 && K.isValidShape(app.doc.get(plate.id).shape) && app.doc.undoLabel === "Resize hole",
      { one, ghost, d1, lost, want });
    app.run("edit.undo"); await sleep(20);
    const back = diaAt(plate.id, [-20, 0, 10]);
    expect("resize hole: one undo → Ø8 again", back === 8 && r(vol(plate.id)) === r(v0), { back });

    // Two Ø8 holes, three rims (one hole's top and bottom): counted as 2 holes; 9 → both Ø9
    const two = await resize([rimAt(plate.id, [-20, 0, 10], 4), rimAt(plate.id, [-20, 0, 0], 4), rimAt(plate.id, [0, 0, 10], 4)]);
    opValue("d", 9); await sleep(50); app.applyOp(); await sleep(50);
    const d2 = [diaAt(plate.id, [-20, 0, 10]), diaAt(plate.id, [0, 0, 10])];
    expect("resize holes: two Ø8 (one picked top and bottom) → 'Resize hole (2 holes)'; 9 → both Ø9", two.title === "Resize hole (2 holes)" && d2.join() === "9,9", { two, d2 });
    app.run("edit.undo"); await sleep(20);

    // Different sizes (Ø8 and Ø6): 'Bigger by' — +0.5 → Ø8.5 and Ø6.5
    const mixed = await resize([rimAt(plate.id, [0, 0, 10], 4), rimAt(plate.id, [20, 0, 10], 3)]);
    opValue("c", 0.5); await sleep(50); app.applyOp(); await sleep(50);
    const d3 = [diaAt(plate.id, [0, 0, 10]), diaAt(plate.id, [20, 0, 10])];
    expect("resize holes: Ø8 and Ø6 → a 'Bigger by' field (Ø 8 / 6 in the note); +0.5 → Ø8.5 and Ø6.5",
      mixed.c === "0" && mixed.d === undefined && /Ø 8 \/ 6/.test(mixed.note) && d3.join() === "8.5,6.5", { mixed, d3 });
    app.run("edit.undo"); await sleep(20);

    // The blind hole: Ø5 → 6, still 6 deep with a flat bottom (exactly the ring less)
    const vb = vol(plate.id);
    await resize([rimAt(plate.id, [0, 12, 10], 2.5)]);
    opValue("d", 6); await sleep(50); app.applyOp(); await sleep(50);
    const lostB = r(vb - vol(plate.id)), wantB = r(Math.PI * (9 - 6.25) * 6);
    expect("resize a blind hole: Ø5 → 6, still 6 deep (exactly the ring less)", diaAt(plate.id, [0, 12, 10]) === 6 && Math.abs(lostB - wantB) < 1e-3, { lostB, wantB });
    app.run("edit.undo"); await sleep(20);

    // A pin: its top rim → 'Resize pin'; Ø10 → 11 adds exactly the ring
    const vp0 = vol(block.id);
    const pin = await resize([rimAt(block.id, [60, 0, 15], 5)]);
    opValue("d", 11); await sleep(50); app.applyOp(); await sleep(50);
    const gained = r(vol(block.id) - vp0), wantP = r(Math.PI * (5.5 * 5.5 - 25) * 5);
    expect("resize a pin: its rim + S → 'Resize pin (1 pin)'; Ø10 → 11 adds exactly the ring", pin.title === "Resize pin (1 pin)" && diaAt(block.id, [60, 0, 15]) === 11 && Math.abs(gained - wantP) < 1e-3, { pin, gained, wantP });
    app.run("edit.undo"); await sleep(20);

    // A hole and a pin (two objects): +1 → each 1 mm wider
    const both = await resize([rimAt(plate.id, [20, 0, 10], 3), rimAt(block.id, [60, 0, 15], 5)]);
    opValue("c", 1); await sleep(50); app.applyOp(); await sleep(50);
    const d4 = [diaAt(plate.id, [20, 0, 10]), diaAt(block.id, [60, 0, 15])];
    expect("resize a hole and a pin together: '1 hole + 1 pin'; +1 → Ø7 and Ø11", both.title === "Resize holes / pins (1 hole + 1 pin)" && d4.join() === "7,11", { both, d4 });
    app.run("edit.undo"); await sleep(20);

    // Too small: Ø6 − 7 would close it → an error, nothing changed
    const n0 = app.doc.undoLabel;
    await resize([rimAt(plate.id, [0, 0, 10], 4), rimAt(plate.id, [20, 0, 10], 3)]);
    opValue("c", -7); await sleep(50); app.applyOp(); await sleep(50);
    const unchanged = app.doc.undoLabel === n0 && diaAt(plate.id, [20, 0, 10]) === 6;
    if (app.op) document.querySelector("#op-panel [data-a=cancel]")?.click();
    await sleep(20);
    expect("resize holes: smaller than nothing → refused, nothing changed", unchanged, { label: app.doc.undoLabel });

    // A hole whose wall is in two halves (split by a guide across it): one half-rim resizes both halves
    {
      const sh = app.doc.get(plate.id).shape, rim = rimAt(plate.id, [-20, 0, 10], 4);
      const edge = sh.edges.find((e) => e.hashCode === rim.id);
      const wall = sh.faces.find((f) => f.geomType === "CYLINDRE" && f.edges.some((e) => e.isSame(edge)));
      app.doc.setGuides([{ a: [-20, -30, 10], b: [-20, 30, 10], n: [1, 0, 0] }], "guide");
      app.opSplitFace(new Map([[plate.id, [wall.hashCode]]]), 0); await sleep(30);
      const said = [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent).pop();
      const splitOk = app.doc.undoLabel === "Split face";
      const walls = app.doc.get(plate.id).shape.faces.filter((f) => f.geomType === "CYLINDRE" && f.edges.some((e) => e.geomType === "CIRCLE" && Math.abs(e.pointAt(0).z - 10) < 1e-6 && Math.abs(Math.hypot(e.pointAt(0).x + 20, e.pointAt(0).y) - 4) < 1e-6)).length;
      const half = await resize([rimAt(plate.id, [-20, 0, 10], 4)]);
      const vh = vol(plate.id);
      opValue("d", 8.4); await sleep(50); app.applyOp(); await sleep(50);
      const lostH = r(vh - vol(plate.id)), wantH = r(Math.PI * (4.2 * 4.2 - 16) * 10);
      expect("resize a hole whose wall is split in pieces: one piece's rim → 'Resize hole (1 hole)'; 8.4 → the whole wall Ø8.4 (exactly the ring less), valid",
        walls >= 2 && half.title === "Resize hole (1 hole)" && Math.abs(lostH - wantH) < 1e-3 && K.isValidShape(app.doc.get(plate.id).shape), { walls, half, lostH, wantH, said });
      app.run("edit.undo"); if (splitOk) app.run("edit.undo"); app.run("edit.undo"); await sleep(20); // (resize, split, guide)
    }
    // Delete with rims selected: holes filled, pins taken off
    {
      const del = async (items) => { app.run("mode.edge"); app.setSelection(items); await sleep(20); app.run("edit.delete"); await sleep(50); };
      const cyls = (id) => app.doc.get(id).shape.faces.filter((f) => f.geomType === "CYLINDRE").length;
      const va = vol(plate.id), ca = cyls(plate.id);
      await del([rimAt(plate.id, [-20, 0, 10], 4)]);
      const gainA = r(vol(plate.id) - va), wantA = r(Math.PI * 16 * 10);
      expect("delete a hole's rim (Del): the hole filled (exactly Ø8 × 10 more), one round wall fewer, valid, 'Fill 1 hole', the plate selected",
        Math.abs(gainA - wantA) < 1e-3 && cyls(plate.id) < ca && diaAt(plate.id, [-20, 0, 10]) === null && K.isValidShape(app.doc.get(plate.id).shape) &&
          app.doc.undoLabel === "Fill 1 hole" && app.mode === "body" && app.selection.length === 1 && app.selection[0].body === plate.id, { gainA, wantA, label: app.doc.undoLabel, mode: app.mode });
      app.run("edit.undo"); await sleep(20);
      const vb2 = vol(plate.id);
      await del([rimAt(plate.id, [0, 12, 10], 2.5)]);
      const gainB = r(vol(plate.id) - vb2), wantB2 = r(Math.PI * 6.25 * 6);
      expect("delete a blind hole's rim: filled with its bottom (exactly Ø5 × 6 more)", Math.abs(gainB - wantB2) < 1e-3 && K.isValidShape(app.doc.get(plate.id).shape), { gainB, wantB2 });
      app.run("edit.undo"); await sleep(20);
      await del([rimAt(plate.id, [0, 0, 10], 4), rimAt(plate.id, [20, 0, 10], 3), rimAt(block.id, [60, 0, 15], 5)]);
      const vBlock = r(vol(block.id)), label = app.doc.undoLabel, gainC = r(vol(plate.id) - vb2), wantC = r(Math.PI * (16 + 9) * 10);
      expect("delete 2 holes and a pin at once (two objects): 'Fill 2 holes, Remove 1 pin' — the block back to 20 × 20 × 10, both holes filled; one undo",
        label === "Fill 2 holes, Remove 1 pin" && vBlock === 4000 && Math.abs(gainC - wantC) < 1e-3, { label, vBlock, gainC, wantC });
      app.run("edit.undo"); await sleep(20);
      // A plain box with one hole: filled, it is a plain box again (6 faces, 12 edges, 8 corners — no seams left)
      {
        const box = app.doc.makeBody(K.booleanOp("subtract", K.makeBox(G, [0, 80, 0], 30, 20, 10), [K.makeCylinder(G, [0, 80, -1], 4, 12)]), "Holed box");
        app.doc.commit([...app.doc.bodies, box], "holed box"); await sleep(20);
        const before = { faces: app.doc.get(box.id).shape.faces.length, edges: app.doc.get(box.id).shape.edges.length };
        await del([rimAt(box.id, [0, 80, 10], 4)]);
        const sh = app.doc.get(box.id).shape, plain = K.makeBox(G, [0, 80, 0], 30, 20, 10);
        const corners = new Set(sh.edges.flatMap((e) => [e.startPoint, e.endPoint].map((p) => [p.x, p.y, p.z].map(r).join()))).size;
        const after = { faces: sh.faces.length, edges: sh.edges.length, corners, types: [...new Set(sh.faces.map((f) => f.geomType))], file: K.serializeShape(sh).length, plainFile: K.serializeShape(plain).length };
        expect("fill the hole of a plain box: a plain box again — 6 flat faces, 12 edges, 8 corners, about as small saved as a new box",
          before.faces === 7 && after.faces === 6 && after.edges === 12 && corners === 8 && after.types.join() === "PLANE" && after.file < after.plainFile * 1.5 && r(vol(box.id)) === 6000,
          { before, after });
        app.run("edit.undo"); app.run("edit.undo"); await sleep(20);
      }
      expect("delete holes: undo → all back", r(vol(plate.id)) === r(vb2) && diaAt(block.id, [60, 0, 15]) === 10, { v: vol(plate.id) });
    }
    // Holes of any shape: a 10 × 6 rectangle and a 16 × 6 slot through, a hexagon pocket 6 deep (r 4) — one edge of the rim picks the hole
    {
      const hex = K.makePolygonFace(G, [0, -70, 4], 4, 6, 0);
      const cutters = [
        K.makeBox(G, [-18, -80, -1], 10, 6, 12),
        K.booleanOp("union", K.makeBox(G, [12, -80, -1], 10, 6, 12), [K.makeCylinder(G, [7, -80, -1], 3, 12), K.makeCylinder(G, [17, -80, -1], 3, 12)]),
        K.extrudeFace(hex, hex.faces[0].hashCode, 7),
      ];
      const holed = app.doc.makeBody(K.booleanOp("subtract", K.makeBox(G, [0, -80, 0], 60, 40, 10), cutters), "Holed");
      app.doc.commit([...app.doc.bodies, holed], "holed plate"); await sleep(20);
      /** An edge of the top rim through (x, y, 10): the one nearest it. */
      const topEdge = (x, y) => {
        const es = app.doc.get(holed.id).shape.edges.filter((e) => Math.abs(e.startPoint.z - 10) < 1e-6 && Math.abs(e.endPoint.z - 10) < 1e-6 && Math.abs(Math.abs(e.startPoint.x) - 30) > 1e-6 && Math.abs(e.startPoint.y + 80) < 19.9);
        const d = (e) => Math.hypot(e.pointAt(0.5).x - x, e.pointAt(0.5).y - y);
        return { kind: "edge", body: holed.id, id: es.sort((a, b) => d(a) - d(b))[0].hashCode };
      };
      const hv = () => vol(holed.id), base = hv();
      const hexArea = 3 * Math.sqrt(3) / 2 * 16, slotArea = 10 * 6 + Math.PI * 9;
      expect("any-shape holes: the plate has the 3 holes (its volume)", Math.abs(r(base) - r(24000 - 600 - slotArea * 10 - hexArea * 6)) < 1e-3, { base });
      // Del on one edge of each: the rectangle, the slot (a round end's edge), the hexagon pocket
      const delOne = async (item) => { app.run("mode.edge"); app.setSelection([item]); await sleep(20); app.run("edit.delete"); await sleep(50); const g = r(hv() - base), l = app.doc.undoLabel, ok = K.isValidShape(app.doc.get(holed.id).shape), f = app.doc.get(holed.id).shape.faces.length; app.run("edit.undo"); await sleep(20); return { g, l, ok, f }; };
      const dr = await delOne(topEdge(-18, -77)), ds = await delOne(topEdge(2, -80)), dh = await delOne(topEdge(0, -66));
      expect("delete a rectangle hole (one rim edge + Del): filled (exactly 10 × 6 × 10 more), 'Fill 1 hole', valid", Math.abs(dr.g - 600) < 1e-3 && dr.l === "Fill 1 hole" && dr.ok, dr);
      expect("delete a slot hole (an edge of its round end): filled (exactly the slot × 10)", Math.abs(ds.g - r(slotArea * 10)) < 1e-3 && ds.ok, ds);
      expect("delete a hexagon pocket: filled with its floor (exactly the hexagon × 6)", Math.abs(dh.g - r(hexArea * 6)) < 1e-3 && dh.ok, dh);
      // All three filled at once: a plain box again (6 faces)
      app.run("mode.edge"); app.setSelection([topEdge(-18, -77), topEdge(2, -80), topEdge(0, -66)]); await sleep(20); app.run("edit.delete"); await sleep(50);
      const allF = { faces: app.doc.get(holed.id).shape.faces.length, v: r(hv()), label: app.doc.undoLabel };
      expect("delete all 3 at once: 'Fill 3 holes' — a plain box again (6 faces, 60 × 40 × 10)", allF.faces === 6 && allF.v === 24000 && allF.label === "Fill 3 holes", allF);
      app.run("edit.undo"); await sleep(20);
      // S on the rectangle's rim: 'Bigger by' — +1 → 11 × 7, still 4 flat walls (sharp corners)
      const sz = async (items, c) => {
        app.run("mode.edge"); app.setSelection(items); await sleep(20); app.run("xf.scale"); await sleep(50);
        const t = app.op && app.op.spec.title, f = fieldVal("c"), dragOn = !!(app.op && app.op.spec.drag);
        opValue("c", c); await sleep(50); app.applyOp(); await sleep(50);
        const out = { t, f, dragOn, lost: r(base - hv()), ok: K.isValidShape(app.doc.get(holed.id).shape), faces: app.doc.get(holed.id).shape.faces.length, label: app.doc.undoLabel };
        app.run("edit.undo"); await sleep(20);
        return out;
      };
      const f0 = app.doc.get(holed.id).shape.faces.length;
      const sr = await sz([topEdge(-18, -77)], 1);
      expect("resize a rectangle hole (rim edge + S): 'Resize hole (1 hole)', a 'Bigger by' field and a drag ring; +1 → 11 × 7 (exactly), sharp corners (no new faces)",
        sr.t === "Resize hole (1 hole)" && sr.f === "0" && sr.dragOn && Math.abs(sr.lost - 170) < 1e-3 && sr.ok && sr.faces === f0 && sr.label === "Resize hole", { sr, f0 });
      const ss = await sz([topEdge(2, -80)], 1);
      const wantS = r((10 * 7 + Math.PI * 3.5 * 3.5 - slotArea) * 10);
      expect("resize a slot: +1 → 7 wide, ends Ø7 (exactly)", Math.abs(ss.lost - wantS) < 1e-3 && ss.ok, { ss, wantS });
      const sh = await sz([topEdge(0, -66)], 1);
      const wantH = r((3 * Math.sqrt(3) / 2 * (4 + 1 / Math.sqrt(3)) ** 2 - hexArea) * 6);
      expect("resize a hexagon pocket: +1 across the flats → each wall 0.5 out, still 6 deep (exactly)", Math.abs(sh.lost - wantH) < 1e-3 && sh.ok, { sh, wantH });
      const s3 = await sz([topEdge(-18, -77), topEdge(2, -80), topEdge(0, -66)], -0.5);
      expect("resize all 3 at once: '3 holes'; −0.5 → each smaller (the plate gains)", s3.t === "Resize hole (3 holes)" && s3.lost < 0 && s3.ok, s3);
      // Click one edge of a rim (Edge mode, Top view): the whole rim is selected; again: just that edge; Shift+click another hole: added
      {
        const V = vp.camera.position.constructor, canvas = vp.canvas;
        const clickEdge = (item, mods = {}) => {
          const e = app.doc.get(holed.id).shape.edges.find((x) => x.hashCode === item.id), m = e.pointAt(0.5), s = vp.toScreen(new V(m.x, m.y, m.z));
          for (const t of ["pointermove", "pointerdown", "pointerup"]) canvas.dispatchEvent(new PointerEvent(t, { clientX: s.x, clientY: s.y, button: 0, bubbles: true, ...mods }));
        };
        app.run("mode.edge"); app.setSelection([]); vp.setView("top"); vp.fit([holed.id]); await sleep(80);
        const rectEdge = topEdge(-18, -77);
        clickEdge(rectEdge); await sleep(30);
        const whole = app.selection.length, hintW = document.getElementById("status-hint")?.textContent || "";
        clickEdge(rectEdge); await sleep(30);
        const justOne = app.selection.length === 1 && app.selection[0].id === rectEdge.id;
        clickEdge(rectEdge); await sleep(30); // (the whole rim again)
        clickEdge(topEdge(0, -66), { shiftKey: true }); await sleep(30);
        const both = app.selection.length;
        app.run("xf.scale"); await sleep(50);
        const t2 = app.op && app.op.spec.title;
        if (app.op) document.querySelector("#op-panel [data-a=cancel]")?.click();
        await sleep(20);
        expect("click one edge of a rectangle hole's rim: the whole rim (4 edges), the hint says so; click it again: just that edge; Shift+click the hexagon's: added (10); S → 2 holes",
          whole === 4 && /Hole rim \(4 edges\)/.test(hintW) && justOne && both === 10 && t2 === "Resize hole (2 holes)", { whole, hintW, justOne, both, t2 });
        vp.setView("iso"); app.setSelection([]);
      }
      // A plate's outer edge isn't a hole's rim: Del still says to select objects, S is the usual Scale
      const outer = app.doc.get(holed.id).shape.edges.find((e) => Math.abs(e.startPoint.x - 30) < 1e-6 && Math.abs(e.endPoint.x - 30) < 1e-6);
      app.run("mode.edge"); app.setSelection([{ kind: "edge", body: holed.id, id: outer.hashCode }]); await sleep(20);
      app.run("edit.delete"); await sleep(20);
      const kept = app.doc.bodies.some((b) => b.id === holed.id) && app.doc.undoLabel === "holed plate";
      expect("an outer edge + Del: not a hole — nothing changes", kept, app.doc.undoLabel);
      app.run("edit.undo"); await sleep(20);
    }
    // A straight edge (not a rim) + S: the usual Scale
    const straight = app.doc.get(plate.id).shape.edges.find((e) => e.geomType === "LINE");
    app.run("mode.edge"); app.setSelection([{ kind: "edge", body: plate.id, id: straight.hashCode }]); await sleep(20);
    app.run("xf.scale"); await sleep(50);
    const t = app.op && app.op.spec.title;
    if (app.op) document.querySelector("#op-panel [data-a=cancel]")?.click();
    expect("S with a straight edge selected: the usual Scale", t === "Scale", t);
    app.doc.reset([]);
    // A Ø12 hole drilled at a slant through a dome (R21): its rims an ellipse on the base and a
    // free-form curve on the dome — still a round hole. S on the ellipse → Ø14; Del fills it.
    {
      const a = 50 * Math.PI / 180, axis = [0, -Math.sin(a), Math.cos(a)];
      const tilt = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, Math.cos(a), Math.sin(a)], z: axis };
      const dome = K.booleanOp("subtract", K.makeSphereAt([0, 0, 0], 21), [K.makeBox(G, [0, 0, -30], 60, 60, 30)]);
      const domeVol = K.solidVolume(dome);
      const drilled = app.doc.makeBody(K.booleanOp("subtract", dome, [K.makeCylinder(tilt, [0, 25 * Math.sin(a), -25 * Math.cos(a)], 6, 60)]), "Drilled dome");
      app.doc.commit([drilled], "drilled dome"); await sleep(20);
      const v1 = vol(drilled.id);
      const ellipse = app.doc.get(drilled.id).shape.edges.find((e) => e.geomType === "ELLIPSE");
      const slant = await resize([{ kind: "edge", body: drilled.id, id: ellipse.hashCode }]);
      opValue("d", 14); await sleep(100);
      app.applyOp(); await sleep(50);
      const err = document.querySelector("#op-panel .op-error")?.textContent || "";
      if (app.op) document.querySelector("#op-panel [data-a=cancel]")?.click();
      const s = app.doc.get(drilled.id).shape, v2 = K.solidVolume(s);
      const dias = [...new Set(s.edges.map((e) => K.roundRim(s, e.hashCode)).filter(Boolean).map((x) => r(x.diameter)))];
      expect("a hole at a slant through a dome: its ellipse rim + S → 'Resize hole (1 hole)', Diameter 12; 14 → Ø14 (from either rim), less volume, valid",
        slant.title === "Resize hole (1 hole)" && slant.d === "12" && dias.length === 1 && dias[0] === 14 && v2 < v1 - 100 && K.isValidShape(s) && app.doc.undoLabel === "Resize hole",
        { slant, err, dias, v1: r(v1), v2: r(v2) });
      const rim = s.edges.find((e) => e.geomType === "ELLIPSE");
      app.run("mode.edge"); app.setSelection([{ kind: "edge", body: drilled.id, id: rim.hashCode }]); await sleep(20);
      app.run("edit.delete"); await sleep(50);
      const filled = vol(drilled.id);
      expect("…its rim + Del: the hole filled, the whole dome back", Math.abs(filled - domeVol) < 1e-3 * domeVol && K.isValidShape(app.doc.get(drilled.id).shape), { filled: r(filled), domeVol: r(domeVol) });
    }
    app.doc.reset([]);
  } catch (e) {
    expect("resize holes threw", false, String(e && e.stack || e));
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("resize holes scenario failed: " + JSON.stringify(failed));
  return [{ label: "resize holes", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

const SCENARIO_TOOLPANEL = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport;
  const V = vp.camera.position.constructor;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const ev = (type, p) => { const s = vp.toScreen(new V(...p)); vp.canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
  const panel = () => document.getElementById("tool-panel");
  const key = (k, code) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
  for (const [k, code, name] of [["-", "Minus", "Subtract"], ["+", "Equal", "Union"]]) {
    app.doc.reset([]);
    const a = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 40, 40, 10), "Plate"), b = app.doc.makeBody(K.makeBox(G, [0, 0, 5], 10, 10, 20), "Peg");
    app.doc.commit([a, b], "two");
    app.run("mode.body"); app.run("view.iso"); vp.fit(); await sleep(50);
    app.setSelection([{ kind: "body", body: a.id, id: 0 }]);
    key(k, code); await sleep(20);
    const open = { tool: app.tool && app.tool.name, title: panel()?.querySelector("h4")?.textContent, text: panel()?.textContent };
    ev("pointermove", [0, 0, 25]); ev("pointerdown", [0, 0, 25]); await sleep(50);
    const after = { bodies: app.doc.bodies.length, count: panel()?.querySelector(".tp-count")?.textContent, tool: app.tool && app.tool.name };
    panel()?.querySelector("button[data-act=done]")?.click(); await sleep(20);
    expect(name + ": the tool shows a panel (target, what to click), counts what's done, Done finishes and closes it",
      open.tool === name && open.title === name && /Plate/.test(open.text) && after.bodies === 1 && after.count === "1 done" && after.tool === name &&
        !app.tool && !panel() && app.selection.length === 1 && app.selection[0].body === a.id, { open, after, tool: app.tool && app.tool.name, panel: !!panel() });
  }
  // Esc closes it too
  app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]);
  key("-", "Minus"); await sleep(20);
  const had = !!panel();
  key("Escape", "Escape"); await sleep(20);
  expect("Subtract: Esc finishes and closes the panel", had && !app.tool && !panel(), { had, tool: app.tool && app.tool.name });
  // Cut: panel with Cancel
  app.setSelection([{ kind: "body", body: app.doc.bodies[0].id, id: 0 }]);
  app.run("op.cut"); await sleep(20);
  const cut = { tool: app.tool && app.tool.name, text: panel()?.textContent, name: app.doc.bodies[0].name };
  panel()?.querySelector("button[data-act=done]")?.click(); await sleep(20);
  expect("Cut: shows a panel (what's cut, guide or axis) — Cancel exits the tool, nothing cut",
    cut.tool === "Cut" && cut.text.includes(cut.name) && /axis/.test(cut.text) && !app.tool && !panel() && app.doc.bodies.length === 1, { cut, tool: app.tool && app.tool.name });
  app.doc.reset([]);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("tool panel scenario failed: " + JSON.stringify(failed));
  return [{ label: "tool panel", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Cut by an axis: 1, select the cube, C, click the red X axis line — no guide needed; the plane follows the view. */
const SCENARIO_CUTAXIS = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport;
  const V = vp.camera.position.constructor;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const r = (x) => Math.round(x * 1000) / 1000;
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const ev = (type, p) => { const s = vp.toScreen(new V(...p)); vp.canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
  const cutAt = async (view, p) => {
    app.doc.reset([]);
    const cube = app.doc.makeBody(K.makeBox(G, [0, 0, -10], 20, 20, 20), "Cube"); // (centred on X / Y)
    app.doc.commit([cube], "cube");
    app.run("mode.body"); app.run(view); vp.fit(); await sleep(50);
    app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
    app.run("op.cut"); await sleep(20);
    const tool = app.tool && app.tool.name;
    ev("pointermove", p); await sleep(20);
    ev("pointerdown", p); await sleep(50);
    return { tool, boxes: app.doc.bodies.map((b) => b.shape.boundingBox.bounds.map((c) => c.map(r))) };
  };
  // No guides in the file: Cut still starts, and the X axis (beyond the cube) cuts it.
  const top = await cutAt("view.top", [25, 0, 0]);
  expect("cut by axis: no guides, 1 + select cube + C + click the X axis in Top view → cut at Y = 0 into two halves",
    top.tool === "Cut" && top.boxes.length === 2 && top.boxes.every((b) => b[1][1] - b[0][1] === 10 && b[1][2] - b[0][2] === 20) && top.boxes.some((b) => b[0][1] === 0), top);
  const front = await cutAt("view.front", [25, 0, 0]);
  expect("cut by axis: the X axis in Front view → cut level at Z = 0",
    front.boxes.length === 2 && front.boxes.every((b) => b[1][2] - b[0][2] === 10 && b[1][1] - b[0][1] === 20), front);
  // Nothing selected: C opens the panel and waits — the line then the cube, or the cube then the line
  const pickOrder = async (lineFirst) => {
    app.doc.reset([]);
    const cube = app.doc.makeBody(K.makeBox(G, [0, 0, -10], 20, 20, 20), "Cube");
    app.doc.commit([cube], "cube");
    app.run("mode.body"); app.run("view.top"); vp.fit(); await sleep(50);
    app.setSelection([]);
    app.run("op.cut"); await sleep(20);
    const text0 = document.getElementById("tool-panel")?.textContent ?? "";
    const click = async (p) => { ev("pointermove", p); await sleep(20); ev("pointerdown", p); await sleep(50); };
    await click(lineFirst ? [25, 0, 0] : [5, 5, 10]);
    const text1 = document.getElementById("tool-panel")?.textContent ?? "";
    await click(lineFirst ? [5, 5, 10] : [25, 0, 0]);
    return { text0, text1, tool: app.tool && app.tool.name, n: app.doc.bodies.length };
  };
  const lf = await pickOrder(true), cf = await pickOrder(false);
  expect("cut with nothing selected: C opens the panel waiting for a solid and a line; X axis then cube → cut",
    /click a solid/.test(lf.text0) && /click a guide line/.test(lf.text0) && /X axis/.test(lf.text1) && !lf.tool && lf.n === 2, lf);
  expect("cut with nothing selected: cube then X axis → cut", /Cube/.test(cf.text1) && !cf.tool && cf.n === 2, cf);
  // Cut along a straight path (a sketch line turned −15°, on the ground, longer than the cube): C, click the
  // path beyond the cube, click the cube → cut upright through the path into two equal halves; the path stays
  {
    app.doc.reset([]);
    const cube = app.doc.makeBody(K.makeBox(G, [0, 0, -10], 20, 20, 20), "Cube");
    const t = (-15 * Math.PI) / 180, A = [-40 * Math.cos(t), -40 * Math.sin(t), 0], B = [40 * Math.cos(t), 40 * Math.sin(t), 0];
    const path = app.doc.makeBody(K.sketchPath([{ kind: "line", a: A, b: B }]), "Path", "path");
    app.doc.commit([cube, path], "cube + path");
    app.run("mode.body"); app.run("view.top"); vp.fit(); await sleep(50);
    app.setSelection([]);
    app.run("op.cut"); await sleep(20);
    const onPath = [35 * Math.cos(t), 35 * Math.sin(t), 0];
    ev("pointermove", onPath); await sleep(20); ev("pointerdown", onPath); await sleep(50);
    const text = document.getElementById("tool-panel")?.textContent ?? "";
    ev("pointermove", [-5, 5, 10]); await sleep(20); ev("pointerdown", [-5, 5, 10]); await sleep(50);
    const solids = app.doc.bodies.filter((b) => b.kind === "solid");
    const vols = solids.map((b) => +K.solidVolume(b.shape).toFixed(3)).sort();
    const tall = solids.map((b) => { const [lo, hi] = b.shape.boundingBox.bounds; return +(hi[2] - lo[2]).toFixed(6); });
    expect("cut along a straight path (−15°): C, click the path, click the cube → cut upright into two equal halves, the path kept",
      /Along: Path/.test(text) && !app.tool && solids.length === 2 && vols.every((v) => Math.abs(v - 4000) < 1e-3) && tall.every((h) => h === 20) && !!app.doc.get(path.id),
      { text, vols, tall, n: app.doc.bodies.length });
  }
  // Split face (Shift+C) with nothing selected: the panel waits — the guide then the face, or the face then the guide
  const splitOrder = async (guideFirst) => {
    app.doc.reset([]);
    const bx = app.doc.makeBody(K.makeBox(G, [0, 600, 0], 40, 30, 20), "Box"); // (front face at Y = 585)
    app.doc.commit([bx], "box");
    app.doc.setGuides([{ a: [5, 585, 0], b: [5, 585, 20], n: [1, 0, 0] }], "guide");
    app.run("mode.body"); app.run("view.front"); vp.fit(); await sleep(50);
    app.setSelection([]);
    app.run("op.splitFace"); await sleep(20);
    const text0 = document.getElementById("tool-panel")?.textContent ?? "";
    const click = async (p) => { ev("pointermove", p); await sleep(20); ev("pointerdown", p); await sleep(50); };
    await click(guideFirst ? [5, 585, 10] : [12, 585, 10]);
    const text1 = document.getElementById("tool-panel")?.textContent ?? "";
    await click(guideFirst ? [12, 585, 10] : [5, 585, 10]);
    return { text0, text1, tool: app.tool && app.tool.name, faces: app.doc.get(bx.id).shape.faces.length, n: app.doc.bodies.length };
  };
  const sg = await splitOrder(true), sf = await splitOrder(false);
  expect("split face with nothing selected: Shift+C opens the panel; guide then face → face split, one solid",
    /click a face/.test(sg.text0) && /click a guide line/.test(sg.text0) && /guide line 1/.test(sg.text1) && !sg.tool && sg.faces === 7 && sg.n === 1, sg);
  expect("split face with nothing selected: face then guide → face split", /1 on Box/.test(sf.text1) && !sf.tool && sf.faces === 7 && sf.n === 1, sf);
  app.doc.setGuides([], "no guides");
  // Pro layout: the panel shows just what's picked (no instructions)
  app.run("view.pro"); await sleep(20);
  app.setSelection([]); app.run("op.cut"); await sleep(20);
  const proText = document.getElementById("tool-panel")?.textContent ?? "";
  app.run("view.pro"); await sleep(20); // (pro off again — Cut stays open)
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  expect("cut panel in the pro layout: Cutting / Along only, no instructions", /Cutting: —/.test(proText) && /Along: —/.test(proText) && !/click|Esc/.test(proText), { proText, tool: app.tool && app.tool.name });
  app.doc.reset([]);
  // A selected guide line glows (halos under its dashed line); the others don't
  try {
    const g0 = app.doc.guides.length;
    app.doc.setGuides([...app.doc.guides, { a: [0, 5000, 0], b: [50, 5000, 0] }, { a: [0, 5010, 0], b: [50, 5010, 0] }], "two guides");
    vp.setGuides(app.doc.guides, g0, g0 + 1);
    const kids = vp.guideRoot.children, glows = kids.filter((c) => c.type === "Group");
    expect("selected guide glows, hovered / others don't", glows.length === 1 && kids.length === app.doc.guides.length + 1, { kids: kids.length, glows: glows.length });
    const haloW = glows.length ? Math.max(...glows[0].children.map((l) => l.material.linewidth)) : 0;
    expect("selected guide's glow is thin (halos at most 7 px)", haloW > 0 && haloW <= 7, haloW);
    vp.setGuides(app.doc.guides, -1, -1);
    expect("no glow with nothing selected", !vp.guideRoot.children.some((c) => c.type === "Group"), vp.guideRoot.children.length);
    app.doc.setGuides(app.doc.guides.slice(0, g0), "remove guides");
  } catch (e) {
    expect("guide glow threw", false, String(e && e.stack || e));
  }
  // Selecting a solid: the panel's Size comes from its drawn box (the exact box is slow on some spline
  // faces) — still the exact size to the 0.01 shown, on round solids too.
  try {
    const K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const sph = app.doc.makeBody(K.makeSphereAt([0, 6000, 0], 10.37), "Sphere"), cyl = app.doc.makeBody(K.makeCylinder(G, [50, 6000, 0], 7.3, 12.5), "Cylinder");
    app.doc.commit([...app.doc.bodies, sph, cyl], "round solids");
    vp.render();
    const sizeOf = (b) => {
      app.setSelection([{ kind: "body", body: b.id, id: 0 }]);
      const row = [...document.querySelectorAll("#props tr")].find((r) => r.cells[0].textContent === "Size");
      const [lo, hi] = b.shape.boundingBox.bounds, f = (n) => String(Math.round(n * 100) / 100);
      return { shown: row?.cells[1].textContent, exact: [0, 1, 2].map((i) => f(hi[i] - lo[i])).join(" × "), drawn: !!vp.drawnBox(b.id) };
    };
    const s = sizeOf(sph), c = sizeOf(cyl);
    expect("Size in the panel: from the drawn box, the exact size to 0.01 (sphere, cylinder)", s.drawn && c.drawn && s.shown === s.exact && c.shown === c.exact, { s, c });
    // An edge selected, then the solid: an op's preview ending (e.g. a failed fillet cancelled, then
    // Scale after a move) doesn't bring the old edge's yellow lines back where it was
    app.setSelection([{ kind: "edge", body: cyl.id, id: app.doc.get(cyl.id).shape.edges[0].hashCode }]);
    const had = vp.selEdges.geometry.attributes.instanceStart?.count ?? 0;
    app.setSelection([{ kind: "body", body: cyl.id, id: 0 }]);
    vp.showGhost(new Map(), []); vp.clearGhost();
    const left = vp.selEdges.visible ? vp.selEdges.geometry.attributes.instanceStart?.count ?? 0 : 0;
    expect("edge, then solid selected: no old edge lines come back after a preview", had > 0 && left === 0, { had, left });
    // A fillet OpenCascade can't make (radius far too big): the panel says so in words, not "[object WebAssembly.Exception]"
    const bx = app.doc.makeBody(K.makeBox(G, [100, 6000, 0], 10, 10, 10), "Box");
    app.doc.commit([...app.doc.bodies, bx], "box");
    app.run("mode.edge");
    app.setSelection([{ kind: "edge", body: bx.id, id: app.doc.get(bx.id).shape.edges[0].hashCode }]);
    app.run("op.fillet");
    const rIn = document.querySelector("#op-panel input");
    rIn.value = "50"; rIn.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(400);
    const filletErr = document.querySelector("#op-panel .op-error")?.textContent ?? "";
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
    app.run("mode.body");
    expect("a fillet the kernel can't make: a readable error, with the largest radius that works", /can't round this edge at 50 mm — the largest that works is about \d/.test(filletErr) && !/object/.test(filletErr), filletErr);
    app.doc.undo();
    // G G centre to centre: pressing a rod's end centre shows the other solids' centres as marks; dropping
    // on the cup's top centre puts the rod's end exactly there
    const cup = app.doc.makeBody(K.makeCylinder(G, [0, 7000, 0], 10, 5), "Cup"), rod = app.doc.makeBody(K.makeCylinder(G, [40, 7000, 0], 2, 20), "Rod");
    app.doc.commit([...app.doc.bodies, cup, rod], "cup and rod");
    app.setSelection([{ kind: "body", body: cup.id, id: 0 }, { kind: "body", body: rod.id, id: 0 }]);
    app.run("view.fitSelection"); await sleep(700); // (the view glides there)
    app.setSelection([{ kind: "body", body: rod.id, id: 0 }]);
    app.setAutoSnap(true, false); // (as by default: these scenarios run with it off)
    app.run("xf.moveFrom"); await sleep(30);
    const pe = (type, p, buttons) => { const s = vp.toScreen(new V(...p)); vp.canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, buttons, pointerId: 1, isPrimary: true, pointerType: "mouse", bubbles: true })); };
    const at = (q, p) => Math.hypot(q.x - p[0], q.y - p[1], q.z - p[2]) < 1e-6;
    const tool = app.tool, baseShown = !!tool?.pivots.some((p) => at(p.point, [40, 7000, 0]));
    pe("pointermove", [40, 7000, 0], 0); pe("pointerdown", [40, 7000, 0], 1); await sleep(20);
    const targetShown = !!tool?.targets.some((p) => at(p.point, [0, 7000, 5]));
    pe("pointermove", [0, 7000, 5], 1); await sleep(20); pe("pointerup", [0, 7000, 5], 0); await sleep(30);
    const [lo, hi] = app.doc.get(rod.id).shape.boundingBox.bounds, bottom = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, lo[2]].map(r);
    expect("G G: the rod's end centre is a start mark, the cup's top centre a target; dropped there exactly", baseShown && targetShown && bottom.join() === "0,7000,5", { baseShown, targetShown, bottom });
    if (app.tool) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    // G G on a round edge (a slanted cup's rim): the gizmo turned to its circle — Z along its axis; a Z drag
    // of 2.4 moves the rod exactly 2 along it (1 mm steps), Tab "Z (along axis)" 5 → 5 in all, still centred
    {
      const u = [0.70089, -0.41139, 0.58269], C = [0, 8000, 0], F = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: u };
      const scup = app.doc.makeBody(K.makeCylinder(F, C.map((x, i) => x - 5 * u[i]), 12, 5), "Slanted cup"), srod = app.doc.makeBody(K.makeCylinder(F, C, 1.9, 20), "Slanted rod");
      app.doc.commit([...app.doc.bodies, scup, srod], "slanted cup and rod");
      app.setSelection([{ kind: "body", body: scup.id, id: 0 }, { kind: "body", body: srod.id, id: 0 }]);
      app.run("view.fitSelection"); await sleep(700);
      app.setSelection([{ kind: "body", body: srod.id, id: 0 }]);
      app.run("xf.moveFrom"); await sleep(30);
      const ring = app.doc.get(scup.id).shape.edges.find((e) => { const p = e.pointAt(0); return e.geomType === "CIRCLE" && Math.abs(Math.hypot(p.x - C[0], p.y - C[1], p.z - C[2]) - 12) < 0.01; });
      const q = ring.pointAt(0.25);
      pe("pointermove", [q.x, q.y, q.z], 0); pe("pointerdown", [q.x, q.y, q.z], 1); pe("pointerup", [q.x, q.y, q.z], 0); await sleep(30);
      // (the dashed axis line through the cup's centre)
      const axisLine = !!vp.xfAxis && (() => { const p = vp.xfAxis.geometry.attributes.position, a = new V().fromBufferAttribute(p, 0), b = new V().fromBufferAttribute(p, 1), m = a.clone().add(b).multiplyScalar(0.5); return m.distanceTo(new V(...C)) < 1e-3 || Math.abs(b.clone().sub(a).normalize().dot(m.clone().sub(new V(...C)).normalize())) > 0.9999; })();
      const fz = app.xf?.frame?.z, turned = !!fz && Math.abs(Math.abs(fz[0] * u[0] + fz[1] * u[1] + fz[2] * u[2]) - 1) < 1e-4 && vp.tc.space === "local";
      // (a drag: the pivot from where it started, as the gizmo does; the test's cursor stays on the rim, so no point snapping)
      const start = vp.pivot.position.clone(), z = new V(...fz);
      vp.xfPointer = null; vp.tc.axis = "Z"; vp.tc.dragging = true;
      vp.pivot.position.copy(start).addScaledVector(z, 2.4); vp.tc.dispatchEvent({ type: "objectChange" });
      vp.tc.dragging = false; vp.tc.axis = null; vp.finishTransformDrag(); await sleep(30);
      const along = () => {
        const sh = app.doc.get(srod.id).shape, faces = sh.faces.filter((f) => f.geomType === "PLANE").map((f) => f.center);
        const lo = faces.map((c) => { const v = [c.x - C[0], c.y - C[1], c.z - C[2]], t = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]; return { t, off: Math.hypot(...v.map((x, i) => x - t * u[i])) }; }).sort((a, b) => a.t - b.t)[0];
        return { t: r(lo.t * Math.sign(fz[0] * u[0] + fz[1] * u[1] + fz[2] * u[2])), off: r(lo.off) };
      };
      const dragged = along();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true })); await sleep(20);
      const dlg = document.getElementById("props-dlg"), ins = dlg ? [...dlg.querySelectorAll("input")] : [];
      const labels = dlg ? [...dlg.querySelectorAll("label")].map((l) => l.textContent) : [];
      const hiddenMore = dlg ? [...dlg.querySelectorAll("label.more")].filter((l) => l.style.display === "none").length : -1;
      if (ins[0]) ins[0].value = "5";
      dlg?.requestSubmit(); await sleep(30);
      const typed = along();
      expect("G G on a round edge: gizmo turned (Z along the circle's axis); Z drag 2.4 → 2 along it, Tab Z 5 → 5, centred",
        turned && dragged.t === 2 && dragged.off === 0 && labels[0] === "Along the axis (mm)" && hiddenMore === 2 && axisLine && typed.t === 5 && typed.off === 0, { turned, axisLine, dragged, labels, hiddenMore, typed });
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
      app.setSelection([]);
      // Plain G: a click on the cup's rim (gizmo up, not on it) turns the gizmo the same way
      app.setSelection([{ kind: "body", body: srod.id, id: 0 }]);
      app.run("xf.move"); await sleep(20);
      const before = !!app.xf?.frame;
      pe("pointermove", [q.x, q.y, q.z], 0); pe("pointerdown", [q.x, q.y, q.z], 1); pe("pointerup", [q.x, q.y, q.z], 0); await sleep(30);
      const gz = app.xf?.frame?.z, gTurned = !before && !!gz && Math.abs(Math.abs(gz[0] * u[0] + gz[1] * u[1] + gz[2] * u[2]) - 1) < 1e-4 && app.selection.length === 1 && app.selection[0].body === srod.id;
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
      const after = { xf: !!app.xf, line: !!vp.xfAxis };
      expect("plain G: a click on a round edge turns the gizmo to its circle (rod still selected); Esc: back to normal, no axis line", gTurned && !after.xf && !after.line, { before, gTurned, after });
      // Plain G on a slanted straight edge (a box turned 30° about Z): the gizmo turned along the edge, the
      // dashed line on it, Tab "Along the axis" 5 → the cube moved exactly 5 along it; an edge along X / Y / Z: no turn
      {
        const d = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0], BC = [0, 8100, 0];
        const wedge = app.doc.makeBody(K.rotateShape(K.makeBox(G, BC, 40, 20, 10), 30, BC, [0, 0, 1]), "Turned box");
        const cube = app.doc.makeBody(K.makeBox(G, [0, 8140, 0], 6, 6, 6), "Cube");
        app.doc.commit([...app.doc.bodies, wedge, cube], "turned box and cube");
        app.setSelection([{ kind: "body", body: wedge.id, id: 0 }, { kind: "body", body: cube.id, id: 0 }]);
        app.run("view.fitSelection"); await sleep(700);
        app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
        app.run("xf.move"); await sleep(20);
        const top = app.doc.get(wedge.id).shape.edges.find((e) => {
          const a = e.startPoint, b = e.endPoint, l = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
          return e.geomType === "LINE" && a.z > 9.99 && b.z > 9.99 && Math.abs(Math.abs(((b.x - a.x) * d[0] + (b.y - a.y) * d[1]) / l) - 1) < 1e-6 && (a.y + b.y) / 2 < BC[1];
        });
        const m = top.pointAt(0.5);
        pe("pointermove", [m.x, m.y, m.z], 0); pe("pointerdown", [m.x, m.y, m.z], 1); pe("pointerup", [m.x, m.y, m.z], 0); await sleep(30);
        const sz = app.xf?.frame?.z, sTurned = !!sz && Math.abs(Math.abs(sz[0] * d[0] + sz[1] * d[1] + sz[2] * d[2]) - 1) < 1e-6 && vp.tc.space === "local";
        const onEdge = !!vp.xfAxis && (() => { const p = vp.xfAxis.geometry.attributes.position, a = new V().fromBufferAttribute(p, 0), b = new V().fromBufferAttribute(p, 1); return Math.abs(Math.abs(b.clone().sub(a).normalize().dot(new V(...d))) - 1) < 1e-6 && Math.abs(a.z - 10) < 1e-6; })();
        const c0 = app.doc.get(cube.id).shape.boundingBox.center;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true })); await sleep(20);
        const dlg = document.getElementById("props-dlg"), ins = dlg ? [...dlg.querySelectorAll("input")] : [];
        const labels = dlg ? [...dlg.querySelectorAll("label")].map((l) => l.textContent) : [];
        if (ins[0]) ins[0].value = "5";
        dlg?.requestSubmit(); await sleep(30);
        const c1 = app.doc.get(cube.id).shape.boundingBox.center, mv = [c1[0] - c0[0], c1[1] - c0[1], c1[2] - c0[2]];
        const exact = sz && mv.every((x, i) => Math.abs(x - 5 * sz[i]) < 1e-6) && Math.abs(Math.hypot(...mv) - 5) < 1e-6;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
        // (the cube's own top edge along X: the plain gizmo stays)
        app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
        app.run("xf.move"); await sleep(20);
        const ce = app.doc.get(cube.id).shape.edges.find((e) => { const a = e.startPoint, b = e.endPoint; return a.z > 5.99 && b.z > 5.99 && Math.abs(a.y - b.y) < 1e-9 && a.y < c1[1]; });
        const cm = ce.pointAt(0.5);
        pe("pointermove", [cm.x, cm.y, cm.z], 0); pe("pointerdown", [cm.x, cm.y, cm.z], 1); pe("pointerup", [cm.x, cm.y, cm.z], 0); await sleep(30);
        const axisEdgeTurned = !!app.xf?.frame;
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
        expect("plain G on a slanted straight edge: gizmo turned along it (dashed line on the edge), Tab 5 → moved exactly 5 along it; an edge along X: not turned",
          sTurned && onEdge && labels[0] === "Along the axis (mm)" && exact && !axisEdgeTurned, { sz, sTurned, onEdge, labels, mv, axisEdgeTurned });
        app.setSelection([]);
      }
      // The Snap step is remembered for next time (as Auto is)
      const sel = document.getElementById("snap-select");
      sel.value = "0.5"; sel.dispatchEvent(new Event("change"));
      const saved = { stored: localStorage.getItem("yddd.snapStep"), step: vp.axisSnapStep };
      sel.value = "1"; sel.dispatchEvent(new Event("change"));
      expect("Snap step: a new choice is remembered (0.5 → stored), back to 1", saved.stored === "0.5" && saved.step === 0.5 && localStorage.getItem("yddd.snapStep") === "1", saved);
      // Long guide / path whose midpoint is far off-screen: G places the move gizmo inside the viewport
      const g0 = app.doc.guides.length;
      app.doc.setGuides([...app.doc.guides, { a: [-5000, 8000, 0], b: [1000, 8000, 0] }], "long guide");
      app.selGuide = g0; app.setSelection([]);
      app.run("xf.move"); await sleep(20);
      const gPivotInView = vp.inView(vp.pivot.position);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
      app.doc.setGuides(app.doc.guides.slice(0, g0), "remove long guide");
      const longPath = app.doc.makeBody(K.sketchPath([{ kind: "line", a: [-5000, 8000, 0], b: [1000, 8000, 0] }]), "Long path", "path");
      app.doc.commit([...app.doc.bodies, longPath], "long path");
      app.setSelection([{ kind: "body", body: longPath.id, id: 0 }]);
      app.run("xf.move"); await sleep(20);
      const pPivotInView = vp.inView(vp.pivot.position);
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
      app.doc.undo();
      expect("long guide / path with midpoint off-screen: G keeps the move gizmo inside the viewport", gPivotInView && pPivotInView, { gPivotInView, pPivotInView });
      app.setSelection([]);
      for (let k = 0; k < 3; k++) app.doc.undo();
    }
    app.setAutoSnap(false, false);
    if (app.tool) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    app.setSelection([]);
    app.doc.undo(); app.doc.undo();
    app.setSelection([]);
    app.doc.undo();
  } catch (e) {
    expect("panel size threw", false, String(e && e.stack || e));
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("cut by axis scenario failed: " + JSON.stringify(failed));
  return [{ label: "cut by axis", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Move gizmo + Ctrl: the snap marker (green square, axis cross) is drawn over the gizmo handle under the cursor. */
const SCENARIO_SNAPMARK = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  app.doc.reset([]);
  const cube = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 20, 20, 20), "Cube");
  app.doc.commit([cube], "cube");
  app.run("mode.body"); vp.fit(); await sleep(50);
  app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
  app.run("xf.move"); await sleep(50);
  const P = vp.pivot.position.clone();
  vp.tc.axis = "XYZ"; // the centre handle as while dragging it (highlighted, drawn on top)
  const greenNear = (kind, dy) => {
    vp.showSnapMarker({ point: P, kind });
    vp.render(); // (read back in the same task, before the frame is presented)
    const gl = vp.renderer.getContext(), r = vp.canvas.getBoundingClientRect(), dpr = vp.renderer.getPixelRatio();
    const s = vp.toScreen(P), n = Math.ceil(4 * dpr);
    const x = Math.round((s.x - r.left) * dpr) - n, y = Math.round((r.bottom - s.y - dy) * dpr) - n;
    const px = new Uint8Array((2 * n + 1) * (2 * n + 1) * 4);
    gl.readPixels(x, y, 2 * n + 1, 2 * n + 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let g = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i + 1] > 150 && px[i] < 140 && px[i + 2] < 180) g++;
    return g;
  };
  const sq = greenNear("vertex", 7), cross = greenNear("axis", 4);
  expect("snap marker: green square (point) shows over the move gizmo's centre handle", sq > 0, sq);
  expect("snap marker: axis cross shows over the move gizmo's centre handle", cross > 0, cross);
  vp.tc.axis = null;
  vp.showSnapMarker(null);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(30);
  app.doc.reset([]);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("snap marker scenario failed: " + JSON.stringify(failed));
  return [{ label: "snap marker over gizmo", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Auto snap (status bar, on by default): tools snap without Ctrl, Ctrl places freely; off: only with Ctrl. */
const SCENARIO_AUTOSNAP = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const box = document.getElementById("auto-snap");
  const saved = localStorage.getItem("yddd.autoSnap");
  app.doc.reset([]);
  const cube = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 20, 20, 20), "Cube");
  app.doc.commit([cube], "cube");
  app.run("mode.body"); app.setSelection([]); vp.setView("iso"); vp.fit(); await sleep(50);
  // The box turns it on (remembered) and words the hints for it
  box.checked = true; box.dispatchEvent(new Event("change")); await sleep(20);
  expect("auto snap: the Auto box turns it on and it's remembered", vp.autoSnap && localStorage.getItem("yddd.autoSnap") === "1", { on: vp.autoSnap, stored: localStorage.getItem("yddd.autoSnap") });
  // Rectangle tool near a top corner of the cube: without Ctrl it snaps to the corner, with Ctrl it's free
  app.run("tool.rectangle"); await sleep(20);
  const corner = new V(10, -10, 20); // (the cube is centred on X / Y)
  window.__see(corner);
  vp.camera.updateMatrixWorld(); vp.stamp++; await sleep(30); // (__see may turn the camera: current matrices, re-projected snap points)
  const sc = vp.toScreen(corner);
  const marker = () => Object.values(vp.snapMarker ?? {}).some((m) => m.visible);
  const move = async (ctrlKey) => { canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: sc.x + 3, clientY: sc.y + 2, ctrlKey, button: 0, bubbles: true })); await sleep(30); return marker(); };
  const snapped = await move(false), free = await move(true);
  expect("auto snap: on — the Rectangle tool snaps to a corner without Ctrl, Ctrl places freely", snapped && !free, { snapped, free });
  expect("auto snap: on — grid step without Ctrl, none with it", app.snapStep({ ctrlKey: false }) === app.snap && app.snapStep({ ctrlKey: true }) === 0, [app.snapStep({ ctrlKey: false }), app.snapStep({ ctrlKey: true })]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  // The move gizmo snaps to the grid without Ctrl; its hint says Ctrl is free
  app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
  app.run("xf.move"); await sleep(30);
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5, ctrlKey: false, bubbles: true }));
  const gizmoSnap = vp.tc.translationSnap, hint = document.getElementById("status-hint").textContent;
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5, ctrlKey: true, bubbles: true }));
  const gizmoFree = vp.tc.translationSnap;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
  app.run("xf.rotate"); await sleep(30);
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5, ctrlKey: false, bubbles: true }));
  const rotDeg = vp.tc.rotationSnap === null ? null : +(vp.tc.rotationSnap * 180 / Math.PI).toFixed(6);
  expect("auto snap: on — the rotate gizmo snaps in 5° steps", rotDeg === 5, rotDeg);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
  app.run("xf.move"); await sleep(30);
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5, ctrlKey: false, bubbles: true }));
  expect("auto snap: on — the move gizmo snaps without Ctrl, not with it; the hint says Ctrl is free", gizmoSnap === app.snap && gizmoFree === null && /Ctrl: free/.test(hint), { gizmoSnap, gizmoFree, hint });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  // G G: Move from point (G alone: the move gizmo; a second G switches; Shift+G does nothing now)
  app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
  const gk = (o = {}) => window.dispatchEvent(new KeyboardEvent("keydown", { key: o.shiftKey ? "G" : "g", code: "KeyG", bubbles: true, cancelable: true, ...o }));
  gk(); await sleep(20);
  const oneG = { xf: !!app.xf, tool: app.tool?.name ?? null };
  gk(); await sleep(20);
  const twoG = { xf: !!app.xf, tool: app.tool?.name ?? null };
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
  gk({ shiftKey: true }); await sleep(20);
  const shiftG = { xf: !!app.xf, tool: app.tool?.name ?? null };
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  expect("G = move gizmo, G G = Move from point, Shift+G = Guide line", oneG.xf && !oneG.tool && twoG.tool === "Move from point" && !twoG.xf && !shiftG.xf && shiftG.tool === "Guide line", { oneG, twoG, shiftG });
  // D: Draw line on face (L no longer)
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "d", code: "KeyD", bubbles: true, cancelable: true })); await sleep(20);
  const dTool = app.tool?.name ?? null;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "l", code: "KeyL", bubbles: true, cancelable: true })); await sleep(20);
  const lTool = app.tool?.name ?? null;
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  expect("D = Draw line on face (L does nothing now)", dTool === "Draw line on face" && lTool === null, { dTool, lTool });
  // Draw line on face: an end point a little off the Y direction locks where the Y axis line through the start meets the far edge
  {
    const slab = app.doc.makeBody(K.makeBox(G, [200, 0, 0], 40, 30, 20), "Slab"); // (x 180…220, y −15…15, z 0…20)
    app.doc.commit([...app.doc.bodies, slab], "slab");
    app.setSelection([]); vp.setView("iso"); vp.fit([slab.id]); await sleep(50);
    const at = (p, type) => { const s = vp.toScreen(new V(...p)); canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
    app.run("tool.divideFace"); await sleep(20);
    at([193, -15, 20], "pointermove"); at([193, -15, 20], "pointerdown"); at([193, -15, 20], "pointerup");
    at([194, 15, 20], "pointermove"); await sleep(20); // (≈ 2° off Y)
    const hud = document.getElementById("hud")?.textContent ?? "";
    at([194, 15, 20], "pointerdown"); at([194, 15, 20], "pointerup"); await sleep(20);
    const sh = app.doc.get(slab.id).shape, sel = app.selection[0];
    const e = sel && sel.kind === "edge" && sh.edges.find((x) => x.hashCode === sel.id);
    const ends = e ? [e.startPoint, e.endPoint].map((p) => [p.x, p.y, p.z].map((n) => +n.toFixed(6))).sort((p, q) => p[1] - q[1]) : null;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
    expect("Draw line on face: end point near the Y direction locks parallel to Y (HUD says so)",
      JSON.stringify(ends) === JSON.stringify([[193, -15, 20], [193, 15, 20]]) && /On Y axis/.test(hud) && sh.faces.length === 7, { ends, hud, faces: sh.faces.length });
    app.doc.commit(app.doc.bodies.filter((b) => b.id !== slab.id), "remove slab");
    app.run("mode.body"); app.setSelection([]); vp.fit(); await sleep(20);
  }
  // Guide line: a click on an edge / the X axis still picks it as the reference (an edge snap doesn't start a 2-point guide)
  app.setSelection([]);
  const guideRef = async (p) => {
    app.run("tool.guide"); await sleep(20);
    window.__see(new V(...p)); vp.camera.updateMatrixWorld(); vp.stamp++; await sleep(30);
    const s = vp.toScreen(new V(...p));
    canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: s.x, clientY: s.y, button: 0, bubbles: true }));
    await sleep(20);
    // Hovered: it glows (a group of thick lines over everything) — a picture of it for a look
    const glowG = vp.overlayRoot.children.find((o) => o.isGroup && o.children.length === 3 && o.children.every((l) => l.isLineSegments2));
    const glow = !!glowG, width = glowG ? Math.max(...glowG.children.map((l) => l.material.linewidth)) : 0;
    vp.render(); // (now, so the canvas holds this frame)
    const png = vp.canvas.toDataURL("image/png");
    await window.yddd.writeFile((window.__smokeDir || "/tmp/yddd-smoke") + "/guide-glow-" + (p[2] === 0 ? "axis" : "edge") + ".png", Uint8Array.from(atob(png.split(",")[1]), (c) => c.charCodeAt(0)));
    canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: s.x, clientY: s.y, button: 0, bubbles: true }));
    await sleep(20);
    const t = app.tool, got = { glow, width, ref: !!t?.ref, onAxis: !!t?.onAxis, p1: !!t?.p1 };
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
    return got;
  };
  const onEdge = await guideRef([5, -10, 20]), onAxis = await guideRef([40, 0, 0]);
  expect("auto snap: on — Guide line: an edge or the X axis glows under the cursor, a click picks it as the reference", onEdge.glow && onEdge.ref && !onEdge.p1 && onAxis.glow && onAxis.ref && onAxis.onAxis && !onAxis.p1, { onEdge, onAxis });
  expect("Guide line: a hovered axis glows in thinner lines than an edge", onAxis.width > 0 && onAxis.width < onEdge.width, { onEdge, onAxis });
  // Guide line in a main view: two clicks on empty space (nothing to snap to) → a guide on the view's
  // base plane (Top: Z = 0, Front: Y = 0); in a slanted view the same click does nothing
  {
    const twoClicks = async (view) => {
      vp.setView(view); vp.fit(); await sleep(30); vp.camera.updateMatrixWorld(); vp.stamp++;
      const r = canvas.getBoundingClientRect(), g0 = app.doc.guides.length;
      // empty spots: 8% in from the top-left / top-right corners (no solid, no axis line there)
      const spots = [[r.left + r.width * 0.08, r.top + r.height * 0.12], [r.left + r.width * 0.3, r.top + r.height * 0.12]];
      const empty = spots.every(([x, y]) => !vp.faceUnder(x, y) && vp.axisUnder(x, y) < 0 && !vp.snapPoint(x, y));
      app.run("tool.guide"); await sleep(20);
      const texts = [document.getElementById("tool-panel")?.textContent ?? ""];
      for (const [x, y] of spots) {
        for (const type of ["pointermove", "pointerdown", "pointerup"]) canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
        await sleep(20);
        texts.push(document.getElementById("tool-panel")?.textContent ?? "");
      }
      const g = app.doc.guides.length > g0 ? app.doc.guides[app.doc.guides.length - 1] : null;
      if (app.tool) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
      await sleep(20);
      if (g) app.doc.setGuides(app.doc.guides.slice(0, g0), "remove guide");
      return { empty, texts, g: g && [g.a, g.b].map((p) => p.map((n) => +n.toFixed(4))) };
    };
    const top = await twoClicks("top"), front = await twoClicks("front"), iso = await twoClicks("iso");
    expect("Guide line panel: waits for an edge / axis / point, then shows the first point and asks for the second; closes once added",
    /click an edge, axis or point/.test(top.texts[0]) && /From: point \(/.test(top.texts[1]) && /second point/.test(top.texts[1]) && top.texts[2] === "", top.texts);
  expect("Guide line in Top / Front view: click two empty spots → a guide on Z = 0 / Y = 0; none in a slanted view",
      top.empty && top.g && top.g.every((p) => p[2] === 0) && front.empty && front.g && front.g.every((p) => p[1] === 0) && !iso.g, { top, front, iso });
  }
  // Snapping leaves out what the eye can't see: a corner of a small box behind the cube, with the cursor just
  // off the cube's outline (nothing under the cursor) — and push/pull drags leave out the world X / Y / Z lines.
  vp.setView("iso"); vp.fit(); await sleep(30); vp.camera.updateMatrixWorld(); vp.stamp++;
  const eye = vp.camera.position.clone(), E = new V(5, 10, 20); // on the cube's top back edge (an outline in iso)
  const P = E.clone().addScaledVector(E.clone().sub(eye).normalize(), 40); P.z -= 0.1;
  const behind = app.doc.makeBody(K.makeBox(G, [P.x + 1, P.y + 1, P.z - 2], 2, 2, 2), "Behind");
  app.doc.commit([...app.doc.bodies, behind], "box behind"); await sleep(30); vp.stamp++;
  const sP = vp.toScreen(P);
  let off = -1;
  for (let k = 1; k <= 10 && off < 0; k++) if (!vp.faceUnder(sP.x, sP.y - k)) off = k;
  const hidSnap = off > 0 ? vp.snapPoint(sP.x, sP.y - off) : undefined;
  const hidOk = off > 0 && (!hidSnap || hidSnap.point.distanceTo(P) > 1e-6);
  expect("snap: a corner hidden behind the cube doesn't snap (cursor just off the cube's outline)", hidOk, { off, snap: hidSnap && { kind: hidSnap.kind, p: hidSnap.point.toArray().map((n) => +n.toFixed(3)) } });
  vp.setXray(true);
  const xrSnap = off > 0 ? vp.snapPoint(sP.x, sP.y - off) : undefined;
  vp.setXray(false);
  expect("snap: in X-ray the corner behind the cube does snap (it shows through)", xrSnap && xrSnap.point.distanceTo(P) < 1e-6, xrSnap && { kind: xrSnap.kind, p: xrSnap.point.toArray().map((n) => +n.toFixed(3)) });
  const visSnap = vp.snapPoint(vp.toScreen(new V(10, -10, 20)).x + 2, vp.toScreen(new V(10, -10, 20)).y + 1);
  expect("snap: a visible corner still snaps", visSnap && visSnap.kind === "vertex" && visSnap.point.distanceTo(new V(10, -10, 20)) < 1e-6, visSnap && visSnap.point.toArray());
  app.run("edit.undo"); await sleep(30); vp.stamp++;
  const sx = vp.toScreen(new V(40, 0, 0));
  const withAxes = vp.snapPoint(sx.x, sx.y), noAxes = vp.snapPoint(sx.x, sx.y, undefined, { axes: false });
  expect("snap: on the X axis — snaps to it, but not with axes off (push/pull drags without Ctrl)", withAxes?.kind === "axis" && noAxes?.kind !== "axis", { withAxes: withAxes?.kind, noAxes: noAxes?.kind ?? null });
  // Moving the guide shows its length and percent: from an edge "10 mm · 50%" (of the face), from an axis "Y = … mm · …% across Cube"
  const guideHud = async (pick, to) => {
    app.run("tool.guide"); await sleep(20);
    const at = (p) => { window.__see(new V(...p)); vp.camera.updateMatrixWorld(); vp.stamp++; return vp.toScreen(new V(...p)); };
    let s = at(pick);
    for (const type of ["pointermove", "pointerdown"]) canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true }));
    await sleep(20);
    s = at(to);
    canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); await sleep(20);
    const text = app.hudEl.hidden ? null : app.hudEl.textContent;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
    return text;
  };
  const edgeHud = await guideHud([5, -10, 20], [0, 0, 20]), axisHud = await guideHud([40, 0, 0], [0, 5, 20]);
  expect("guide line: moving it shows length and percent — edge: mm · % of the face; axis: mm · % across the solid under the cursor",
    /^[\d.]+ mm · [\d.]+%$/.test(edgeHud ?? "") && axisHud === "Y = 5 mm · 75% across Cube 1", { edgeHud, axisHud });
  // Where two guides cross (like ~/untitled.yddd: 69.5 along one of them, so its 1 mm steps miss it): a snap point — a circle started a few pixels off it is centred on it
  {
    vp.setView("iso"); vp.fit(); await sleep(30);
    const g0 = app.doc.guides.length;
    app.doc.setGuides([...app.doc.guides, { a: [-15.3, -4.5, 20], b: [15, -4.5, 20], n: [0, 1, 0] }, { a: [3, 15.2, 20], b: [3, -15, 20], n: [1, 0, 0] }], "two guides");
    await sleep(20); vp.stamp++;
    const X = new V(3, -4.5, 20);
    app.run("tool.circle"); await sleep(20);
    window.__see(X); vp.camera.updateMatrixWorld(); vp.stamp++; await sleep(20);
    const sx = vp.toScreen(X), n0 = app.doc.bodies.length;
    const pe = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    pe("pointermove", sx.x + 4, sx.y + 3); await sleep(20);
    const marker = Object.values(vp.snapMarker ?? {}).some((m) => m.visible);
    pe("pointerdown", sx.x + 4, sx.y + 3); pe("pointerup", sx.x + 4, sx.y + 3); await sleep(20);
    const r5 = vp.toScreen(new V(8, -4.5, 20));
    pe("pointermove", r5.x, r5.y); await sleep(20); pe("pointerdown", r5.x, r5.y); pe("pointerup", r5.x, r5.y); await sleep(50);
    const made = app.doc.bodies.length > n0 ? app.doc.bodies[app.doc.bodies.length - 1] : null;
    const c = made && (() => { const [lo, hi] = made.shape.boundingBox.bounds; return [0, 1, 2].map((k) => +((lo[k] + hi[k]) / 2).toFixed(4)); })();
    expect("snap: where two guides cross — a circle started 5 px off it is centred exactly on the crossing", marker && made && made.kind === "face" && c.join() === "3,-4.5,20", { marker, kind: made?.kind, c });
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
    if (made) { app.setSelection([{ kind: "body", body: made.id, id: 0 }]); app.run("edit.delete"); }
    app.doc.setGuides(app.doc.guides.slice(0, g0), "remove guides");
  }
  vp.setView("iso"); vp.fit(); await sleep(30);
  app.setSelection([{ kind: "body", body: cube.id, id: 0 }]);
  app.run("xf.move"); await sleep(30);
  // Off: the old way — only with Ctrl
  box.checked = false; box.dispatchEvent(new Event("change")); await sleep(20);
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5, ctrlKey: false, bubbles: true }));
  const offFree = vp.tc.translationSnap, offHint = document.getElementById("status-hint").textContent;
  window.dispatchEvent(new PointerEvent("pointermove", { clientX: 5, clientY: 5, ctrlKey: true, bubbles: true }));
  const offSnap = vp.tc.translationSnap;
  expect("auto snap: off — the gizmo snaps only with Ctrl, the hint says so; remembered", offFree === null && offSnap === app.snap && /hold Ctrl to snap/.test(offHint) && localStorage.getItem("yddd.autoSnap") === "0", { offFree, offSnap, offHint });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  app.run("tool.rectangle"); await sleep(20);
  const offPlain = await move(false), offCtrl = await move(true);
  expect("auto snap: off — the Rectangle tool snaps to the corner only with Ctrl", !offPlain && offCtrl, { offPlain, offCtrl });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  // (the other scenarios run with it off; the user's setting comes back)
  if (saved === null) localStorage.removeItem("yddd.autoSnap"); else localStorage.setItem("yddd.autoSnap", saved);
  app.setAutoSnap(false, false);
  app.doc.reset([]);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("auto snap scenario failed: " + JSON.stringify(failed));
  return [{ label: "auto snap", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** File → Open Recent: open / save put a model on the list, opening it again loads it, a missing file is taken off. */
const SCENARIO_RECENT = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const dir = window.__smokeDir, a = dir + "/recent-a.yddd", b = dir + "/recent-b.yddd", gone = dir + "/recent-gone.yddd";
  app.doc.reset([app.doc.makeBody(K.makeBox(G, [0, 0, 0], 10, 20, 30), "Box A")]);
  await window.yddd.writeFile(a, app.modelText());
  app.doc.reset([app.doc.makeBody(K.makeBox(G, [0, 0, 0], 5, 5, 5), "Box B")]);
  await window.yddd.writeFile(b, app.modelText());
  for (const f of [gone, b, a]) await window.yddd.addRecent(f);
  await window.yddd.addRecent(b); // (again: moves to the top, no duplicate)
  const list = await window.yddd.recentFiles();
  expect("recent: newest first, no duplicates", list.slice(0, 3).join() === [b, a, gone].join(), list);
  app.doc.reset([]); app.doc.dirty = false;
  await app.openRecent(a);
  const opened = app.doc.bodies.map((x) => x.name).join();
  const top = (await window.yddd.recentFiles())[0];
  expect("recent: opening one loads it (and puts it first)", /^Box A/.test(opened) && app.doc.filePath === a && top === a, { opened, filePath: app.doc.filePath, top });
  app.doc.dirty = false;
  await app.openRecent(gone);
  const after = await window.yddd.recentFiles();
  expect("recent: a missing file is taken off the list, the model stays", !after.includes(gone) && /^Box A/.test(app.doc.bodies.map((x) => x.name).join()), after);
  app.doc.reset([]); app.doc.dirty = false;
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("recent scenario failed: " + JSON.stringify(failed));
  return [{ label: "open recent", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Sketch (K): on a face and on the ground — lines, tangent arcs, a hole, typed sizes, undo, Done / Cancel. */
const SCENARIO_SKETCH = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  // Beginner layout (a Pro layout left on in the test profile would change the panel / hints)
  localStorage.removeItem("yddd.pro"); document.body.classList.remove("pro");
  for (let k = 0; k < 3 && app.tool; k++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  document.getElementById("tutorial").hidden = true; document.body.classList.remove("tutorial-open");
  app.doc.dirty = false; app.doc.reset([]);
  const box = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 40, 30, 20), "Box");
  app.doc.commit([box], "box");
  app.run("mode.body"); app.setSelection([]); vp.setView("iso"); vp.fit(); await sleep(100);
  const key = async (k, extra = {}) => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra })); await sleep(10); };
  const type = async (text) => { for (const ch of text) await key(ch); await key("Enter"); };
  const pe = (t, p) => { const sc = window.__see(new V(p[0], p[1], p[2])); canvas.dispatchEvent(new PointerEvent(t, { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); };
  const hover = async (p) => { pe("pointermove", p); await sleep(10); };
  const click = async (p) => { pe("pointermove", p); pe("pointerdown", p); pe("pointerup", p); await sleep(10); };
  const area = (b) => b.shape.faces.reduce((s, f) => s + K.faceInfo(b.shape, f.hashCode).area, 0);
  const cam0 = vp.camera.position.toArray();
  const top = box.shape.faces.find((f) => f.normalAt(f.center).toTuple()[2] > 0.99);
  app.setSelection([{ kind: "face", body: box.id, id: top.hashCode }]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true, cancelable: true })); await sleep(50);
  const dir = vp.camera.getWorldDirection(new V());
  expect("sketch: K on a top face starts the sketch, looking straight down, with its panel", app.tool && app.tool.name === "Sketch" && dir.z < -0.999 && document.getElementById("sketch-panel"), { tool: app.tool && app.tool.name, dir: dir.toArray() });
  await key("g"); await key("5");
  expect("sketch: other commands wait (G, view keys)", app.tool && app.tool.name === "Sketch" && vp.camera.getWorldDirection(new V()).z < -0.999, app.tool && app.tool.name);
  await key("g"); await key("g");
  expect("sketch: G G (a chord) doesn't end the sketch", app.tool && app.tool.name === "Sketch", app.tool && app.tool.name);
  const z = 20, at = (x, y) => [x, y, z];
  // L shape (300 mm²) with a round hole (r 2) in it
  for (const p of [[-10, -10], [10, -10], [10, 0], [0, 0], [0, 10], [-10, 10], [-10, -10]]) await click(at(...p));
  await key("c"); await click(at(-5, -5)); await type("2");
  // The middle of a sketch line snaps (the L's bottom edge: 0,-10)
  await key("l"); await hover(at(0.3, -9.8));
  const mid = app.tool.cursor;
  expect("sketch: the middle of a sketch line snaps", mid && Math.abs(mid[0]) < 1e-9 && Math.abs(mid[1] + 10) < 1e-9, mid);
  // A stray line, then Ctrl+Z twice takes it back (the line, then its first point)
  await key("l"); await click(at(-18, 12)); await click(at(-15, 12)); await key("z", { ctrlKey: true }); await key("z", { ctrlKey: true });
  const stray = app.tool.first === null && app.tool.path.length === 0;
  // Slot beside the box (10 x 10 + two half circles r 5): line, arc, line, arc back to the start
  await click(at(25, -5)); await hover(at(35, -5)); await type("10"); await key("a"); await click(at(35, 5)); await key("l"); await click(at(25, 5)); await key("a"); await click(at(25, -5));
  expect("sketch: 3 closed outlines; undo took back the stray line", app.tool.loops.length === 3 && stray, { loops: app.tool.loops.length, stray });
  // Join shows while drawing too; a click there goes to Select (nothing joined yet)
  const joinB = () => document.querySelector("#sketch-panel button[data-act=join]");
  const joinDrawing = !!joinB() && !joinB().disabled && app.tool.mode === "arc";
  joinB().click(); await sleep(30);
  expect("sketch: Join button while drawing; click → Select, greyed until 2 are selected", joinDrawing && app.tool.mode === "select" && joinB()?.disabled && app.tool.loops.length === 3, { joinDrawing, mode: app.tool.mode, disabled: joinB()?.disabled });
  // G: the move gizmo on the selection (the slot) — the X arrow moves along X only, the square freely (grid steps);
  // Esc puts it all back; G again + Tab: exact ΔX, ΔY, applied as one undo step
  {
    const t = app.tool;
    t.selected = [{ kind: "loop", i: 2 }];
    const c0 = t.selectionCenter();
    const off = () => { t.selected = [{ kind: "loop", i: 2 }]; return t.selectionCenter().map((v, i) => +(v - c0[i]).toFixed(6)); }; // (undo clears the selection)
    const W = (p) => t.world(p).toArray();
    const drag = async (from, d) => {
      const to = [from[0] + d[0], from[1] + d[1]];
      pe("pointermove", W(from)); await sleep(10); pe("pointerdown", W(from)); pe("pointermove", W(to)); await sleep(10); pe("pointerup", W(to)); await sleep(10);
    };
    const st = vp.snapping({ ctrlKey: false }) ? app.snap : 0, rnd = (v) => (st > 0 ? +(Math.round(v / st) * st).toFixed(6) : v);
    await key("g");
    const shown = !!t.moving && !!document.querySelector("#sketch-panel button[data-act=move].primary");
    let g = t.moveGizmo();
    await drag([g.o[0] + (g.x[0] - g.o[0]) * 0.6, g.o[1]], [10.3, 7]);
    const alongX = off();
    g = t.moveGizmo();
    await drag(g.sq, [-3.2, 4.1]);
    const free = off();
    await key("Escape");
    const back = off(), gone = !t.moving;
    await key("g");
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true })); await sleep(20);
    const dlg = document.getElementById("props-dlg"), ins = dlg ? [...dlg.querySelectorAll("input")] : [];
    if (ins[0]) ins[0].value = "5"; if (ins[1]) ins[1].value = "-2";
    dlg?.requestSubmit(); await sleep(20);
    const typed = off(), applied = !t.moving;
    await key("z", { ctrlKey: true });
    const undone = off();
    expect("sketch: G — move gizmo; X arrow along X only, the square free (grid steps); Esc back; Tab ΔX 5, ΔY -2; one undo step",
      shown && alongX.join() === [rnd(10.3), 0].join() && free.join() === [rnd(10.3) + rnd(-3.2), rnd(4.1)].map((v) => +v.toFixed(6)).join() && back.join() === "0,0" && gone &&
        typed.join() === "5,-2" && applied && undone.join() === "0,0" && t.loops.length === 3,
      { shown, st, alongX, free, back, gone, typed, applied, undone, loops: t.loops.length });
    t.selected = [];
  }
  // S: one gizmo scales and rotates — the blue ring dragged a quarter turn about the centre turns the slot
  // (20 x 10 → 10 x 20, centre kept, arcs stay arcs); Tab shows Rotate 90, 45 typed → applied; one undo step back
  {
    const t = app.tool;
    t.selected = [{ kind: "loop", i: 2 }];
    const c0 = t.selectionCenter(), W = (p) => t.world(p).toArray();
    const box = () => {
      const pts = t.loops[2].kind === "circle" ? [] : t.loops[2].segs.flatMap((g) => (g.kind === "arc" ? [g.a, g.m, g.b] : [g.a, g.b]));
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return [Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)].map((v) => +v.toFixed(2));
    };
    const size0 = box();
    await key("s");
    const shown = !!t.scaling && !!document.querySelector("#sketch-panel button[data-act=scale].primary");
    const p = t.handlePos("rot"), to = [c0[0] - (p[1] - c0[1]), c0[1] + (p[0] - c0[0])];
    pe("pointermove", W(p)); await sleep(10); pe("pointerdown", W(p)); pe("pointermove", W(to)); await sleep(10); pe("pointerup", W(to)); await sleep(10);
    const deg = +((t.scaling.ang * 180) / Math.PI).toFixed(1), size90 = box(), arcs = t.loops[2].segs.filter((g) => g.kind === "arc").length;
    t.selected = [{ kind: "loop", i: 2 }];
    const c90 = t.selectionCenter().map((v, i) => +(v - c0[i]).toFixed(3));
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", code: "Tab", bubbles: true, cancelable: true })); await sleep(20);
    const dlg = document.getElementById("props-dlg"), ins = dlg ? [...dlg.querySelectorAll("input")] : [];
    const shownDeg = ins[3] ? Math.round(+ins[3].value) : null;
    if (ins[3]) ins[3].value = "45";
    dlg?.requestSubmit(); await sleep(20);
    const applied = !t.scaling, d45 = Math.abs(box()[0] - box()[1]) < 0.01;
    await key("z", { ctrlKey: true });
    const undone = box();
    expect("sketch: S — one scale / rotate gizmo; blue ring a quarter turn: 20 x 10 → 10 x 20, centre kept, arcs kept; Tab Rotate 90 → 45 applied; one undo back",
      shown && Math.abs(Math.abs(deg) - 90) < 0.5 && Math.abs(size90[0] - size0[1]) < 0.05 && Math.abs(size90[1] - size0[0]) < 0.05 && arcs === 2 && c90.every((v) => Math.abs(v) < 0.01) &&
        ins.length === 4 && shownDeg === 90 && applied && d45 && undone.join() === size0.join(),
      { shown, deg, size0, size90, arcs, c90, n: ins.length, shownDeg, applied, d45, undone });
    t.selected = [];
  }
  // Arc: start, end, a point on it → right click ends it (a path); Ctrl+Z, Ctrl+Z → back in the Arc tool with
  // its start and end picked (not two loose dots in Select); Esc / Ctrl+Z clean up
  {
    const t = app.tool, opens0 = t.opens.length;
    const rclick = async (p) => { const sc = window.__see(new V(p[0], p[1], p[2])); for (const ty of ["pointerdown", "pointerup"]) canvas.dispatchEvent(new PointerEvent(ty, { clientX: sc.x, clientY: sc.y, button: 2, bubbles: true })); await sleep(10); };
    await key("a"); await click(at(-20, 20)); await click(at(-10, 20)); await click(at(-15, 24));
    await rclick(at(-30, 30));
    const ended = t.mode === "select" && t.opens.length === opens0 + 1 && !t.first;
    await key("z", { ctrlKey: true });
    const one = { mode: t.mode, path: t.path.length, first: !!t.first };
    await key("z", { ctrlKey: true });
    const two = { mode: t.mode, path: t.path.length, first: !!t.first, arcEnd: !!t.arcEnd };
    expect("sketch: arc, right click (a path), Ctrl+Z ×2 → back in the Arc tool, its start and end picked (not loose dots in Select)",
      ended && one.mode === "arc" && one.path === 1 && one.first && two.mode === "arc" && two.path === 0 && two.first && two.arcEnd && t.opens.length === opens0,
      { ended, one, two, opens: t.opens.length - opens0 });
    await key("Escape"); await key("Escape");
  }
  const n0 = app.doc.bodies.length;
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(50);
  const made = app.doc.bodies.slice(n0);
  const areas = made.map(area).sort((a, b) => a - b);
  const want = [300 - Math.PI * 4, 100 + Math.PI * 25].sort((a, b) => a - b);
  expect("sketch: Done → 2 flat faces on the top (L with a hole, slot); view back", !app.tool && made.length === 2 && made.every((b) => b.kind === "face" && K.isValidShape(b.shape) && Math.abs(b.shape.boundingBox.bounds[0][2] - 20) < 1e-6) && areas.every((a, i) => Math.abs(a - want[i]) < 1e-3) && vp.camera.position.toArray().every((v, i) => Math.abs(v - cam0[i]) < 1e-6) && !document.getElementById("sketch-panel"),
    { tool: app.tool && app.tool.name, made: made.length, areas, want });
  app.run("edit.undo");
  expect("sketch: one undo step removes the sketch faces", app.doc.bodies.length === n0, app.doc.bodies.length);
  // On a side face (the front, y = 0): the view stays upright (world Z up), sketch X runs along world X, Y up
  const front = box.shape.faces.find((f) => f.normalAt(f.center).toTuple()[1] < -0.99);
  app.setSelection([{ kind: "face", body: box.id, id: front.hashCode }]);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", code: "KeyK", bubbles: true, cancelable: true })); await sleep(50);
  const sdir = vp.camera.getWorldDirection(new V()), sup = vp.camera.up.clone();
  await key("r"); await hover([5, 0, 5]); await click([5, 0, 5]); await hover([30, 0, 15]); await type("20x10");
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const sf = app.doc.bodies[app.doc.bodies.length - 1], sb = sf.shape.boundingBox.bounds;
  expect("sketch: K on a side face — looks straight at it, Z up; typed 20x10 → 20 wide (X), 10 high (Z)", sdir.y > 0.999 && sup.z > 0.999 && app.doc.bodies.length === n0 + 1 && Math.abs(sb[1][0] - sb[0][0] - 20) < 1e-6 && Math.abs(sb[1][2] - sb[0][2] - 10) < 1e-6 && Math.abs(sb[0][1] - front.center.y) < 1e-9,
    { dir: sdir.toArray(), up: sup.toArray(), n: app.doc.bodies.length, sb });
  app.run("edit.undo");
  // On the ground (nothing selected): R + typed size; Cancel drops it, Done keeps it
  app.setSelection([]);
  app.run("tool.sketch"); await sleep(30);
  await key("r"); await click([30, 30, 0]); await type("20,10");
  // A circle round the rectangle's corner: where it crosses the bottom edge (35, 30) snaps
  await key("c"); await click([30, 30, 0]); await type("5");
  await key("l"); await hover([35.3, 30.2, 0]);
  // Double-click: done drawing — the two lines stay open (a path)
  const nLoops = app.tool.loops.length, nOpens = app.tool.opens.length;
  await click([60, 0, 0]); await click([70, 0, 0]); await click([70, 10, 0]); await click([70, 10, 0]);
  const tri = app.tool.opens[nOpens];
  expect("sketch: double-click ends the lines, open (a path)", app.tool.loops.length === nLoops && app.tool.opens.length === nOpens + 1 && tri && tri.length === 2 && app.tool.first === null, { loops: app.tool.loops.length, tri });
  // (the path drawn thicker than outlines: 2.5 px, in pink)
  app.tool.update(); await sleep(20);
  const thick = vp.overlayRoot.children.filter((o) => o.isLineSegments2 && o.material.linewidth === 2.5 && o.material.color.getHex() === 0xff69b4).length;
  expect("sketch: open paths are drawn thicker (2.5 px pink lines)", thick >= 1, { thick });
  // Capsule: line 30, arc with R 5 typed (clicked a little off the half turn — it snaps), line 30,
  // arc R 5 clicked on the start point
  await key("l"); await click([80, -20, 0]); await hover([120, -20, 0]); await type("30");
  await key("a"); await type("5"); await click([110.4, -10.2, 0]);
  await key("l"); await hover([70, -10, 0]); await type("30");
  await key("a"); await type("5"); await click([80, -20, 0]);
  const cap = app.tool.loops[app.tool.loops.length - 1];
  // First arc: click its start and end (20 apart), type R + Enter, Enter again places it — R 10: a half circle, R 15: flatter
  const firstArc = async (y, r) => { await key("l"); await key("a"); await click([0, y, 0]); await click([20, y, 0]); await hover([10, y - 8, 0]); await type(String(r)); await key("Enter"); const o = app.tool.opens[app.tool.opens.length - 1]; return o && o.length === 1 ? o[0] : null; };
  const half = await firstArc(-40, 10), flat = await firstArc(-70, 15);
  await key("a"); await key("a");
  const stillArc = app.tool.mode === "arc";
  const sag = 15 - Math.sqrt(15 * 15 - 10 * 10);
  // Line, then A and the mouse a little off straight above the line's end: it lines up (same X) → a half circle
  await key("l"); await click([200, -200, 0]); await click([230, -200, 0]); await key("a"); await hover([230.4, -190, 0]);
  const lined = app.tool.cursor, guides = app.tool.aligned.length;
  await click([230.4, -190, 0]);
  const hc = app.tool.path[app.tool.path.length - 1];
  expect("sketch: line, A, mouse near straight above its end → lines up (dashed guide) → exact half circle", lined && Math.abs(lined[0] - 230) < 1e-9 && guides >= 1 && hc && hc.kind === "arc" && Math.abs(hc.m[0] - 235) < 1e-6 && Math.abs(hc.m[1] + 195) < 1e-6, { lined, guides, hc });
  await key("Escape");
  // Too small a radius for the ends (20 apart): refused; a fitting one shows what to do next
  await key("l"); await key("a"); await click([0, -100, 0]); await click([20, -100, 0]); await type("1");
  const refused = app.tool.arcR === null;
  await type("10");
  const tip = document.querySelector("#sketch-panel .tip")?.textContent ?? "";
  expect("sketch: arc R too small for its ends is refused; R 10 → tip says move to the bulge side, then click / Enter", refused && app.tool.arcR === 10 && /R 10 set — move the mouse to the side the arc should bulge/.test(tip), { refused, arcR: app.tool.arcR, tip });
  await key("Escape"); await key("Escape");
  const nearP = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  expect("sketch: A always means Arc (pressing it again stays on Arc)", stillArc, app.tool.mode);
  expect("sketch: first arc — type R, Enter, Enter: placed, done — an open arc (R 10 → half circle, R 15 → flatter)", half && half.kind === "arc" && nearP(half.m, [10, -50]) && flat && flat.kind === "arc" && nearP(flat.m, [10, -70 - sag]), { half, flat });
  const near2 = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  expect("sketch: typed arc R, then click: half circles (snapped) — a closed capsule", cap && cap.segs.length === 4 && cap.segs.map((g) => g.kind).join() === "line,arc,line,arc" && near2(cap.segs[1].m, [115, -15]) && near2(cap.segs[3].m, [75, -15]) && app.tool.first === null, cap);
  await key("l"); await hover([35.3, 30.2, 0]);
  const x = app.tool.cursor;
  expect("sketch: where a circle crosses a line snaps", x && Math.abs(x[0] - 35) < 1e-9 && Math.abs(x[1] - 30) < 1e-9, x);
  document.querySelector("#sketch-panel button[data-act=cancel]").click(); await sleep(30);
  expect("sketch: Cancel drops the sketch", !app.tool && app.doc.bodies.length === n0, app.doc.bodies.length);
  app.run("tool.sketch"); await sleep(30);
  await key("r"); await hover([60, 60, 0]); await click([30, 30, 0]); await hover([60, 60, 0]); await type("20x10");
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const g = app.doc.bodies[app.doc.bodies.length - 1], gb = g.shape.boundingBox.bounds;
  expect("sketch: on the ground, R + typed 20x10 → a 20 x 10 face at z 0", app.doc.bodies.length === n0 + 1 && Math.abs(area(g) - 200) < 1e-6 && Math.abs(gb[0][2]) < 1e-9 && Math.abs(gb[1][0] - gb[0][0] - 20) < 1e-6, { n: app.doc.bodies.length, area: area(g), gb });
  // Rectangle, then a half circle on its right side (corner, corner, mouse out, Enter = done) and one on its
  // left side (double-click = done): 3 separate faces (30 x 10, two half discs R 5)
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  await key("r"); await click([100, 50, 0]); await click([130, 60, 0]);
  await key("a"); await click([130, 50, 0]); await click([130, 60, 0]); await hover([135.2, 55.4, 0]); await key("Enter"); // (≈ a half circle: snaps to one)
  await key("l"); await key("a"); await click([100, 60, 0]); await click([100, 50, 0]); await click([95, 55, 0]); await click([95, 55, 0]);
  const nb = app.doc.bodies.length;
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const caps = app.doc.bodies.slice(nb).map(area).sort((a, b) => a - b);
  const wantCaps = [Math.PI * 12.5, Math.PI * 12.5, 300];
  expect("sketch: rectangle + half circles on its sides (mouse near the half circle + Enter, or double-click = done) → 3 faces", caps.length === 3 && caps.every((a, i) => Math.abs(a - wantCaps[i]) < 1e-6), { caps, wantCaps });
  // Half circle face: A, click start, click end (20 apart), click the bulge, L, click the start → one closed outline; Done → a half disc
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  await key("a"); await click([0, 200, 0]); await click([20, 200, 0]); await hover([10, 209, 0]); await click([10, 209.6, 0]);
  const afterArc = { path: app.tool.path.length, first: app.tool.first, mode: app.tool.mode };
  await key("l"); await hover([0.2, 200.1, 0]); await click([0, 200, 0]);
  const hd = { loops: app.tool.loops.length, opens: app.tool.opens.length, path: app.tool.path.length, first: app.tool.first };
  const nh = app.doc.bodies.length;
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const halfDisc = app.doc.bodies.slice(nh).map(area);
  expect("sketch: half circle face — A, start, end, bulge, L, start → a half disc (157.08 mm²)", halfDisc.length === 1 && Math.abs(halfDisc[0] - Math.PI * 50) < 1e-6, { afterArc, hd, halfDisc });
  // ...and the same without pressing L: in Arc mode, back to the start after one arc closes with a straight line
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  await key("a"); await click([0, 200, 0]); await click([20, 200, 0]); await click([10, 209.6, 0]); await hover([0.2, 200.1, 0]); await click([0, 200, 0]);
  const nh2 = app.doc.bodies.length;
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const halfDisc2 = app.doc.bodies.slice(nh2).map(area);
  expect("sketch: half circle face without L — the click on the start closes with a straight line", halfDisc2.length === 1 && Math.abs(halfDisc2[0] - Math.PI * 50) < 1e-6, halfDisc2);
  // Ended just short of the start (the closing click missed it by a few pixels) with a double-click: closes there exactly
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  const wpp = vp.worldPerPixel(new V(0, 400, 0));
  // (big — 200 wide — so a 16 px miss is a small one next to it; the view is zoomed far out here)
  await key("a"); await click([0, 400, 0]); await click([200, 400, 0]); await click([100, 499, 0]);
  // (16 px off the start: outside the 12 px point snap)
  await key("l"); const miss = [wpp * 16, 400 + wpp * 2, 0]; await click(miss);
  const beforeEnd = { loops: app.tool.loops.length, path: app.tool.path.length };
  await click(miss);
  const nearLoops = app.tool.loops.length, nearOpens = app.tool.opens.length;
  const nh3 = app.doc.bodies.length;
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const halfDisc3 = app.doc.bodies.slice(nh3).map(area);
  expect("sketch: ended a few pixels short of the start → closes there exactly (a half disc)", beforeEnd.loops === 0 && beforeEnd.path === 2 && nearLoops === 1 && nearOpens === 0 && halfDisc3.length === 1 && Math.abs(halfDisc3[0] - Math.PI * 5000) < 1e-4, { beforeEnd, nearLoops, nearOpens, halfDisc3 });
  // An arc ended with a double-click (an open path), then L, a click on the arc's end, a click on its other end: closed → a half disc
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  await key("a"); await click([0, 600, 0]); await click([0, 400, 0]); await click([99, 500, 0]); await click([99, 500, 0]);
  const openArc = app.tool.opens.length === 1 && !app.tool.first;
  await key("l"); await click([0, 600, 0]); await click([0, 400, 0]);
  const resumed = { loops: app.tool.loops.length, opens: app.tool.opens.length };
  const nh4 = app.doc.bodies.length;
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const halfDisc4 = app.doc.bodies.slice(nh4).map(area);
  expect("sketch: a click on an open path's end carries it on; clicking its other end closes it (a half disc)", openArc && resumed.loops === 1 && resumed.opens === 0 && halfDisc4.length === 1 && Math.abs(halfDisc4[0] - Math.PI * 5000) < 1e-4, { openArc, resumed, halfDisc4 });
  // Select (Esc when nothing is being drawn): click inside an outline, Shift+click a path's line; Del deletes both, Ctrl+Z brings them back
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  await key("r"); await click([300, 0, 0]); await click([340, 30, 0]);
  await key("l"); await click([300, 60, 0]); await click([340, 60, 0]); await key("Enter");
  await key("Escape");
  const inSelect = app.tool.mode === "select";
  await hover([320, 60.5, 0]);
  const hovered = JSON.stringify(app.tool.hoverItem);
  await click([320, 15, 0]);
  const one = JSON.stringify(app.tool.selected);
  const pe2 = (t, p, extra) => { const sc = window.__see(new V(p[0], p[1], p[2])); canvas.dispatchEvent(new PointerEvent(t, { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true, ...extra })); };
  pe2("pointermove", [320, 60.5, 0], {}); pe2("pointerdown", [320, 60.5, 0], { shiftKey: true }); pe2("pointerup", [320, 60.5, 0], { shiftKey: true }); await sleep(10);
  const two = app.tool.selected.length;
  await key("Delete");
  const deleted = app.tool.loops.length === 0 && app.tool.opens.length === 0;
  await key("z", { ctrlKey: true });
  const back = app.tool.loops.length === 1 && app.tool.opens.length === 1;
  await click([380, 15, 0]);
  const none = app.tool.selected.length === 0;
  // Drag the rectangle (+10, +10), then type 5,0 + Enter (+5, 0); Ctrl+Z takes the typed move back
  const corner = () => app.tool.loops[0].segs[0].a;
  pe2("pointermove", [320, 15, 0], {}); pe2("pointerdown", [320, 15, 0], {});
  for (let k = 1; k <= 5; k++) pe2("pointermove", [320 + 2 * k, 15 + 2 * k, 0], {});
  pe2("pointerup", [330, 25, 0], {}); await sleep(10);
  const dragged = corner();
  await type("5,0");
  const typedMove = corner();
  await key("z", { ctrlKey: true });
  const undone = corner();
  const nearQ = (p, q) => Math.abs(p[0] - q[0]) < 1e-6 && Math.abs(p[1] - q[1]) < 1e-6;
  expect("sketch: Select — drag moves the selection; typed dx,dy moves it exactly; Ctrl+Z undoes a move", nearQ(dragged, [310, 10]) && nearQ(typedMove, [315, 10]) && nearQ(undone, [310, 10]) && Math.abs(app.tool.opens[0][0].a[0] - 300) < 1e-6, { dragged, typedMove, undone });
  expect("sketch: Select — Esc switches to it; click inside an outline, Shift+click a path; Del deletes, Ctrl+Z undoes; empty click clears", inSelect && hovered === JSON.stringify({ kind: "open", i: 0 }) && one === JSON.stringify([{ kind: "loop", i: 0 }]) && two === 2 && deleted && back && none, { inSelect, hovered, one, two, deleted, back, none });
  document.querySelector("#sketch-panel button[data-act=cancel]").click(); await sleep(20);
  // Join (J): rectangle + a half circle on each side, selected and joined → ONE capsule face at Done
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  await key("r"); await click([500, 0, 0]); await click([700, 100, 0]);
  await key("a"); await click([700, 0, 0]); await click([700, 100, 0]); await hover([749, 50, 0]); await key("Enter");
  await key("a"); await click([500, 100, 0]); await click([500, 0, 0]); await hover([451, 50, 0]); await key("Enter");
  const threeLoops = app.tool.loops.length;
  await key("Escape"); await click([600, 50, 0]);
  pe2("pointermove", [740, 50, 0], {}); pe2("pointerdown", [740, 50, 0], { shiftKey: true }); pe2("pointerup", [740, 50, 0], { shiftKey: true }); await sleep(10);
  pe2("pointermove", [460, 50, 0], {}); pe2("pointerdown", [460, 50, 0], { shiftKey: true }); pe2("pointerup", [460, 50, 0], { shiftKey: true }); await sleep(10);
  const sel3 = app.tool.selected.length;
  await key("j");
  const afterJ = app.tool.selected.map((x) => x.kind + x.i).join();
  await click([600, 50, 0]);
  const groupSel = app.tool.selected.length;
  const nj = app.doc.bodies.length;
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const capsule = app.doc.bodies.slice(nj).map(area);
  expect("sketch: Join — rectangle + 2 half circles → one capsule face; the result stays selected; clicking one selects the joined group", threeLoops === 3 && sel3 === 3 && afterJ === "loop0,loop1,loop2" && groupSel === 3 && capsule.length === 1 && Math.abs(capsule[0] - (200 * 100 + Math.PI * 2500)) < 1e-3, { threeLoops, sel3, afterJ, groupSel, capsule });
  // Join overlapping outlines: two circles (most of the small one lies inside the big one,
  // but not all: not a hole) → one face, the area of their union
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  // (big — the view is zoomed far out here: R 200 and R 150, 100 apart)
  await key("c"); await click([500, -1000, 0]); await type("200"); await click([600, -1000, 0]); await type("150");
  await key("Escape"); await click([320, -1000, 0]);
  pe2("pointermove", [740, -1000, 0], {}); pe2("pointerdown", [740, -1000, 0], { shiftKey: true }); pe2("pointerup", [740, -1000, 0], { shiftKey: true }); await sleep(10);
  await key("j");
  const nu = app.doc.bodies.length;
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const uni = app.doc.bodies.slice(nu).map(area);
  const lens = (d, r1, r2) => r1 * r1 * Math.acos((d * d + r1 * r1 - r2 * r2) / (2 * d * r1)) + r2 * r2 * Math.acos((d * d + r2 * r2 - r1 * r1) / (2 * d * r2)) - 0.5 * Math.sqrt((-d + r1 + r2) * (d + r1 - r2) * (d - r1 + r2) * (d + r1 + r2));
  const wantU = Math.PI * 40000 + Math.PI * 22500 - lens(100, 200, 150);
  expect("sketch: Join — two overlapping circles → one face of their union area", uni.length === 1 && Math.abs(uni[0] - wantU) < 1e-2, { uni, wantU });
  // Join paths: two open paths meeting end to end → one path
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  await key("l"); await click([500, 300, 0]); await click([600, 300, 0]); await key("Enter");
  await click([500, 400, 0]); await click([500, 300, 0]); await key("Enter");
  const twoPaths = app.tool.opens.length;
  await key("Escape"); await click([550, 300.5, 0]);
  pe2("pointermove", [500.5, 350, 0], {}); pe2("pointerdown", [500.5, 350, 0], { shiftKey: true }); pe2("pointerup", [500.5, 350, 0], { shiftKey: true }); await sleep(10);
  await key("j");
  const joinedPath = app.tool.opens.length === 1 && app.tool.opens[0].length === 2;
  const pathSel = app.tool.selected.map((x) => x.kind + x.i).join();
  await key("s");
  const sAfterJ = !!app.tool.scaling;
  await key("Escape");
  expect("sketch: Join — two paths meeting end to end → one path, left selected (S scales it)", twoPaths === 2 && joinedPath && pathSel === "open0" && sAfterJ, { twoPaths, opens: app.tool.opens, pathSel, sAfterJ });
  document.querySelector("#sketch-panel button[data-act=cancel]").click(); await sleep(20);
  // Lines, then a double-click on the start point: the outline closes — and no new line starts there
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  await key("l"); await click([0, -400, 0]); await click([200, -400, 0]); await click([200, -250, 0]); await click([0, -400, 0]); await click([0, -400, 0]);
  const dbl = { loops: app.tool.loops.length, first: app.tool.first, opens: app.tool.opens.length };
  expect("sketch: double-click on the start point closes the outline, no new line after it", dbl.loops === 1 && dbl.first === null && dbl.opens === 0, dbl);
  document.querySelector("#sketch-panel button[data-act=cancel]").click(); await sleep(20);
  // The Rectangle tool (A) takes 40x25 too
  app.setSelection([]); app.run("tool.rectangle"); await sleep(20);
  await hover([-100, -100, 0]); await click([-100, -100, 0]); await hover([-50, -50, 0]); await type("40x25");
  const rf = app.doc.bodies[app.doc.bodies.length - 1], rb = rf.shape.boundingBox.bounds;
  expect("rectangle tool: typed 40x25 → a 40 x 25 face", !app.tool && Math.abs(rb[1][0] - rb[0][0] - 40) < 1e-6 && Math.abs(rb[1][1] - rb[0][1] - 25) < 1e-6, { tool: app.tool && app.tool.name, rb });
  // Open lines become a path object at Done: picked by its line in Solid mode, moved, saved / loaded; Push/Pull refuses it
  // (on an empty model: the checks before left bodies far apart, zooming the view out)
  app.doc.reset([]); app.setSelection([]); vp.setView("iso"); vp.fit(); await sleep(30);
  app.run("tool.sketch"); await sleep(30);
  await key("l"); await click([-100, 60, 0]); await click([-60, 60, 0]); await key("a"); await click([-60, 140, 0]); await key("Enter"); // (big: the view is zoomed far out here)
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  const pb = app.doc.bodies[app.doc.bodies.length - 1];
  const kinds = pb && pb.shape.edges.map((e) => e.geomType).join();
  app.setSelection([]); app.run("mode.body");
  const sc = window.__see(new V(-80, 60, 0));
  canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent("pointerdown", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true }));
  canvas.dispatchEvent(new PointerEvent("pointerup", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); await sleep(20);
  const picked = app.selection.length === 1 && app.selection[0].body === pb.id;
  app.run("op.pushpull"); await sleep(20);
  const ppRefused = !document.querySelector("#op-panel h4");
  // Clicked, then G: the gizmo moves it (+5 up)
  const z0 = app.doc.get(pb.id).shape.boundingBox.bounds[0][2];
  app.setSelection([{ kind: "body", body: pb.id, id: 0 }]); app.run("xf.move"); await sleep(20);
  const gOn = !!app.xf;
  if (gOn) { vp.pivot.position.z += 5; vp.finishTransformDrag(); await sleep(20); }
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true })); await sleep(20);
  const moved = gOn && Math.abs(app.doc.get(pb.id).shape.boundingBox.bounds[0][2] - z0 - 5) < 1e-6;
  app.loadModel(app.modelText(), null); await sleep(20);
  const reread = app.doc.bodies.find((b) => b.kind === "path" && b.shape.edges.length === 2);
  expect("sketch: open lines → a path object (line + arc): picked by its line, Push/Pull refuses it, G moves it, saved as a path", pb && pb.kind === "path" && kinds === "LINE,CIRCLE" && picked && ppRefused && moved && !!reread, { kind: pb && pb.kind, kinds, picked, ppRefused, moved, gOn, z0, z1: app.doc.get(pb.id)?.shape.boundingBox.bounds[0][2], reloaded: !!reread });
  // Scale (Select): typed 200 doubles about the centre, Ctrl+Z undoes; S: the gizmo (X / Y / XY handles), Tab, Esc
  {
    app.doc.reset([]); app.setSelection([]); vp.setView("iso"); vp.fit(); await sleep(30);
    app.run("tool.sketch"); await sleep(30);
    await key("r"); await click([0, 0, 0]); await click([40, 20, 0]);
    await key("Escape"); await click([20, 10, 0]);
    const corners = () => app.tool.loops[0].segs.map((g) => g.a.map((v) => +v.toFixed(6)).join(",")).join(" ");
    await type("200");
    const doubled = corners();
    await key("z", { ctrlKey: true });
    const undone = corners();
    await click([20, 10, 0]); // (undo clears the selection)
    // The gizmo: drag the XY ring to 1.5× its distance from the centre, Enter → 150%
    const dlg = (vals) => { const d = document.getElementById("props-dlg"); if (!d) return false; const q = [...d.querySelectorAll("input")]; vals.forEach((v, i) => { if (q[i]) q[i].value = String(v); }); d.requestSubmit(); return true; };
    const dragHandle = async (h, f) => {
      const c = app.tool.scaling.c, hp = app.tool.handlePos(h);
      const to = h === "x" ? [c[0] + (hp[0] - c[0]) * f, hp[1]] : h === "y" ? [hp[0], c[1] + (hp[1] - c[1]) * f] : [c[0] + (hp[0] - c[0]) * f, c[1] + (hp[1] - c[1]) * f];
      pe("pointermove", [hp[0], hp[1], 0]); pe("pointerdown", [hp[0], hp[1], 0]);
      for (let k = 1; k <= 4; k++) pe("pointermove", [hp[0] + (to[0] - hp[0]) * k / 4, hp[1] + (to[1] - hp[1]) * k / 4, 0]);
      pe("pointerup", [to[0], to[1], 0]); await sleep(10);
    };
    await key("s"); await dragHandle("xy", 1.5);
    const live = +app.tool.scaling.kx.toFixed(6);
    await key("Enter");
    const k150 = corners();
    // X only: drag the red square to 2× → twice as wide, same height
    await click([20, 10, 0]); await key("s"); await dragHandle("x", 2); await key("Enter");
    const x2 = corners();
    // Tab while scaling: X 50 %, Y 200 %
    await click([20, 10, 0]); await key("s"); await key("Tab"); await sleep(10); const dOk = dlg([100, 50, 200]); await sleep(10);
    const tabbed = corners();
    // Esc cancels a gizmo drag
    await click([20, 10, 0]); await key("s"); await dragHandle("xy", 2); await key("Escape");
    const cancelled = corners();
    // A circle: evenly it stays a circle; X 50 % / Y 200 % → a freeform curve (an exact 5 × 20 ellipse)
    await key("c"); await click([100, 0, 0]); await type("10"); await key("Escape"); await click([100, 0, 0]);
    await type("150");
    const circleR = app.tool.loops[1] && app.tool.loops[1].kind === "circle" && app.tool.loops[1].r;
    await key("s");
    const curves = app.tool.scaling && app.tool.scaling.curves;
    await key("Tab"); await sleep(10); dlg([100, 100 / 3, 400 / 3]); await sleep(10);
    const ell = app.tool.loops[1];
    const ellOk = ell && ell.kind === "path" && ell.segs.length === 1 && ell.segs[0].kind === "spline";
    const ellPts = ellOk ? ell.segs[0].pts.filter((_, i) => i % 2 === 0).map((q) => q.map((v) => +v.toFixed(6)).join(",")).join(" ") : null;
    const nb = app.doc.bodies.length;
    document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
    const made = app.doc.bodies.slice(nb), ellBody = made.find((b) => b.shape.edges.length === 1);
    const ellArea = ellBody && area(ellBody), ellEdge = ellBody && ellBody.shape.edges[0].geomType;
    // (the edge exactly on the ellipse; the area only roughly — OpenCascade integrates B-spline outlines numerically)
    const ellOff = ellBody ? Math.max(...Array.from({ length: 50 }, (_, i) => { const q = ellBody.shape.edges[0].pointAt(i / 50); return Math.abs(((q.x - 100) / 5) ** 2 + (q.y / 20) ** 2 - 1); })) : 1;
    expect("sketch: Scale gizmo — XY ring 150%, X square 2× wide only, Tab X 50% / Y 200%, Esc cancels; a circle: X / Y unevenly → an exact freeform ellipse", doubled === "-20,-10 60,-10 60,30 -20,30" && undone === "0,0 40,0 40,20 0,20" && live === 1.5 && k150 === "-10,-5 50,-5 50,25 -10,25" && x2 === "-40,-5 80,-5 80,25 -40,25" && dOk && tabbed === "-10,-20 50,-20 50,40 -10,40" && cancelled === tabbed && curves === true && Math.abs(circleR - 15) < 1e-6 && ellOk && ellPts === "105,0 100,20 95,0 100,-20 105,0" && made.length === 2 && ellEdge === "BSPLINE_CURVE" && ellOff < 1e-9 && Math.abs(ellArea - Math.PI * 100) < 0.1, { doubled, undone, live, k150, x2, tabbed, cancelled, curves, circleR, ellPts, n: made.length, ellEdge, ellOff, ellArea });
  }
  // Tab (YDDD's exact values): a capsule drawn only with Tab dialogs; a rectangle; then the selection moved + scaled
  {
    const dialog = (vals) => { const d = document.getElementById("props-dlg"); if (!d) return false; const q = [...d.querySelectorAll("input")]; vals.forEach((v, i) => { if (q[i]) q[i].value = String(v); }); d.requestSubmit(); return true; };
    const tab = async (vals) => { await key("Tab"); await sleep(10); const ok = dialog(vals); await sleep(10); return ok; };
    app.doc.reset([]); app.setSelection([]); vp.setView("iso"); vp.fit(); await sleep(30);
    app.run("tool.sketch"); await sleep(30);
    const oks = [];
    await key("l"); await hover([5, 5, 0]); oks.push(await tab([0, 0]));
    oks.push(await tab([40, 0]));
    await key("a"); await hover([45, 15, 0]); oks.push(await tab([10, 180]));
    await key("l"); oks.push(await tab([40, 180]));
    await key("a"); await hover([-5, 10, 0]); oks.push(await tab([10, 180]));
    const cap = app.tool.loops[0];
    const capOk = cap && cap.segs.map((g) => g.kind).join() === "line,arc,line,arc" && app.tool.first === null;
    await key("r"); await hover([100, 0, 0]); oks.push(await tab([30, 10]));
    const rect = app.tool.loops[1];
    await key("Escape"); await click([115, 5, 0]); oks.push(await tab([10, 0, 200]));
    const moved = app.tool.loops[1].segs.map((g) => g.a.map((v) => +v.toFixed(6)).join(",")).join(" ");
    const nt = app.doc.bodies.length;
    document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
    const areas = app.doc.bodies.slice(nt).map(area).sort((x, y) => x - y);
    expect("sketch: Tab — dialogs for the first point, line, arc, rectangle and the selection (move + scale)", oks.every(Boolean) && capOk && !!rect && moved === "95,-5 155,-5 155,15 95,15" && areas.length === 2 && Math.abs(areas[0] - (800 + Math.PI * 100)) < 1e-6 && Math.abs(areas[1] - 1200) < 1e-6, { oks, capOk, moved, areas });
  }
  // Right click → Select, keeping the lines being drawn (as Enter); in Select it clears the selection
  {
    app.doc.reset([]); app.setSelection([]); vp.setView("iso"); vp.fit(); await sleep(30);
    app.run("tool.sketch"); await sleep(30);
    const rclick = async (p) => { const sc = window.__see(new V(p[0], p[1], p[2])); for (const t of ["pointerdown", "pointerup"]) canvas.dispatchEvent(new PointerEvent(t, { clientX: sc.x, clientY: sc.y, button: 2, bubbles: true })); await sleep(10); };
    await key("l"); await click([0, 0, 0]); await click([30, 0, 0]); await click([30, 20, 0]); await rclick([50, 50, 0]);
    const r1 = { mode: app.tool.mode, opens: app.tool.opens.length, first: app.tool.first };
    await click([15, 0.3, 0]);
    const sel1 = app.tool.selected.length;
    await rclick([50, 50, 0]);
    const r2 = { mode: app.tool.mode, sel: app.tool.selected.length, tool: app.tool && app.tool.name };
    expect("sketch: right click → Select, the lines kept (a path); right click again clears the selection", r1.mode === "select" && r1.opens === 1 && r1.first === null && sel1 === 1 && r2.mode === "select" && r2.sel === 0 && r2.tool === "Sketch", { r1, sel1, r2 });
    document.querySelector("#sketch-panel button[data-act=cancel]").click(); await sleep(20);
  }
  // X-ray has its own toolbar button (not in the View drawer), lit while x-ray is on
  {
    const btn = document.querySelector("#toolbar .tb-btn[data-cmd='view.xray']");
    const inDrawer = !!document.querySelector(".tb-drawer [data-cmd='view.xray']");
    const was = vp.xray;
    btn.click(); await sleep(20);
    const toggled = vp.xray === !was && btn.classList.contains("active") === vp.xray;
    btn.click(); await sleep(20);
    const back = vp.xray === was && btn.classList.contains("active") === was;
    expect("toolbar: X-ray is its own button outside the View drawer and shows when it's on", !!btn && !inDrawer && toggled && back, { btn: !!btn, inDrawer, toggled, back });
  }
  // Pro layout (Ctrl+Shift+F1 / View menu): one-row sketch panel, text-only Recent strip, short hints; back again
  {
    const hintEl = document.getElementById("status-hint");
    app.setSelection([]); app.run("tool.sketch"); await sleep(30);
    const fullTip = !!document.querySelector("#sketch-panel .tip");
    app.run("view.pro"); await sleep(30);
    const pro = document.body.classList.contains("pro"), compact = document.getElementById("sketch-panel").classList.contains("compact") && !document.querySelector("#sketch-panel .tip") && !!document.querySelector("#sketch-panel button[data-act=done]");
    const sketchHint = hintEl.textContent;
    document.querySelector("#sketch-panel button[data-act=cancel]").click(); await sleep(20);
    app.hint("Solid mode: click to select · Shift+click to add");
    const shortHint = hintEl.textContent;
    const svg = document.querySelector("#recent-list .tb-btn svg");
    const noIcons = !svg || getComputedStyle(svg).display === "none";
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "P", code: "KeyP", ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })); await sleep(20);
    const back = !document.body.classList.contains("pro") && localStorage.getItem("yddd.pro") === "0";
    expect("pro layout: Ctrl+Shift+F1 → compact sketch panel, short hints, text-only Recent; Ctrl+Shift+P back", fullTip && pro && compact && /Enter: done/.test(sketchHint) && shortHint === "Solid mode: click to select" && noIcons && back, { fullTip, pro, compact, sketchHint, shortHint, noIcons, back });
    // The Pro tip comes once, with the 20th save
    localStorage.setItem("yddd.saves", "18"); localStorage.removeItem("yddd.proTip");
    const tips = () => [...document.querySelectorAll("#toasts .toast")].filter((t) => /Pro layout/.test(t.textContent)).length;
    const t0 = tips(); app.noteSaved(); const t19 = tips(); app.noteSaved(); const t20 = tips(); app.noteSaved(); const t21 = tips();
    expect("pro layout: a one-time tip with the 20th save", t19 === t0 && t20 === t0 + 1 && t21 === t20 && localStorage.getItem("yddd.proTip") === "1", { t0, t19, t20, t21 });
    for (const k of ["yddd.saves", "yddd.proTip", "yddd.pro"]) localStorage.removeItem(k);
  }
  // The 3D corner view follows a moved / scaled outline (re-framed to keep it in view)
  {
    app.setSelection([]); app.run("tool.sketch"); await sleep(30);
    await key("r"); await click([50, 50, 0]); await type("10,10");
    await key("Escape"); await click([55, 50, 0]);
    const inView = (p) => { const q = new V(...p).project(vp.inset.camera); return Math.abs(q.x) <= 1 && Math.abs(q.y) <= 1; };
    await type("400,300"); await sleep(10);
    const moved = inView([455, 355, 0]);
    await type("300"); await sleep(10); // (scaled ×3 about its centre: corners at 440..470)
    const scaled = inView([470, 370, 0]) && inView([440, 340, 0]);
    expect("sketch: the 3D corner view follows a moved and a scaled outline", moved && scaled && app.tool.selected.length === 1, { moved, scaled });
    // Deleted (Del): it frames what's left — zoomed back in
    const camD = () => vp.inset.camera.position.distanceTo(new V(20, 15, 10));
    const dFar = camD(); await key("Delete"); await sleep(10); const dFace = camD();
    await key("l"); await click([-600, 0, 0]); await click([-590, 0, 0]); await key("Enter");
    const dPath = camD(); await key("Escape"); await click([-595, 0, 0]); await key("Delete"); await sleep(10); const dGone = camD();
    expect("sketch: the 3D corner view re-frames after deleting a face, and a path", dFace < dFar * 0.5 && dPath > dFace * 2 && dGone < dPath * 0.5 && !app.tool.loops.length && !app.tool.opens.length, { dFar, dFace, dPath, dGone });
    document.querySelector("#sketch-panel button[data-act=cancel]").click(); await sleep(30);
  }
  // Picture to trace (on the ground): % scales it about its centre, Match moves / scales / turns it so two
  // of its points land on two model points, a drag moves it; the turn icon turns the view a quarter; Done
  // keeps no picture in the model, and the next sketch on the same plane shows it again where it was
  {
    app.setSelection([]); app.run("tool.sketch"); await sleep(30);
    const cv = document.createElement("canvas"); cv.width = 200; cv.height = 100;
    app.tool.setPicture(cv); await sleep(10);
    const p0 = { ...app.tool.pic };
    expect("sketch picture: loaded 2:1, upright, into Picture mode", app.tool.mode === "picture" && Math.abs(p0.w / p0.h - 2) < 1e-9 && Math.abs(Math.sin(p0.ang)) < 1e-9, { w: p0.w, h: p0.h, ang: p0.ang });
    await type("50");
    const p1 = app.tool.pic;
    expect("sketch picture: 50 + Enter halves it about its centre", Math.abs(p1.w - p0.w / 2) < 1e-9 && Math.abs(p1.c[0] - p0.c[0]) < 1e-9 && Math.abs(p1.c[1] - p0.c[1]) < 1e-9, { w: p1.w, c: p1.c });
    // Two points on the picture 10 apart (along X), matched to the box's corners (0,0) → (0,30): ×3, a quarter turn
    const a1 = [p1.c[0] - 5, p1.c[1]], a2 = [p1.c[0] + 5, p1.c[1]], w1 = p1.w, ang1 = p1.ang;
    await click([...a1, 0]); await click([...a2, 0]); await click([0, 0, 0]); await click([0, 30, 0]);
    const pm = app.tool.pic, cm = [pm.c[0], pm.c[1]];
    expect("sketch picture: Match — scaled ×3, turned 90°, its centre lands at (0, 15)", Math.abs(pm.w - w1 * 3) < 1e-6 && Math.abs(pm.ang - ang1 - Math.PI / 2) < 1e-9 && Math.hypot(cm[0], cm[1] - 15) < 1e-6 && app.tool.picPts.length === 0, { w: pm.w, ang: pm.ang, c: cm });
    // (dragged from on the picture — its centre)
    const [cx, cy] = cm;
    pe("pointermove", [cx, cy, 0]); pe("pointerdown", [cx, cy, 0]); pe("pointermove", [cx + 10, cy + 5, 0]); pe("pointermove", [cx + 20, cy + 10, 0]); pe("pointerup", [cx + 20, cy + 10, 0]); await sleep(10);
    const pd = app.tool.pic;
    expect("sketch picture: a drag moves it", Math.hypot(pd.c[0] - cm[0] - 20, pd.c[1] - cm[1] - 10) < 1e-6 && Math.abs(pd.w - pm.w) < 1e-9, { c: pd.c });
    // Picture mode: the thumbnail glows and the picture's outline shows; a first click off the picture
    // only ends Picture mode (back to Line, nothing drawn)
    const outline = () => vp.overlayRoot.children.some((o) => o.type === "LineLoop" && o.material === app.tool.mats.sel);
    const menuOpen = () => getComputedStyle(document.querySelector("#sketch-corner .pic-menu")).display !== "none";
    const glowing = document.querySelector("#sketch-corner .pic-wrap").classList.contains("on") && menuOpen(), shown = outline();
    await key("l"); app.tool.setMode("picture"); await sleep(10);
    const far = app.tool.pic.c[0] + app.tool.pic.w * 2, nL = app.tool.loops.length, nO = app.tool.opens.length;
    await click([far, 0, 0]);
    expect("sketch picture: thumbnail lit, its menu open + outline in Picture mode; a click off the picture → back to Line (menu closed), nothing drawn", glowing && shown && app.tool.mode === "line" && !outline() && !menuOpen() && app.tool.first === null && app.tool.loops.length === nL && app.tool.opens.length === nO, { glowing, shown, mode: app.tool.mode, first: app.tool.first });
    const thumbBtn = () => document.querySelector("#sketch-corner .pic-thumb");
    thumbBtn().click(); const onA = app.tool.mode === "picture" && menuOpen(); thumbBtn().click();
    expect("sketch picture: the thumbnail turns Picture mode (and its menu) on, again off — back to Line", onA && app.tool.mode === "line" && !menuOpen(), app.tool.mode);
    const up0 = vp.camera.up.clone();
    document.querySelector("#sketch-corner button[data-act=turn]").click(); await sleep(10);
    const up1 = vp.camera.up.clone(), dir1 = vp.camera.getWorldDirection(new V());
    expect("sketch picture: the turn icon turns the view a quarter (still looking straight down)", Math.abs(up0.dot(up1)) < 1e-9 && dir1.z < -0.999, { up0: up0.toArray(), up1: up1.toArray() });
    await key("l"); await click([60, 60, 0]); await click([70, 60, 0]); await click([70, 70, 0]); await click([60, 60, 0]);
    const n0 = app.doc.bodies.length;
    document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
    expect("sketch picture: Done keeps the outline only (no picture in the model)", app.doc.bodies.length === n0 + 1 && !document.getElementById("sketch-corner") && !vp.overlayRoot.children.length, { n: app.doc.bodies.length });
    app.setSelection([]); app.run("tool.sketch"); await sleep(30);
    const pr = app.tool.pic;
    expect("sketch picture: the next sketch on the ground shows it again, where it was", pr && Math.hypot(pr.c[0] - pd.c[0], pr.c[1] - pd.c[1]) < 1e-6 && Math.abs(pr.w - pd.w) < 1e-6 && Math.abs(Math.cos(pr.ang - pd.ang) - 1) < 1e-9, pr && { c: pr.c, w: pr.w });
    app.tool.setMode("picture"); await key("Delete");
    expect("sketch picture: Del removes it", !app.tool.pic, null);
    // Loaded: a thumbnail beside the picture icon; its menu scales, turns and fades it
    app.tool.setPicture(cv); await sleep(10);
    const thumb = document.querySelector("#sketch-corner .pic-thumb canvas"), pw = app.tool.pic.w, pa = app.tool.pic.ang;
    const fld = (a) => document.querySelector("#sketch-corner [data-act=" + a + "]");
    const wheel = (a, up, shift = false) => fld(a).dispatchEvent(new WheelEvent("wheel", { deltaY: up ? -100 : 100, shiftKey: shift, bubbles: true, cancelable: true }));
    const typed = (a, v) => { fld(a).value = v; fld(a).dispatchEvent(new Event("input", { bubbles: true })); };
    const showsOk = fld("pic-scale").value === "100" && fld("pic-rotate").value === "0";
    wheel("pic-scale", true); wheel("pic-scale", true); wheel("pic-scale", true, true); // 100 → 105 → 110 → 111
    typed("pic-rotate", "90"); wheel("pic-rotate", false); // 90 → 85
    typed("pic-clear", "80");
    const pq = app.tool.pic;
    expect("sketch picture: menu fields — Scale 100 → wheel ×2 + Shift-wheel = 111%, Rotate 90 then wheel down = 85°, 80% transparent", showsOk && fld("pic-scale").value === "111" && Math.abs(pq.w - pw * 1.11) < 1e-9 && Math.abs(pq.ang - pa - (85 * Math.PI) / 180) < 1e-9 && Math.abs(pq.mat.opacity - 0.2) < 1e-9 && !document.querySelector("#sketch-corner [data-act=pic-match]"), { scale: fld("pic-scale").value, w: pq.w / pw, ang: ((pq.ang - pa) * 180) / Math.PI, op: pq.mat.opacity });
    // The handles at its bottom-right corner: the square scales about the centre (dragged out to twice as far: ×2),
    // the ring rotates about it (dragged a quarter round: +90°) — the fields follow
    {
      const P0 = app.tool.pic, c0 = P0.c, w1 = P0.w, t1 = P0.turned;
      const sq = app.tool.picGripPos("scale"), far2 = [c0[0] + (sq[0] - c0[0]) * 2, c0[1] + (sq[1] - c0[1]) * 2];
      pe("pointermove", [...sq, 0]); pe("pointerdown", [...sq, 0]); pe("pointermove", [...far2, 0]); pe("pointerup", [...far2, 0]); await sleep(10);
      const scaledOk = Math.abs(app.tool.pic.w - w1 * 2) < 1e-6 && Math.hypot(app.tool.pic.c[0] - c0[0], app.tool.pic.c[1] - c0[1]) < 1e-9;
      const ro = app.tool.picGripPos("rotate"), d = [ro[0] - c0[0], ro[1] - c0[1]], ro90 = [c0[0] - d[1], c0[1] + d[0]];
      pe("pointermove", [...ro, 0]); pe("pointerdown", [...ro, 0]); pe("pointermove", [...ro90, 0]); pe("pointerup", [...ro90, 0]); await sleep(10);
      const turnedOk = Math.abs(app.tool.pic.turned - t1 - Math.PI / 2) < 1e-6 && Math.abs(app.tool.pic.w - w1 * 2) < 1e-6;
      expect("sketch picture: corner handles — the square drags ×2 (about the centre), the ring +90°; the fields follow", scaledOk && turnedOk && app.tool.mode === "picture" && fld("pic-scale").value === "222" && fld("pic-rotate").value === "175", { w: app.tool.pic.w / w1, turned: ((app.tool.pic.turned - t1) * 180) / Math.PI, scale: fld("pic-scale").value, rot: fld("pic-rotate").value });
      typed("pic-scale", "111"); typed("pic-rotate", "85");
    }
    await type("50"); await sleep(10);
    expect("sketch picture: the Scale field follows a typed % in the view (111% × 50% = 55.5%)", fld("pic-scale").value === "55.5", fld("pic-scale").value);
    document.querySelector("#sketch-corner [data-act=pic-remove]").click();
    expect("sketch picture: menu Remove drops it and its thumbnail", !app.tool.pic && !document.querySelector("#sketch-corner .pic-thumb"), null);
    // A real file's bytes (PNG, JPEG) load too (through a blob: URL — the page's CSP must allow it)
    for (const [type, ext] of [["image/png", "png"], ["image/jpeg", "jpg"]]) {
      const bytes = new Uint8Array(await (await new Promise((r) => cv.toBlob(r, type))).arrayBuffer());
      let err = null;
      try { await app.tool.pictureFromBytes(bytes, ext); } catch (e) { err = String(e); }
      expect("sketch picture: a " + ext.toUpperCase() + " file loads", !err && app.tool.pic && Math.abs(app.tool.pic.w / app.tool.pic.h - 2) < 1e-9, err);
    }
    app.tool.setMode("picture"); await key("Delete");
    document.querySelector("#sketch-panel button[data-act=cancel]").click(); await sleep(30);
    app.run("edit.undo"); await sleep(10);
  }
  // K on a curved face: sketches on the flat plane touching it — under the cursor, else at the face's middle
  {
    app.doc.reset([]);
    const cyl = app.doc.makeBody(K.makeCylinder(G, [0, 0, 0], 10, 30), "Cylinder");
    app.doc.commit([cyl], "cylinder");
    app.run("mode.body"); app.setSelection([]); vp.setView("iso"); vp.fit(); await sleep(100);
    const side = cyl.shape.faces.find((f) => f.geomType === "CYLINDRE");
    /** The sketch plane: its normal and how far it is from the cylinder's axis (Z), at height 15. */
    const plane = () => { const f = app.tool && app.tool.frame; if (!f) return null; const o = f.origin, n = f.z; return { n: n.toArray().map((x) => +x.toFixed(3)), d: +(o.x * n.x + o.y * n.y + o.z * n.z).toFixed(3) }; };
    const moveTo = (p) => { const sc = window.__see(new V(p[0], p[1], p[2])); window.dispatchEvent(new PointerEvent("pointermove", { clientX: sc.x, clientY: sc.y, bubbles: true })); };
    const cancel = async () => { document.querySelector("#sketch-panel button[data-act=cancel]")?.click(); await sleep(30); };
    const toastSaid = () => [...document.querySelectorAll("#toasts .toast")].map((t) => t.textContent).join(" | ");
    // Cursor over the face, on the side facing the camera (the test may turn the view): the plane touches it right there
    const a = Math.atan2(vp.camera.position.y, vp.camera.position.x);
    moveTo([10 * Math.cos(a), 10 * Math.sin(a), 15]);
    app.setSelection([{ kind: "face", body: cyl.id, id: side.hashCode }]);
    await key("k"); await sleep(50);
    const under = plane(), said = toastSaid();
    await cancel();
    // Cursor elsewhere: the face's middle (still touching: 10 from the axis, level normal)
    moveTo([200, 200, 200]);
    app.setSelection([{ kind: "face", body: cyl.id, id: side.hashCode }]);
    await key("k"); await sleep(50);
    const middle = plane(), name = app.tool && app.tool.name;
    await cancel();
    expect("sketch: K on a curved face sketches on the plane touching it under the cursor (or at its middle), with a note that it stays flat",
      under && Math.abs(under.n[0] - Math.cos(a)) < 0.01 && Math.abs(under.n[1] - Math.sin(a)) < 0.01 && Math.abs(under.n[2]) < 1e-6 && Math.abs(under.d - 10) < 0.05 &&
        name === "Sketch" && middle && Math.abs(middle.n[2]) < 1e-6 && Math.abs(middle.d - 10) < 1e-6 && /doesn't follow the curve/.test(said),
      { under, expected: [Math.cos(a), Math.sin(a)].map((x) => +x.toFixed(3)), middle, name, said });
  }
  // Edit in the sketch: select face objects / paths, K → they're in the sketch on their plane (however moved or
  // rotated); Done replaces them (one undo step); Cancel keeps them; not on one plane → refused
  {
    const esc = async () => { for (let k = 0; k < 3 && app.tool; k++) await key("Escape"); };
    await esc(); app.doc.reset([]);
    const rect = app.doc.makeBody(K.makeRectFace(G, [300, 0, 0], 20, 10), "Rect", "face");
    const circ = app.doc.makeBody(K.makeCircleFace(G, [340, 0, 0], 5), "Circle", "face");
    const oval = app.doc.makeBody(K.scaleShape(K.makeCircleFace(G, [380, 0, 0], 5), [2, 1, 1], [380, 0, 0]), "Oval", "face"); // (a freeform curve)
    const L = K.rotateShape(K.sketchPath([{ kind: "line", a: [300, 20, 0], b: [320, 20, 0] }, { kind: "arc", a: [320, 20, 0], m: [325, 25, 0], b: [320, 30, 0] }]), -15, [300, 20, 0], [0, 0, 1]);
    const path = app.doc.makeBody(L, "Path", "path");
    const len = (w) => w.edges.reduce((s, e) => s + e.length, 0);
    app.doc.commit([rect, circ, oval, path], "faces + path");
    const n0 = app.doc.bodies.length;
    app.run("mode.body"); app.setSelection([rect, circ, oval, path].map((b) => ({ kind: "body", body: b.id, id: 0 })));
    await key("k"); await sleep(30);
    const t = app.tool;
    const loaded = t && t.name === "Sketch" ? { loops: t.loops.map((l) => l.kind === "circle" ? "circle" : l.segs.map((g) => g.kind).join("+")), opens: t.opens.map((o) => o.map((g) => g.kind).join("+")) } : null;
    document.querySelector("#sketch-panel button[data-act=done]")?.click(); await sleep(30);
    const made = app.doc.bodies, faces = made.filter((b) => b.kind === "face"), paths = made.filter((b) => b.kind === "path");
    const areas = faces.map(area).sort((a, b) => a - b);
    const want = [Math.PI * 25, 200, area(oval)].sort((a, b) => a - b); // (the oval: as the stretched circle was)
    const sameLen = paths.length === 1 && Math.abs(len(paths[0].shape) - len(L)) < 1e-6;
    const gone = [rect, circ, oval, path].every((b) => !app.doc.get(b.id));
    app.run("edit.undo"); await sleep(20);
    const back = [rect, circ, oval, path].every((b) => app.doc.get(b.id)) && app.doc.bodies.length === n0;
    expect("sketch: select 3 face objects + a path (turned −15°), K → in the sketch (rectangle, circle, freeform oval, line + arc); Done replaces them, same areas / length; one undo brings them back",
      loaded && JSON.stringify(loaded.loops.slice().sort()) === JSON.stringify(["circle", "line+line+line+line", "spline"].sort()) && JSON.stringify(loaded.opens) === JSON.stringify(["line+arc"]) &&
        faces.length === 3 && areas.every((a, i) => Math.abs(a - want[i]) < 1e-3) && sameLen && gone && back, { loaded, areas, want, ideal: Math.PI * 50, ovalEdge: oval.shape.edges.map((e) => e.geomType), sameLen, gone, back });
    // A path stood up (turned 90° about X): the sketch opens on its upright plane; Cancel keeps it
    await esc();
    const up = app.doc.makeBody(K.rotateShape(K.sketchPath([{ kind: "line", a: [0, 50, 0], b: [10, 50, 0] }, { kind: "line", a: [10, 50, 0], b: [10, 60, 0] }]), 90, [0, 50, 0], [1, 0, 0]), "Up", "path");
    app.doc.commit([...app.doc.bodies, up], "upright path");
    app.setSelection([{ kind: "body", body: up.id, id: 0 }]);
    await key("k"); await sleep(30);
    const upT = app.tool && app.tool.name === "Sketch" ? { opens: app.tool.opens.length, z: app.tool.frame.z.toArray().map((n) => +n.toFixed(6)) } : null;
    document.querySelector("#sketch-panel button[data-act=cancel]")?.click(); await sleep(30);
    expect("sketch: K on a stood-up path → its upright plane (normal along Y); Cancel keeps it", upT && upT.opens === 1 && Math.abs(Math.abs(upT.z[1]) - 1) < 1e-6 && !app.tool && !!app.doc.get(up.id), upT);
    // A ground face with the stood-up path: not on one plane → refused, no sketch
    app.setSelection([{ kind: "body", body: rect.id, id: 0 }, { kind: "body", body: up.id, id: 0 }]);
    await key("k"); await sleep(30);
    const toast = [...document.querySelectorAll(".toast")].map((x) => x.textContent).pop() ?? "";
    expect("sketch: a ground face + a stood-up path → refused (not on one plane)", !app.tool && /one flat plane/.test(toast), { tool: app.tool && app.tool.name, toast });
  }
  // Left open for the screenshot (cancelled afterwards), on a fresh model with just the box: a slot
  // drawn on the box top, a circle, a line on the way lined up with the slot's end (dashed guide)
  app.doc.reset([]);
  const box2 = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 40, 30, 20), "Box");
  app.doc.commit([box2], "box");
  // ...and a path beside it (an L with a bend), to see how paths look
  app.setSelection([]); app.run("tool.sketch"); await sleep(30);
  await key("l"); await click([30, -10, 0]); await click([45, -10, 0]); await key("a"); await click([50, -5, 0]); await key("l"); await click([50, 15, 0]); await key("Enter");
  document.querySelector("#sketch-panel button[data-act=done]").click(); await sleep(30);
  app.setSelection([{ kind: "face", body: box2.id, id: box2.shape.faces.find((f) => f.normalAt(f.center).toTuple()[2] > 0.99).hashCode }]);
  app.run("tool.sketch"); await sleep(30);
  for (const p of [[-15, -8], [5, -8]]) await click(at(...p));
  await key("a"); await click(at(5, 2)); await key("l"); await click(at(-15, 2)); await key("a"); await click(at(-15, -8));
  await key("c"); await click(at(12, 6)); await click(at(15, 6));
  await key("l"); await click(at(-12, 9)); await hover(at(5.2, 12)); // (lined up with the slot's right end: a dashed guide)
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("sketch scenario failed: " + JSON.stringify(failed));
  return [{ label: "sketch", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Mesh bodies (big or open STLs): import, pick, transform, guards, save/load, combined STL export. */
const SCENARIO_MESH = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport;
  const checks = [];
  const check = (label, ok, info) => checks.push({ label, ok: !!ok, info });
  const binary = (tris) => {
    const buf = new ArrayBuffer(84 + 50 * tris.length), dv = new DataView(buf);
    dv.setUint32(80, tris.length, true);
    tris.forEach((t, i) => t.forEach((v, j) => v.forEach((x, k) => dv.setFloat32(84 + 50 * i + 12 + 12 * j + 4 * k, x, true))));
    return new Uint8Array(buf);
  };
  const sphere = (N, M, R, c) => {
    const P = (i, j) => { const t = Math.PI * i / N, p = 2 * Math.PI * j / M; return [c[0] + R * Math.sin(t) * Math.cos(p), c[1] + R * Math.sin(t) * Math.sin(p), c[2] + R * Math.cos(t)]; };
    const tris = [];
    for (let i = 0; i < N; i++) for (let j = 0; j < M; j++) {
      const a = P(i, j), b = P(i + 1, j), cc = P(i + 1, j + 1), d = P(i, j + 1);
      if (i > 0) tris.push([a, b, d]);
      if (i < N - 1) tris.push([b, cc, d]);
    }
    return tris;
  };
  const near = (a, b, tol = 1e-3) => Math.abs(a - b) < tol;
  const errorsBefore = document.querySelectorAll(".toast.error").length;
  app.endInteractions();
  app.doc.reset();

  // A box solid to sit next to the mesh.
  const box = K.makeBox({ origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }, [-60, 0, 0], 20, 20, 20);
  app.doc.commit([app.doc.makeBody(box, "Box")], "box");

  // Big mesh (~57k triangles): imported as a mesh, fast.
  let t0 = performance.now();
  const [mid] = app.importStlData(binary(sphere(120, 240, 20, [0, 0, 20])), "Ball");
  const tImport = performance.now() - t0;
  let mb = app.doc.get(mid);
  check("big STL → one mesh body", mb && mb.kind === "mesh" && mb.shape.triangleCount === 240 * 238, { kind: mb && mb.kind, n: mb && mb.shape.triangleCount });
  vp.setView("iso"); vp.fit(); await sleep(100);
  check("import time < 3 s", tImport < 3000, Math.round(tImport) + " ms");

  // Picking: always the whole mesh, whatever the mode.
  const S = (p) => vp.toScreen(new (vp.camera.position.constructor)(p[0], p[1], p[2]));
  const s = S([0, 0, 20]);
  t0 = performance.now();
  const pf = vp.pick(s.x, s.y, "face"), pb = vp.pick(s.x, s.y, "body"), pe = vp.pick(s.x, s.y, "edge");
  const tPick = (performance.now() - t0) / 3;
  check("pick mesh in face mode → body", pf && pf.kind === "body" && pf.body === mid, pf);
  check("pick mesh in body mode", pb && pb.body === mid, pb);
  check("no edges on a mesh", !pe || pe.body !== mid, pe);
  check("pick time < 50 ms", tPick < 50, Math.round(tPick) + " ms");

  // Transforms (exact maths on the triangles).
  const bb = (m) => m.boundingBox.bounds;
  const moved = K.translateShape(mb.shape, [5, 0, 0]);
  check("translate", near(bb(moved)[0][0], bb(mb.shape)[0][0] + 5), bb(moved));
  const rot = K.rotateShape(mb.shape, 90, [0, 0, 0], [0, 0, 1]);
  check("rotate 90° about Z", near(bb(rot)[0][1], bb(mb.shape)[0][0], 1e-3) && near(bb(rot)[1][2], bb(mb.shape)[1][2]), bb(rot));
  const sc = K.scaleShape(mb.shape, [2, 1, 0.5], [0, 0, 0]);
  check("scale 200% X, 50% Z about the ground", near(bb(sc)[1][0], 40, 1e-2) && near(bb(sc)[1][2], 20, 1e-2) && near(bb(sc)[1][1], 20, 1e-2), bb(sc));
  app.doc.replaceShapes(new Map([[mid, moved]]), "Move");
  mb = app.doc.get(mid);
  check("move via document keeps it a mesh", mb.kind === "mesh" && near(bb(mb.shape)[0][0], -15, 1e-2), bb(mb.shape));

  // Editing commands refuse a mesh with a message (no exception, nothing changed).
  const before = app.doc.bodies.length, version = app.doc.version;
  app.setMode("body");
  app.setSelection([{ kind: "body", body: mid, id: 0 }]);
  app.run("op.pushpull");
  app.run("op.fillet");
  app.setSelection([{ kind: "body", body: 1, id: 0 }, { kind: "body", body: mid, id: 0 }]);
  app.run("bool.union");
  await sleep(50);
  check("push/pull, fillet, union on a mesh: refused, model unchanged", app.doc.bodies.length === before && app.doc.version === version, { n: app.doc.bodies.length });
  app.endInteractions(); app.setSelection([]);

  // Duplicate shares the (immutable) triangles.
  app.setSelection([{ kind: "body", body: mid, id: 0 }]);
  app.run("edit.duplicate"); await sleep(50);
  const copy = app.doc.bodies[app.doc.bodies.length - 1];
  check("duplicate a mesh", copy.kind === "mesh" && copy.id !== mid && copy.shape.triangleCount === mb.shape.triangleCount, copy.kind);
  app.endInteractions();
  app.doc.undo(); await sleep(50);

  // Small open mesh: falls back to a mesh too.
  const open = sphere(8, 16, 5, [40, 0, 5]).slice(3);
  const [oid] = app.importStlData(binary(open), "Open");
  check("small open STL → mesh", app.doc.get(oid)?.kind === "mesh", app.doc.get(oid)?.kind);
  // Small closed mesh: still an editable solid.
  const [cid] = app.importStlData(binary(sphere(8, 16, 5, [40, 30, 5])), "Closed");
  check("small closed STL → solid", app.doc.get(cid)?.kind === "solid", app.doc.get(cid)?.kind);
  const cb = app.doc.get(cid)?.shape.boundingBox.bounds;
  check("imported STL placed at the origin (X/Y centred, bottom on Z=0)", cb && near((cb[0][0] + cb[1][0]) / 2, 0, 1e-2) && near((cb[0][1] + cb[1][1]) / 2, 0, 1e-2) && near(cb[0][2], 0, 1e-2), cb);
  const ob = app.doc.get(oid)?.shape.boundingBox.bounds;
  check("imported mesh placed at the origin", ob && near((ob[0][0] + ob[1][0]) / 2, 0, 1e-2) && near(ob[0][2], 0, 1e-2), ob);

  // Save / load round trip.
  const text = app.modelText();
  app.loadModel(text, null); await sleep(50);
  const back = app.doc.bodies.filter((b) => b.kind === "mesh");
  check("save/load keeps meshes", back.length === 2 && back.some((b) => b.shape.triangleCount === 240 * 238 && near(bb(b.shape)[0][0], -15, 1e-2)), back.map((b) => b.shape.triangleCount));

  // One STL with the solids and the meshes (overlapping or not).
  const shapes = app.doc.bodies.map((b) => b.shape);
  const stl = new Uint8Array(await K.exportStl(shapes, { tolerance: 0.05, angle: 10 }));
  const all = K.parseStl(stl);
  const meshTris = back.reduce((n, b) => n + b.shape.triangleCount, 0);
  const solidOnly = K.parseStl(new Uint8Array(await K.exportStl(shapes.filter((g) => !("positions" in g)), { tolerance: 0.05, angle: 10 })));
  check("export STL = solids + meshes", all.triangleCount === solidOnly.triangleCount + meshTris && solidOnly.triangleCount > 0, { all: all.triangleCount, solid: solidOnly.triangleCount, mesh: meshTris });
  const ascii = new TextEncoder().encode("solid a\n facet normal 0 0 1\n  outer loop\n   vertex 0 0 0\n   vertex 1 0 0\n   vertex 0 1 0\n  endloop\n endfacet\nendsolid a\n");
  check("parse ASCII STL", K.parseStl(ascii).triangleCount === 1);

  // A real file (YDDD_SMOKE_STL), e.g. a 3D Benchy.
  if (window.__smokeStl) {
    t0 = performance.now();
    const ids = app.importStlData(window.__smokeStl, "Real");
    const t = performance.now() - t0;
    const rb = app.doc.get(ids[0]);
    vp.fit(); await sleep(200);
    const c = rb.shape.boundingBox.bounds, sp = S([(c[0][0] + c[1][0]) / 2, (c[0][1] + c[1][1]) / 2, (c[0][2] + c[1][2]) / 2]);
    t0 = performance.now(); vp.pick(sp.x, sp.y, "body"); const tp = performance.now() - t0;
    t0 = performance.now(); const txt = app.modelText(); const ts = performance.now() - t0;
    check("real STL: imported", rb && rb.kind === "mesh", { kind: rb && rb.kind, triangles: rb && rb.shape.triangleCount, importMs: Math.round(t), pickMs: Math.round(tp), saveMs: Math.round(ts), fileMB: +(txt.length / 1e6).toFixed(1) });
    window.__shotReal = true;
  }
  vp.setView("iso"); vp.fit(); await sleep(300);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("mesh scenario failed: " + JSON.stringify(failed));
  return [{ label: "mesh bodies", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/**
 * Camera navigation with real (OS-level) input — OrbitControls needs pointer capture, which synthetic
 * DOM events can't give: Alt + left drag orbits (no selection), a plain click still selects, the
 * wheel (also a touchpad's two-finger slide) zooms.
 */
async function navigationChecks(win: BrowserWindow): Promise<unknown> {
  const js = <T>(code: string) => win.webContents.executeJavaScript(code, true) as Promise<T>;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const checks: { label: string; ok: boolean; got: unknown }[] = [];
  const expect = (label: string, ok: boolean, got: unknown) => checks.push({ label, ok, got });
  const at = await js<{ x: number; y: number }>(`(async () => {
    const app = window.ydddApp, K = window.ydddKernel, vp = app.viewport;
    // Esc until no tool is left (Measure: the 1st Esc only clears its result)
    for (let k = 0; k < 3 && app.tool; k++) window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
    app.doc.dirty = false; app.doc.reset([]);
    const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    app.doc.commit([app.doc.makeBody(K.makeBox(G, [0, 0, 0], 40, 30, 20), "Box")], "box");
    app.run("mode.body"); app.setSelection([]); vp.setView("iso"); vp.fit();
    await new Promise((r) => setTimeout(r, 100));
    const s = vp.toScreen(new vp.camera.position.constructor(0, 0, 10));
    return { x: Math.round(s.x), y: Math.round(s.y) };
  })()`);
  const cam = () => js<{ p: number[]; d: number; sel: number }>(`(() => { const vp = window.ydddApp.viewport, c = vp.camera.position; return { p: c.toArray(), d: c.distanceTo(vp.controls.target), sel: window.ydddApp.selection.length }; })()`);
  const send = async (e: Parameters<typeof win.webContents.sendInputEvent>[0]) => {
    win.webContents.sendInputEvent(e);
    await sleep(30);
  };
  const before = await cam();
  await send({ type: "mouseMove", x: at.x, y: at.y });
  await send({ type: "mouseDown", x: at.x, y: at.y, button: "left", clickCount: 1, modifiers: ["alt"] });
  for (let k = 1; k <= 6; k++) await send({ type: "mouseMove", x: at.x + k * 15, y: at.y + k * 5, button: "left", modifiers: ["alt", "leftButtonDown"] } as never);
  await send({ type: "mouseUp", x: at.x + 90, y: at.y + 30, button: "left", clickCount: 1, modifiers: ["alt"] });
  const orbited = await cam();
  const moved = Math.hypot(...orbited.p.map((v, k) => v - before.p[k]));
  expect("navigation: Alt + left drag orbits the view and selects nothing", moved > 1 && Math.abs(orbited.d - before.d) < 1e-6 * before.d && orbited.sel === 0, { moved, before, orbited });
  await send({ type: "mouseDown", x: at.x, y: at.y, button: "left", modifiers: ["alt"], clickCount: 1 });
  await send({ type: "mouseUp", x: at.x, y: at.y, button: "left", modifiers: ["alt"], clickCount: 1 });
  const altClick = await cam();
  // (the orbit moved the box on screen: click where it is now)
  const now = await js<{ x: number; y: number }>(`(() => { const vp = window.ydddApp.viewport; const s = vp.toScreen(new vp.camera.position.constructor(0, 0, 10)); return { x: Math.round(s.x), y: Math.round(s.y) }; })()`);
  await send({ type: "mouseMove", x: now.x, y: now.y });
  await send({ type: "mouseDown", x: now.x, y: now.y, button: "left", clickCount: 1 });
  await send({ type: "mouseUp", x: now.x, y: now.y, button: "left", clickCount: 1 });
  const clicked = await cam();
  expect("navigation: Alt + click selects nothing; a plain click still selects", altClick.sel === 0 && clicked.sel === 1, { altClick: altClick.sel, clicked: clicked.sel });
  // Ctrl + left drag: no pan (Ctrl is snapping); Ctrl + middle drag pans
  const drag = async (button: "left" | "middle", mods: string[], x0: number, y0: number) => {
    await send({ type: "mouseMove", x: x0, y: y0 });
    await send({ type: "mouseDown", x: x0, y: y0, button, clickCount: 1, modifiers: mods } as never);
    for (let k = 1; k <= 6; k++) await send({ type: "mouseMove", x: x0 + k * 15, y: y0 + k * 5, button, modifiers: [...mods, button === "left" ? "leftButtonDown" : "middleButtonDown"] } as never);
    await send({ type: "mouseUp", x: x0 + 90, y: y0 + 30, button, clickCount: 1, modifiers: mods } as never);
  };
  const p0 = await cam();
  await drag("left", ["control"], now.x + 200, now.y - 150); // empty space
  const p1 = await cam();
  await drag("middle", ["control"], now.x + 200, now.y - 150);
  const p2 = await cam();
  const dist = (a: number[], b: number[]) => Math.hypot(...a.map((v, k) => v - b[k]));
  expect("navigation: Ctrl + left drag doesn't pan; Ctrl + middle drag pans", dist(p1.p, p0.p) < 1e-9 && dist(p2.p, p1.p) > 1 && Math.abs(p2.d - p1.d) < 1e-6 * p1.d, { leftMoved: dist(p1.p, p0.p), middleMoved: dist(p2.p, p1.p) });
  // Shift + middle drag pans (the target moves with it); a plain middle drag orbits (the target stays put)
  const tgt = () => js<number[]>(`window.ydddApp.viewport.controls.target.toArray()`);
  const t2 = await tgt();
  await drag("middle", ["shift"], now.x + 200, now.y - 150);
  const p3 = await cam(), t3 = await tgt();
  await drag("middle", [], now.x + 200, now.y - 150);
  const p4 = await cam(), t4 = await tgt();
  expect("navigation: Shift + middle drag pans; a plain middle drag orbits", dist(t3, t2) > 1 && Math.abs(p3.d - p2.d) < 1e-6 * p2.d && dist(p4.p, p3.p) > 1 && dist(t4, t3) < 1e-9, { panTarget: dist(t3, t2), orbitMoved: dist(p4.p, p3.p), orbitTarget: dist(t4, t3) });
  await send({ type: "mouseWheel", x: now.x, y: now.y, deltaX: 0, deltaY: 120 }); // (Electron: + = scroll up / away)
  await sleep(100);
  const zoomed = await cam();
  expect("navigation: the wheel / two-finger slide zooms in", zoomed.d < clicked.d * 0.99, { before: clicked.d, after: zoomed.d });
  // The right panel: drag its left edge to resize it (remembered); double-click → default width
  const side = () => js<{ w: number; saved: string | null; gx: number; gy: number; vw: number }>(`(() => { const s = document.getElementById("sidebar").getBoundingClientRect(), g = document.getElementById("sidebar-grip").getBoundingClientRect(); return { w: s.width, saved: localStorage.getItem("yddd.sidebarWidth"), gx: Math.round(g.left + g.width / 2), gy: Math.round(g.top + g.height / 2), vw: document.getElementById("viewport").getBoundingClientRect().width }; })()`);
  const s0 = await side();
  await send({ type: "mouseMove", x: s0.gx, y: s0.gy });
  await send({ type: "mouseDown", x: s0.gx, y: s0.gy, button: "left", clickCount: 1 });
  for (let k = 1; k <= 5; k++) await send({ type: "mouseMove", x: s0.gx - k * 20, y: s0.gy, button: "left", modifiers: ["leftButtonDown"] } as never);
  await send({ type: "mouseUp", x: s0.gx - 100, y: s0.gy, button: "left", clickCount: 1 });
  await sleep(100);
  const s1 = await side();
  const g1 = s1;
  await send({ type: "mouseDown", x: g1.gx, y: g1.gy, button: "left", clickCount: 1 });
  await send({ type: "mouseUp", x: g1.gx, y: g1.gy, button: "left", clickCount: 1 });
  await send({ type: "mouseDown", x: g1.gx, y: g1.gy, button: "left", clickCount: 2 });
  await send({ type: "mouseUp", x: g1.gx, y: g1.gy, button: "left", clickCount: 2 });
  await sleep(100);
  const s2 = await side();
  expect("right panel: drag its edge → 100 px wider (viewport narrower, remembered); double-click → default", Math.abs(s1.w - s0.w - 100) < 2 && s1.vw < s0.vw - 90 && Number(s1.saved) === s1.w && Math.abs(s2.w - s0.w) < 1 && s2.saved === null, { s0, s1, s2 });
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("navigation failed: " + JSON.stringify(failed));
  return [{ label: "navigation", passed: checks.length - failed.length, total: checks.length, checks }];
}

export async function runSmoke(win: BrowserWindow, outDir: string): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const errors: string[] = [];
  win.webContents.on("console-message", (details) => {
    const d = details as unknown as { level: string | number; message: string };
    if ((d.level === "error" || d.level === 3) && !d.message.includes("PointerCapture")) errors.push(d.message); // synthetic events have no real pointer
  });
  const shot = async (name: string) => {
    const img = await win.webContents.capturePage();
    await writeFile(path.join(outDir, name), img.toPNG());
  };
  let report: unknown[] = [];
  // YDDD_SMOKE_JITTER=1: a stray real mouse over the window (a move to a random spot every 50 ms) — the
  // scenarios must pass all the same (see the real-input filter below); stopped for navigationChecks.
  const jitter = process.env.YDDD_SMOKE_JITTER
    ? setInterval(() => {
        const [w, h] = win.getContentSize();
        win.webContents.sendInputEvent({ type: "mouseMove", x: Math.floor(Math.random() * w), y: Math.floor(Math.random() * h) });
      }, 50)
    : undefined;
  try {
    // window.__see(v): a world point on screen, for the scenarios' clicks / hovers. In orbit runs a point
    // hidden behind a solid first turns the view (round its centre) to the first iso corner — or the top
    // view — that shows it, and one behind the camera pans to it, all at the same zoom, so a check isn't
    // lost to a fixed point it can't see.
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 200 && !window.ydddApp; i++) await new Promise((r) => setTimeout(r, 100));
      const vp = window.ydddApp.viewport, orbit = ${!!process.env.YDDD_SMOKE_ORBIT};
      // (off screen is fine: the events go straight to the canvas and the tools follow the 3D ray —
      // and turning the view in the middle of a gesture, e.g. a box's height click, would break it)
      const seen = (v) => {
        vp.camera.updateMatrixWorld(); // (just moved: its matrices only follow on the next frame)
        const s = vp.toScreen(v);
        const hit = vp.faceUnder(s.x, s.y);
        if (!hit) return true;
        // (on the ground seen from below, any face behind it is seen through the grid — the tools take that)
        if (Math.abs(v.z) < 1e-9 && vp.camera.position.z < 0) return false;
        const cam = vp.camera.position, d = cam.distanceTo(v), tol = Math.max(0.05, d * 2e-3);
        return hit.point.distanceTo(v) < tol || cam.distanceTo(hit.point) >= d - tol;
      };
      // Behind the camera (its screen point would be mirrored) or far off screen.
      const outOfView = (v) => {
        vp.camera.updateMatrixWorld();
        const ndc = v.clone().project(vp.camera);
        return v.clone().applyMatrix4(vp.camera.matrixWorldInverse).z > -vp.camera.near || Math.abs(ndc.x) > 2 || Math.abs(ndc.y) > 2;
      };
      // (in orbit runs a sketch starts from a fitted view — its picks are a few px)
      if (orbit) {
        const run = window.ydddApp.run.bind(window.ydddApp);
        window.ydddApp.run = (cmd, ...rest) => { if (cmd === "tool.sketch") vp.fit(); return run(cmd, ...rest); };
      }
      // Look at v from the camera's direction d at the same distance — the same zoom (the scenarios' snap /
      // pick tolerances are a few px, so e.g. a radius 10 away must stay well apart from its centre).
      const lookAt = (v, d) => {
        const dist = vp.camera.position.distanceTo(vp.controls.target);
        vp.controls.target.copy(v);
        vp.camera.position.copy(v).add(d.clone().normalize().multiplyScalar(dist));
        vp.controls.update();
      };
      // The scenarios drive the app with synthetic DOM events only: real input (the user's mouse resting on
      // or crossing the window, or Chromium's own moves when the layout under a still cursor changes)
      // would land between a scenario's hover and its click and move the tool's cursor. Dropped until
      // navigationChecks, which uses real input.
      window.__realInput = false;
      for (const t of ["pointermove", "pointerdown", "pointerup", "pointerover", "pointerout", "pointerenter", "pointerleave", "pointercancel",
        "mousemove", "mousedown", "mouseup", "mouseover", "mouseout", "mouseenter", "mouseleave", "click", "dblclick", "contextmenu", "wheel"])
        window.addEventListener(t, (e) => { if (e.isTrusted && !window.__realInput) e.stopImmediatePropagation(); }, { capture: true, passive: false });
      window.__see = (v) => {
        // (behind the camera / far off screen: pan to it)
        if (orbit && !vp.viewLocked && outOfView(v)) lookAt(v, vp.camera.position.clone().sub(vp.controls.target));
        if (orbit && !vp.viewLocked && !seen(v)) {
          // (the four iso corners, then straight down: never edge-on to the ground — later clicks on it
          // would land anywhere)
          const pos = vp.camera.position.clone(), target = vp.controls.target.clone();
          const dirs = [[1, -1.2, 0.9], [-1, -1.2, 0.9], [-1, 1.2, 0.9], [1, 1.2, 0.9], [0, -1e-4, 1]];
          let found = false;
          // (framing the bodies at the point — what the check works on — not every body left from earlier
          // checks, spread far apart: that would zoom out so far a few px are many mm)
          const at = window.ydddApp.doc.bodies.filter((b) => {
            const [lo, hi] = b.shape.boundingBox.bounds, pad = 5 + 0.2 * Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
            return [0, 1, 2].every((k) => v.getComponent(k) >= lo[k] - pad && v.getComponent(k) <= hi[k] + pad);
          }).map((b) => b.id);
          for (const d of dirs) {
            if (!at.length) vp.fit([-1]); // (a bare point: the empty scene's framing, then centred on it)
            lookAt(v, new pos.constructor(...d));
            if (at.length) vp.fit(at);
            if (!outOfView(v) && seen(v)) { found = true; break; }
          }
          if (!found) { vp.camera.position.copy(pos); vp.controls.target.copy(target); vp.controls.update(); }
        }
        vp.camera.updateMatrixWorld();
        return vp.toScreen(v);
      };
      return 0;
    })()`, true);
    // YDDD_SMOKE_ORBIT="az,el[,all]": every iso view (with ",all": every view) and the starting camera
    // turned az° about Z and tilted el° — the same checks seen from other angles.
    if (process.env.YDDD_SMOKE_ORBIT) {
      const [az, el, all] = process.env.YDDD_SMOKE_ORBIT.split(",");
      await win.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 200 && !window.ydddApp; i++) await new Promise((r) => setTimeout(r, 100));
        const vp = window.ydddApp.viewport, az = ${Number(az) || 0} * Math.PI / 180, el = ${Number(el) || 0} * Math.PI / 180, all = ${all === "all"};
        const orbit = () => {
          const t = vp.controls.target, o = vp.camera.position.clone().sub(t), V = o.constructor;
          o.applyAxisAngle(new V(0, 0, 1), az);
          const right = new V(0, 0, 1).cross(o).normalize();
          if (right.lengthSq() > 0.5) {
            const tilted = o.clone().applyAxisAngle(right, -el);
            if (Math.abs(tilted.clone().normalize().z) < 0.995) o.copy(tilted);
          }
          vp.camera.position.copy(t).add(o);
          vp.controls.update();
        };
        const setView = vp.setView.bind(vp);
        vp.setView = (name) => { setView(name); if (all || name === "iso") orbit(); };
        orbit();
        return 0;
      })()`, true);
    }
    // The scenarios were written for snapping only while Ctrl is held: Auto snap off (not remembered).
    // SCENARIO_AUTOSNAP checks Auto snap itself.
    await win.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 200 && !window.ydddApp; i++) await new Promise((r) => setTimeout(r, 100)); window.ydddApp.setAutoSnap(false, false); return 0; })()`, true);
    // YDDD_SMOKE_HALF=1 (npm run smoke:half): skip scenarios 1–3 (the first half of the run's time) — the
    // later ones start from their own fresh model.
    if (process.env.YDDD_SMOKE_ONLY === "spline") {
      // (while working on it: just the sketch spline scenario)
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO_SPLINE, true));
      if (process.env.YDDD_SMOKE_EXP) {
        // (an experiment script: its result, a screenshot of where it left the app)
        console.log("SMOKE_EXP " + JSON.stringify(await win.webContents.executeJavaScript(await readFile(process.env.YDDD_SMOKE_EXP, "utf8"), true)));
        await shot("exp.png");
        app.exit(0);
        return;
      }
      // A screenshot: a closed and an open Spline in a sketch, the closed one selected (its points to drag)
      await win.webContents.executeJavaScript(`(async () => {
        const app = window.ydddApp, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const key = async (k, extra = {}) => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...extra })); await sleep(10); };
        const pe = (t, p) => { const sc = window.__see(new V(p[0], p[1], 0)); canvas.dispatchEvent(new PointerEvent(t, { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); };
        const click = async (p) => { pe("pointermove", p); pe("pointerdown", p); pe("pointerup", p); await sleep(450); };
        app.setSelection([]); await key("k", { code: "KeyK" }); await sleep(50);
        await key("A", { shiftKey: true, code: "KeyA" });
        for (const p of [[-30, -20], [-20, -8], [-8, -25], [5, -10], [18, -20]]) await click(p);
        await key("Enter");
        for (const p of [[0, 0], [15, 8], [8, 20], [-10, 18], [-12, 5], [0, 0]]) await click(p);
        await key("Escape"); await click([15, 8]); pe("pointermove", [8, 20]);
        await sleep(300); return 0;
      })()`, true);
      await shot("spline.png");
      console.log("SMOKE_REPORT " + JSON.stringify({ report, errors }, null, 1));
      app.exit(report.every((s) => (s as { passed: number; total: number }).passed === (s as { total: number }).total) ? 0 : 1);
      return;
    }
    if (process.env.YDDD_SMOKE_ONLY === "point") {
      // (while working on it: just the cone / pull-to-a-point scenarios)
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO_CONE, true));
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO_POINT, true));
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO_TIP, true));
      if (process.env.YDDD_SMOKE_EXP) console.log("SMOKE_EXP " + JSON.stringify(await win.webContents.executeJavaScript(await readFile(process.env.YDDD_SMOKE_EXP, "utf8"), true)));
      // Screenshots: a box's top face selected (its centre dot), then G on the dot (the pyramid preview, its panel)
      await win.webContents.executeJavaScript(`(async () => {
        const app = window.ydddApp, K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
        const box = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 40, 40, 20), "Box");
        app.doc.commit([box], "box"); app.viewport.setView("iso"); app.viewport.fit(); app.run("mode.face");
        const top = box.shape.faces.find((f) => f.geomType === "PLANE" && Math.abs(f.center.z - 20) < 1e-6);
        app.setSelection([{ kind: "face", body: box.id, id: top.hashCode }]);
        await new Promise((r) => setTimeout(r, 300)); return 0;
      })()`, true);
      await shot("point-dot.png");
      await win.webContents.executeJavaScript(`(async () => {
        const app = window.ydddApp; app.selDot = app.dots.findIndex((d) => d.face !== undefined); app.setSelection([]); app.run("xf.move");
        await new Promise((r) => setTimeout(r, 300)); return 0;
      })()`, true);
      await shot("point-pull.png");
      await win.webContents.executeJavaScript(`(async () => {
        const app = window.ydddApp, K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
        if (app.op) app.cancelOp();
        app.doc.reset([]);
        const cone = app.doc.makeBody(K.makeCone(G, [0, 0, 0], 15, 0, 40), "Cone"), sq = K.makeRectFace(G, [45, 0, 0], 30, 30);
        const pyr = app.doc.makeBody(K.pullToPoint(sq, sq.hashCode, 40), "Pyramid");
        app.doc.commit([cone, pyr], "tips"); app.run("mode.body"); app.viewport.setView("front"); app.viewport.fit();
        app.setSelection([{ kind: "body", body: cone.id, id: 0 }]);
        await new Promise((r) => setTimeout(r, 300)); return 0;
      })()`, true);
      await shot("tip-dot.png");
      await win.webContents.executeJavaScript(`(async () => {
        const app = window.ydddApp, K = window.ydddKernel;
        const out = app.doc.bodies.map((b) => { const t = K.solidTips(b.shape)[0]; return K.roundTip(b.shape, t, 4); });
        app.doc.replaceShapes(new Map(app.doc.bodies.map((b, i) => [b.id, out[i]])), "round");
        app.setSelection([]); app.viewport.setView("iso"); app.viewport.fit();
        await new Promise((r) => setTimeout(r, 300)); return 0;
      })()`, true);
      await shot("tip-round.png");
      console.log("SMOKE_REPORT " + JSON.stringify({ report, errors }, null, 1));
      app.exit(report.every((s) => (s as { passed: number; total: number }).passed === (s as { total: number }).total) ? 0 : 1);
      return;
    }
    if (process.env.YDDD_SMOKE_ONLY === "holes") {
      // (while working on it: just this scenario)
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO_HOLES, true));
      // A screenshot of the dialog and its ring on a plate's hole
      await win.webContents.executeJavaScript(`(async () => {
        const app = window.ydddApp, K = window.ydddKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
        const plate = app.doc.makeBody(K.booleanOp("subtract", K.makeBox(G, [0, 0, 0], 60, 40, 10), [K.makeCylinder(G, [0, 0, -1], 8, 12)]), "Plate");
        app.doc.commit([plate], "plate"); app.viewport.setView("iso"); app.viewport.fit(); await new Promise((r) => setTimeout(r, 100));
        const e = app.doc.get(plate.id).shape.edges.find((e) => e.geomType === "CIRCLE" && Math.abs(e.pointAt(0).z - 10) < 1e-6);
        app.run("mode.edge"); app.setSelection([{ kind: "edge", body: plate.id, id: e.hashCode }]); app.run("xf.scale");
        await new Promise((r) => setTimeout(r, 300)); return 0;
      })()`, true);
      await shot("holes-resize.png");
      console.log("SMOKE_REPORT " + JSON.stringify({ report, errors }, null, 1));
      app.exit(report.every((s) => (s as { passed: number; total: number }).passed === (s as { total: number }).total) ? 0 : 1);
      return;
    }
    if (process.env.YDDD_SMOKE_HALF) {
      await win.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 200 && !window.ydddApp; i++) await new Promise((r) => setTimeout(r, 100)); window.ydddApp.doc.reset([]); return 0; })()`, true);
    } else {
      // Scenarios 1–3 check an op's result straight after app.applyOp(): with the background kernel ready,
      // Fillet / Chamfer / Shell / heavy booleans apply only when its job is back. They run on this thread
      // (as before the worker starts); the background path has its own checks ("background kernel: …", in SCENARIO_TEXT).
      await win.webContents.executeJavaScript(`(async () => { const k = window.ydddApp.bgKernel; for (let i = 0; i < 300 && !k.ready; i++) await new Promise((r) => setTimeout(r, 50)); k.ready = false; return 0; })()`, true);
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO, true));
      await shot("1-fillet-preview.png");
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO_2, true));
      await shot("2-final.png");
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO_3, true));
      await shot("3-complex.png");
      await win.webContents.executeJavaScript(`window.ydddApp.bgKernel.ready = true; 0`, true);
    }
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_STL, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_STEP, true));
    if (process.env.YDDD_SMOKE_STL) {
      const b64 = (await readFile(process.env.YDDD_SMOKE_STL)).toString("base64");
      await win.webContents.executeJavaScript(`window.__smokeStl = Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0)); 0`, true);
    }
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_MESH, true));
    await shot("4-mesh.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_BIRD, true));
    await shot("5-birdhouse.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_HOUSE, true));
    await shot("5b-house.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_PLANTER, true));
    await shot("5c-planter.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_CABLE, true));
    await shot("6-cablebox.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_MEASURE, true));
    await shot("7-measure.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_ARRAY, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_TEXT, true));
    await win.webContents.executeJavaScript(`window.__smokeDir = ${JSON.stringify(outDir)}; 0`, true);
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_GROUPS, true));
    await shot("7c-groups.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_SNAPMARK, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_AUTOSNAP, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_CUTAXIS, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_HOLES, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_TOOLPANEL, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_KEEPTOOL, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_RECENTSTRIP, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_RECENT, true));
    {
      // The File menu shows the list (built in the main process).
      const sub = Menu.getApplicationMenu()?.items.find((i) => i.label === "&File")?.submenu?.items.find((i) => i.label === "Open Recent")?.submenu?.items ?? [];
      const labels = sub.map((i) => i.label);
      const ok = labels[0]?.startsWith("recent-a.yddd") && labels[1]?.startsWith("recent-b.yddd") && labels.includes("Clear Recent") && !labels.some((l) => l.startsWith("recent-gone"));
      if (!ok) console.error("recent menu failed: " + JSON.stringify(labels));
      report.push({ label: "open recent menu", passed: ok ? 1 : 0, total: 1, checks: [{ label: "File → Open Recent lists the files, newest first, + Clear Recent", ok, got: labels }] });
      if (!ok) errors.push("recent menu failed");
    }
    {
      // Edit → Clear All Guides: the menu item runs the command (all guide lines gone, one undo step).
      const mi = Menu.getApplicationMenu()?.items.find((i) => i.label === "&Edit")?.submenu?.items.find((i) => i.label === "Clear All Guides");
      await win.webContents.executeJavaScript(`(() => { const a = window.ydddApp; a.doc.reset([]); a.doc.setGuides([{ a: [0, 0, 0], b: [10, 0, 0] }, { a: [0, 0, 0], b: [0, 10, 0] }], "guides"); return 0; })()`, true);
      mi?.click();
      await new Promise((r) => setTimeout(r, 100));
      const left: [number, number] = await win.webContents.executeJavaScript(`(() => { const a = window.ydddApp, n = a.doc.guides.length; a.run("edit.undo"); const back = a.doc.guides.length; a.doc.reset([]); return [n, back]; })()`, true);
      const ok = !!mi && left[0] === 0 && left[1] === 2;
      if (!ok) errors.push("clear guides menu failed: " + JSON.stringify({ found: !!mi, left }));
      const clr = Menu.getApplicationMenu()?.items.find((i) => i.label === "&View")?.submenu?.items.find((i) => i.label === "Clear Recent Tools");
      if (!clr) errors.push("View → Clear Recent Tools missing");
      report.push({ label: "clear guides menu", passed: ok ? 1 : 0, total: 1, checks: [{ label: "Edit → Clear All Guides removes every guide line; Undo brings them back", ok, got: { found: !!mi, left } }] });
    }
    {
      // File → Settings…: the Radius | Diameter switch; with Diameter, Cylinder / Sphere / Circle take (and show) the diameter.
      const mi = Menu.getApplicationMenu()?.items.find((i) => i.label === "&File")?.submenu?.items.find((i) => i.label === "Settings…");
      mi?.click();
      await new Promise((r) => setTimeout(r, 100));
      const got = await win.webContents.executeJavaScript(`(async () => {
        const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
        const app = window.ydddApp, vp = app.viewport, V = vp.camera.position.constructor;
        const ev = (type, p) => { const s = vp.toScreen(new V(...p)); vp.canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true })); };
        const key = (k, code) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
        const field = () => document.querySelector("#props-dlg label span")?.textContent;
        const dialog = (vals) => { const d = document.getElementById("props-dlg"); const q = [...d.querySelectorAll("input")]; vals.forEach((v, i) => (q[i].value = String(v))); d.requestSubmit(); };
        const size = (b) => { const [a, c] = b.shape.boundingBox.bounds; return [0, 1, 2].map((k) => Math.round((c[k] - a[k]) * 1000) / 1000); };
        const was = localStorage.getItem("yddd.circleSize");
        app.doc.reset([]); app.run("mode.body"); app.run("view.top"); vp.fit(); await sleep(30);
        const dlg = document.getElementById("props-dlg");
        const seg = dlg ? [...dlg.querySelectorAll(".seg button")] : [];
        const startR = seg.length === 2 && seg[0].classList.contains("primary") && !seg[1].classList.contains("primary");
        seg[1]?.click();
        const switched = seg[1]?.classList.contains("primary") && !seg[0].classList.contains("primary") && localStorage.getItem("yddd.circleSize") === "d";
        dlg?.requestSubmit(); await sleep(20);
        const out = { found: !!dlg, startR, switched, closed: !document.getElementById("props-dlg") };
        const make = async (cmd, vals) => {
          app.run(cmd); ev("pointermove", [0, 0, 0]); key("Tab", "Tab"); await sleep(20);
          const label = field(); dialog(vals); await sleep(50);
          const b = app.doc.bodies[app.doc.bodies.length - 1];
          key("Escape", "Escape"); await sleep(10);
          return { label, size: b && size(b) };
        };
        out.cylD = await make("tool.cylinder", [20, 10]);
        out.sphD = await make("tool.sphere", [20]);
        out.cirD = await make("tool.circle", [20]);
        localStorage.setItem("yddd.circleSize", "r");
        out.cylR = await make("tool.cylinder", [20, 10]);
        if (was === null) localStorage.removeItem("yddd.circleSize"); else localStorage.setItem("yddd.circleSize", was);
        app.doc.reset([]);
        return out;
      })()`, true);
      const ok = !!mi && got.found && got.startR && got.switched && got.closed
        && got.cylD.label === "Diameter" && got.cylD.size?.join() === "20,20,10"
        && got.sphD.label === "Diameter" && got.sphD.size?.join() === "20,20,20"
        && got.cirD.label === "Diameter" && got.cirD.size?.slice(0, 2).join() === "20,20"
        && got.cylR.label === "Radius" && got.cylR.size?.join() === "40,40,10";
      if (!ok) errors.push("settings circle size failed: " + JSON.stringify({ found: !!mi, got }));
      report.push({ label: "settings: radius / diameter", passed: ok ? 1 : 0, total: 1, checks: [{ label: "File → Settings… Radius | Diameter switch (Radius by default); Diameter: Cylinder / Sphere / Circle Tab dialogs ask for the diameter (20 → 20 across); Radius: 20 → 40 across", ok, got }] });
    }
    await shot("7b-array.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_PRINT, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_CONE, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_POINT, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_TIP, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_SPLINE, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_SKETCH, true));
    await shot("8-sketch.png");
    await win.webContents.executeJavaScript(`document.querySelector("#sketch-panel button[data-act=cancel]")?.click(); 0`, true);
    clearInterval(jitter);
    await win.webContents.executeJavaScript("window.__realInput = true; 0", true);
    report = report.concat(await navigationChecks(win));
  } catch (e) {
    errors.push(`scenario failed: ${String(e)}`);
    await shot("error.png").catch(() => {});
  }
  console.log("SMOKE_REPORT " + JSON.stringify({ report, errors }, null, 1));
  app.exit(errors.length ? 1 : 0);
}
