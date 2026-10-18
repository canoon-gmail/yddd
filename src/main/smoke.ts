/**
 * Opt-in end-to-end smoke test. Run with:  Y3D_SMOKE=/tmp/y3d-smoke npx electron .
 * Drives the real UI with synthetic pointer events, captures screenshots and
 * prints a JSON report, then quits. Not loaded during normal use.
 */
import type { BrowserWindow } from "electron";
import { app } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
  const app = window.y3dApp;
  const vp = app.viewport;
  const V = vp.camera.position.constructor;
  const canvas = vp.canvas;
  const S = (p) => vp.toScreen(new V(p[0], p[1], p[2]));
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

  // 10) Shift+G: click a mark → move gizmo appears at that mark; dragging keeps the pivot on the body
  {
    const id = app.doc.bodies[0].id;
    app.setSelection([{ kind: "body", body: id, id: 0 }]);
    vp.fit(); await sleep(50);
    key("G", "KeyG", { shiftKey: true });
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
    const valid = window.y3dKernel.isValidShape;
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
    const valid = window.y3dKernel.isValidShape;
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

  // 14) Divide face (L): split the top face between the two long-edge midpoints, then G lifts the ridge → gable roof
  try {
    const valid = window.y3dKernel.isValidShape;
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
    expect("14 divide face splits the top face, new edge selected in Edge mode", sh().faces.length === 7 && valid(sh()) && app.mode === "edge" && app.selection.length === 1 && sel.kind === "edge", [sh().faces.length, valid(sh()), app.mode, app.selection]);
    const e = sel && sh().edges.find((x) => x.hashCode === sel.id);
    const r3 = (p) => [p.x, p.y, p.z].map((n) => +n.toFixed(6));
    expect("14 new edge runs exactly between the midpoints", e && eq([r3(e.startPoint), r3(e.endPoint)].sort(), [[420, 0, 20], [420, 30, 20]].sort()), e && [r3(e.startPoint), r3(e.endPoint)]);
    app.run("xf.move");
    key("Tab", "Tab");
    dialog([0, 0, 10]);
    key("Enter", "Enter");
    expect("14 G lifts the ridge: gable house (7 faces, 30 tall)", valid(sh()) && eq(size(bx), [40, 30, 30]) && sh().faces.length === 7, [valid(sh()), size(bx), sh().faces.length]);
    // 14b) Divide face on a flat rectangle face: refused with an error toast, face unchanged, tool stays
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
    expect("14 divide face threw", false, String(e && e.stack || e));
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
      expect("15 round offset " + d, last().id !== ob && eq(size(last().id), want) && arcs === 4 && window.y3dKernel.isValidShape(f), [size(last().id), arcs]);
    }
    app.run("mode.body");
  } catch (e) {
    expect("15 round offset threw", false, String(e && e.stack || e));
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
    expect("16 inner walls pushed: clean corner", inner.length === 2 && window.y3dKernel.isValidShape(sh) && sh.faces.length === 11 && eq(size(tray), [50, 50, 20]), [inner.length, sh.faces.length, size(tray)]);
    // Two adjacent outside walls pulled 5 → no notch
    sh = pp(tray, faceBy(tray, (n, c) => n[0] < -0.99 && Math.abs(c[0] - b0[0][0]) < 1e-3 || n[1] < -0.99 && Math.abs(c[1] - b0[0][1]) < 1e-3), 5);
    expect("16 outer walls pulled: no notch", window.y3dKernel.isValidShape(sh) && sh.faces.length === 11 && eq(size(tray), [55, 55, 20]), [sh.faces.length, size(tray)]);
    // Top + two sides of a plain box pulled 5 → corner block filled too
    const blk = mkBox([200, -300, 0], [40, 40, 30]);
    sh = pp(blk, faceBy(blk, (n) => n[2] > 0.99 || n[0] > 0.99 || n[1] > 0.99), 5);
    expect("16 three faces pulled: plain box", window.y3dKernel.isValidShape(sh) && sh.faces.length === 6 && eq(size(blk), [45, 45, 35]), [sh.faces.length, size(blk)]);
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
      expect("17 fillet + walls push/pull " + d, sel.length === 3 && window.y3dKernel.isValidShape(sh) && sh.faces.length === 7 && cyl.length === 1 && eq(size(fb), want) && rad === rr, [sel.length, sh.faces.length, cyl.length, size(fb), rad]);
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
    const o = S(c); const sp = vp.snapPoint(o.x + 3, o.y + 2);
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
        app.opCut([bid], app.doc.guides.length - 1);
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
    app.setSelection([{ kind: "body", body: sid, id: 0 }]); app.run("view.front"); app.run("view.fitSelection"); app.setSelection([]); await sleep(50);
    const at = (type, x, y) => canvas.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
    const guideFromCentre = (dx, dy) => {
      const o = S(c);
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
      shapes.every((sh) => window.y3dKernel.isValidShape(sh)) && eq([0, 1, 2].map((k) => r(hi[k] - lo[k])), [r(3 * R), r(2 * R), r(1.4 * R)]) && worst < 1e-9,
      [shapes.map((sh) => window.y3dKernel.isValidShape(sh)), [0, 1, 2].map((k) => r(hi[k] - lo[k])), worst]);
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
    const srcValid = window.y3dKernel.isValidShape(src);
    opValue("d", 3); app.applyOp();
    const out = app.doc.get(bid).shape;
    expect("24 stretched fillet push/pull: fast preview, source intact, valid result", fillet && slowest < 150 && srcValid && window.y3dKernel.isValidShape(out) && out !== src,
      { slowestPreviewMs: Math.round(slowest), srcValid, outValid: window.y3dKernel.isValidShape(out) });
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
    expect("25 tray: Edges = Vertical rounds exactly the 8 corners (4 outside, 4 inside)", hasList && window.y3dKernel.isValidShape(sh) && cyl(tray) === 8 && sh.faces.length === facesBefore + 8, [hasList, cyl(tray), facesBefore, sh.faces.length]);
    // Plain box: Horizontal rounds the 8 top / bottom edges, not the 4 vertical ones
    const bx = mk([30, 20, 10]);
    app.setSelection([{ kind: "body", body: bx, id: 0 }]);
    app.run("op.fillet"); choose("which", 2); opValue("r", 2); app.applyOp();
    expect("25 box: Edges = Horizontal rounds the 8 top / bottom edges", window.y3dKernel.isValidShape(app.doc.get(bx).shape) && cyl(bx) === 8, cyl(bx));
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
      firstMs > 60 && slowest < 40 && deformed >= 5 && Math.abs(ghostGrow[1] - dragged) < 0.01 && Math.abs(ghostGrow[0]) < 0.01 && Math.abs(ghostGrow[2]) < 0.01 && realShown && dragged >= 5 && window.y3dKernel.isValidShape(sh) && Math.abs((b2[1][1] - b2[0][1]) - (hi[1] - lo[1] + dragged)) < 1e-6,
      { firstPreviewMs: Math.round(firstMs), slowestDragStepMs: Math.round(slowest), deformed, ghostGrow, realShown, dragged, valid: window.y3dKernel.isValidShape(sh), dy: +(b2[1][1] - b2[0][1] - (hi[1] - lo[1])).toFixed(4) });
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
    expect("27 circle face stretched: valid ellipse face of the right size", face.kind === "face" && window.y3dKernel.isValidShape(face.shape) && r(fb[0] - fa[0]) === r(3 * R) && r(fb[1] - fa[1]) === r(2 * R) && worst < 1e-9,
      { kind: face.kind, size: [r(fb[0] - fa[0]), r(fb[1] - fa[1])], worst });
    app.setSelection([{ kind: "body", body: cid, id: 0 }]); app.run("op.pushpull"); opValue("d", -10); app.applyOp();
    const solid = last();
    const sb = solid.shape.boundingBox.bounds;
    expect("27 then push/pull → elliptical solid", solid.kind === "solid" && window.y3dKernel.isValidShape(solid.shape) && r(sb[1][2] - sb[0][2]) === 10, { kind: solid.kind, h: r(sb[1][2] - sb[0][2]) });
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
      types.includes("EXTRUSION_SURFACE") && !app.op && out !== sol.shape && window.y3dKernel.isValidShape(out) &&
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
    const K = window.y3dKernel, sh = app.doc.get(bid).shape;
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
    const K = window.y3dKernel;
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
    const K = window.y3dKernel, tilted = K.rotateShape(ell, 37, [3, 4, 5], [1, 1, 0]);
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const out = app.doc.get(sid).shape, K = window.y3dKernel;
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const bar = app.doc.makeBody(K.makeBox(G, [0, 500, 0], 40, 10, 10), "Bar"), blk = app.doc.makeBody(K.makeBox(G, [5, 500, -5], 4, 20, 30), "Block");
    app.doc.commit([...app.doc.bodies, bar, blk], "bar + block");
    const n0 = app.doc.bodies.length;
    app.setSelection([{ kind: "body", body: bar.id, id: 0 }, { kind: "body", body: blk.id, id: 0 }]);
    app.run("bool.subtract");
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
      nCut === n0 + 2 && sel.length === 2 && sel.every((b) => b.kind === "face" && window.y3dKernel.isValidShape(b.shape)) &&
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const b = app.doc.makeBody(K.makeBox(G, [0, 700, 0], 12, 8, 6), "Recover me");
    app.doc.commit([...app.doc.bodies, b], "box");
    await app.autosave();
    const rec = await window.y3d.readRecovery();
    const parsed = rec ? JSON.parse(rec.data) : null;
    const saved = parsed?.bodies.find((x) => x.name === b.name);
    const back = saved ? K.deserialize(saved.brep) : null;
    const same = !!back && K.isValidShape(back) && back.faces.length === 6 && parsed.bodies.length === app.doc.bodies.length;
    const fresh = !!rec && Date.now() - rec.savedAt < 60000;
    app.dropRecovery();
    await new Promise((res) => setTimeout(res, 100));
    const gone = (await window.y3d.readRecovery()) === null;
    expect("38 autosave writes the model to the recovery file; dropped when safe", same && fresh && gone,
      { written: !!rec, bodies: parsed?.bodies.length, docBodies: app.doc.bodies.length, same, fresh, droppedAfterSave: gone });
    app.setSelection([{ kind: "body", body: b.id, id: 0 }]); app.run("edit.delete");
  } catch (e) {
    expect("38 autosave threw", false, String(e && e.stack || e));
  }

  // 40) Guide parallel to a world axis: Shift+L, click the X axis (top view), move 25 to +Y,
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
    const hudX = app.hudEl.textContent;
    key("y", "KeyY");
    plain("pointermove", [0, 15, 20]);
    const hudY = app.hudEl.textContent;
    plain("pointerdown", [0, 15, 20]);
    const zg = app.doc.guides[app.doc.guides.length - 1];
    const zOk = hudX === "X = 15" && hudY === "Y = 15" && !!zg && r(zg.a[0]) === 0 && r(zg.a[1]) === 15 && r(zg.b[1]) === 15 && zg.a[2] < -100 && zg.b[2] > 100;
    expect("40c guide from Z: label X = 15, Y key → moves along Y (Y = 15)", zOk, { hudX, hudY, guide: zg && { a: zg.a.map(r), b: zg.b.map(r) } });
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    const bx = app.doc.makeBody(K.makeBox(G, [0, 0, 0], 12, 12, 8), "Small");
    app.doc.commit([...app.doc.bodies, bx], "box");
    const g0 = app.doc.guides.length;
    app.doc.setGuides([...app.doc.guides, { a: [-500, 7.17, 0], b: [500, 7.17, 0], n: [0, 1, 0] }], "guide");
    vp.setView("iso"); vp.fit([bx.id]); await sleep(30);
    const rect = vp.canvas.getBoundingClientRect(), A = new V(-500, 7.17, 0), B = new V(500, 7.17, 0);
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
    localStorage.removeItem("y3d.stlQuality");
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
    const saved = JSON.parse(localStorage.getItem("y3d.stlQuality") || "null");
    expect("39 STL quality dialog: Normal default, Draft fewer triangles, edit → Custom, values returned + remembered",
      normal.checked && normal.tri > 0 && draft.tol === "0.1" && draft.tri > 0 && draft.tri < normal.tri && custom && q && q.tolerance === 0.05 && q.angle === 15 && saved && saved.tolerance === 0.05 && !document.getElementById("props-dlg"),
      { normal, draft, custom, q, saved });
    localStorage.removeItem("y3d.stlQuality");
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
  const app = window.y3dApp, K = window.y3dKernel;
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
  const K = window.y3dKernel;
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
const SCENARIO_BIRD = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.y3dApp, K = window.y3dKernel;
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
      const at = () => { const sc = vp.toScreen(new V(20, 20, 15)); return vp.pick(sc.x, sc.y, "face"); };
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
  const app = window.y3dApp, K = window.y3dKernel, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const r = (n) => +n.toFixed(3);
  const toasts = () => [...document.querySelectorAll("#toasts .toast.error")].map((t) => t.textContent);
  const press = async (act) => { document.querySelector("#tutorial button[data-act=" + act + "]").click(); await sleep(60); };
  const ev = (type, p) => { const s = vp.toScreen(new V(p[0], p[1], p[2])); canvas.dispatchEvent(new PointerEvent(type, { clientX: s.x, clientY: s.y, button: 0, bubbles: true, ctrlKey: true })); };
  const key = (k, code) => window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true }));
  const dialog = (vals) => { const d = document.getElementById("props-dlg"); if (!d) return false; const q = [...d.querySelectorAll("input")]; vals.forEach((v, i) => { if (q[i]) q[i].value = String(v); }); d.requestSubmit(); return true; };
  app.doc.dirty = false;
  app.run("help.cablebox"); await sleep(30);
  const panel = document.getElementById("tutorial");
  const total = panel.querySelectorAll("li").length;
  expect("cable: panel opens with the steps", !panel.hidden && panel.querySelector("h2").textContent === "Cable storage box" && total === 6, total);
  const before = toasts().length;
  for (let i = 0; i < total; i++) {
    if (i === 3) {
      // "First divider" by hand: Box tool, Ctrl-click the back-left inner floor corner, a little inside, Tab 4 × 112 × 56
      app.run("view.iso"); vp.fit(); await sleep(50);
      const n0 = app.doc.bodies.length;
      app.run("tool.box");
      ev("pointermove", [-116, 56, 4]); ev("pointerdown", [-116, 56, 4]);
      ev("pointermove", [-100, 40, 4]);
      key("Tab", "Tab"); await sleep(30);
      const ok = dialog([4, 112, 56]); await sleep(30);
      const made = app.doc.bodies.length === n0 + 1 ? app.doc.bodies[n0] : null;
      const bb = made && made.shape.boundingBox.bounds;
      expect("cable: first divider drawn as the step says sits in the back-left inner corner", ok && bb && [bb[0].map(r), bb[1].map(r)].join() === "-116,-56,4,-112,56,60", bb && [bb[0].map(r), bb[1].map(r)]);
      if (made) app.run("edit.undo");
      key("Escape", "Escape");
    }
    await press("do");
    const bad = app.doc.bodies.filter((b) => !K.isValidShape(b.shape)).map((b) => b.name);
    if (bad.length || toasts().length > before) { expect("cable: step " + (i + 1) + " valid", false, { bad, errors: toasts() }); break; }
  }
  expect("cable: all steps done, no errors", panel.querySelectorAll("li.done").length === total && toasts().length === before, { done: panel.querySelectorAll("li.done").length, errors: toasts() });
  const box = app.doc.bodies.length === 1 ? app.doc.bodies[0] : null;
  if (box) {
    const bb = box.shape.boundingBox.bounds;
    const outer = 240 * 120 * 60 - 4 * (1 - Math.PI / 4) * 64 * 60, hollow = 232 * 112 * 56, divs = 3 * 4 * 112 * 56;
    const vol = K.solidVolume(box.shape), want = outer - hollow + divs;
    expect("cable: one part, 240 × 120 × 60, rounded outside, hollow with 3 dividers", box.name === "Cable box" && [bb[0].map(r), bb[1].map(r)].join() === "-120,-60,0,120,60,60" && Math.abs(vol - want) < 1 && box.shape.faces.filter((f) => f.geomType === "CYLINDRE").length === 4,
      { name: box.name, bb, vol: r(vol), want: r(want) });
  } else expect("cable: one part", false, app.doc.bodies.map((b) => b.name));
  await press("back");
  expect("cable: Back undoes the join (box + 3 dividers)", app.doc.bodies.length === 4, app.doc.bodies.map((b) => b.name));
  app.run("view.iso"); await press("do"); await sleep(300);
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("cable scenario failed: " + JSON.stringify(failed));
  return [{ label: "cable box walkthrough", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;

/** Mesh bodies (big or open STLs): import, pick, transform, guards, save/load, combined STL export. */
const SCENARIO_MESH = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.y3dApp, K = window.y3dKernel, vp = app.viewport;
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

  // A real file (Y3D_SMOKE_STL), e.g. a 3D Benchy.
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
  try {
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO, true));
    await shot("1-fillet-preview.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_2, true));
    await shot("2-final.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_3, true));
    await shot("3-complex.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_STL, true));
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_STEP, true));
    if (process.env.Y3D_SMOKE_STL) {
      const b64 = (await readFile(process.env.Y3D_SMOKE_STL)).toString("base64");
      await win.webContents.executeJavaScript(`window.__smokeStl = Uint8Array.from(atob("${b64}"), (c) => c.charCodeAt(0)); 0`, true);
    }
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_MESH, true));
    await shot("4-mesh.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_BIRD, true));
    await shot("5-birdhouse.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_CABLE, true));
    await shot("6-cablebox.png");
  } catch (e) {
    errors.push(`scenario failed: ${String(e)}`);
    await shot("error.png").catch(() => {});
  }
  console.log("SMOKE_REPORT " + JSON.stringify({ report, errors }, null, 1));
  app.exit(errors.length ? 1 : 0);
}
