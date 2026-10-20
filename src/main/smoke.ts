/**
 * Opt-in end-to-end smoke test. Run with:  Y3D_SMOKE=/tmp/y3d-smoke npx electron .
 * (npm run smoke; npm run smoke:half skips scenarios 1–3 — see Y3D_SMOKE_HALF.)
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
  const app = window.y3dApp;
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
  const app = window.y3dApp;
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

  // 13b) Move edge on a solid with a curved part elsewhere (box + cylinder): only the faces round the edge must be flat
  try {
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    // Make ring: only the band between the top's outline and the offset outline (a face with one hole)
    const check = (k, on) => { const cb = document.querySelector("#op-panel input[data-key=" + k + "]"); cb.checked = on; cb.dispatchEvent(new Event("change", { bubbles: true })); };
    for (const [d, want] of [[5, [50, 40, 0]], [-5, [40, 30, 0]]]) {
      app.setSelection([{ kind: "face", body: ob, id: topOf(ob).hashCode }]);
      app.run("op.offset"); opValue("d", d); check("round", false); check("ring", true);
      app.applyOp();
      const f = last().shape, holes = f.faces.length === 1 ? f.faces[0].clone().innerWires().length : -1;
      expect("15 offset ring " + d, last().id !== ob && eq(size(last().id), want) && holes === 1 && window.y3dKernel.isValidShape(f), [size(last().id), holes]);
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const K = window.y3dKernel, G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
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
    const hudFirst = app.hudEl.textContent; // (X or Y — whichever runs across the screen)
    key("x", "KeyX");
    plain("pointermove", [15, 0, 20]);
    const hudX = app.hudEl.textContent;
    key("y", "KeyY");
    plain("pointermove", [0, 15, 20]);
    const hudY = app.hudEl.textContent;
    plain("pointerdown", [0, 15, 20]);
    const zg = app.doc.guides[app.doc.guides.length - 1];
    const zOk = /^[XY] = -?[\d.]+$/.test(hudFirst) && hudX === "X = 15" && hudY === "Y = 15" && !!zg && r(zg.a[0]) === 0 && r(zg.a[1]) === 15 && r(zg.b[1]) === 15 && zg.a[2] < -100 && zg.b[2] > 100;
    expect("40c guide from Z: the label names its direction; X key → X = 15, Y key → Y = 15", zOk, { hudFirst, hudX, hudY, guide: zg && { a: zg.a.map(r), b: zg.b.map(r) } });
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
/** Help → House: every step valid, then one hollow L-shaped house with valleys, chimney, door and window. */
const SCENARIO_HOUSE = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.y3dApp, K = window.y3dKernel;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const toasts = () => [...document.querySelectorAll("#toasts .toast.error")].map((t) => t.textContent);
  const press = async (act) => { document.querySelector("#tutorial button[data-act=" + act + "]").click(); await sleep(60); };
  app.doc.dirty = false;
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove()); // (older ones would expire mid-way and upset the count)
  app.run("help.house"); await sleep(30);
  const panel = document.getElementById("tutorial");
  const titles = [...panel.querySelectorAll("li b:first-child")].map((b) => b.textContent);
  const total = titles.length;
  expect("house: panel opens with the steps", !panel.hidden && panel.querySelector("h2").textContent === "House" && total === 12, titles);
  const before = toasts().length, vols = {};
  for (let i = 0; i < total; i++) {
    if (titles[i] === "Push the wing back") {
      // By hand, as the step says: Shift+G on the wing, press the top of its back gable, drag (then Ctrl + Shift) onto the main ridge
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
      expect("house: Shift+G from the wing's back gable top, Ctrl + Shift onto the main ridge → exactly 35 back", tool === "Move from point" && [wb[0].map(r), wb[1].map(r)].join() === "-80,-95,0,-10,0,65", { tool, lo: wb[0].map(r), hi: wb[1].map(r) });
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
  const app = window.y3dApp, K = window.y3dKernel;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const toasts = () => [...document.querySelectorAll("#toasts .toast.error")].map((t) => t.textContent);
  const press = async (act) => { document.querySelector("#tutorial button[data-act=" + act + "]").click(); await sleep(60); };
  app.doc.dirty = false;
  document.querySelectorAll("#toasts .toast").forEach((t) => t.remove()); // (older ones would expire mid-way and upset the count)
  app.run("help.planter"); await sleep(30);
  const panel = document.getElementById("tutorial");
  const titles = [...panel.querySelectorAll("li b:first-child")].map((b) => b.textContent);
  const total = titles.length;
  expect("planter: panel opens with the steps", !panel.hidden && panel.querySelector("h2").textContent === "Planter" && total === 7, titles);
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
    const v = vols, ok = Math.abs(v["Taper the right"] - frustum) < 1e-3 && faces["Taper the right"] === 6 && Math.abs(v["Hollow it"] - shelled) < 1e-2 && Math.abs(v["Hollow it"] - v["Drainage hole"] - hole) < 1e-2;
    expect("planter: 300 top, 220 bottom, 450 high; frustum, hollow (30 walls, open top), 30 mm hole through the floor",
      [lo.map(r), hi.map(r)].join() === "-150,-150,0,150,150,450" && ok,
      { lo: lo.map(r), hi: hi.map(r), tapered: v["Taper the right"], frustum, faces: faces["Taper the right"], hollow: v["Hollow it"], shelled, hole: v["Hollow it"] - v["Drainage hole"], wantHole: hole });
  }
  const failed = checks.filter((c) => !c.ok);
  if (failed.length) console.error("planter scenario failed: " + JSON.stringify(failed));
  return checks;
})()
`;

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
  const app = window.y3dApp, K = window.y3dKernel, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
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
  expect("cable: panel opens with the steps", !panel.hidden && panel.querySelector("h2").textContent === "Cable storage box" && total === 6, total);
  const before = toasts().length;
  for (let i = 0; i < total; i++) {
    if (i === 1) {
      const dir = () => vp.camera.position.clone().sub(vp.controls.target).normalize(), o = dir(), pos = vp.camera.position.clone();
      vp.setView("iso"); const iso = dir(); vp.camera.position.copy(pos); vp.controls.update();
      expect("cable: Start turns the view to the start-up iso view", o.dot(iso) > 0.9999, { o: o.toArray(), iso: iso.toArray() });
    }
    if (i === 3) {
      // "First divider" by hand: Box tool, Ctrl-click the back-left inner floor corner, a little inside, Tab 4 × 112 × 56
      vp.fit(); await sleep(50);
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

/** Measure (=): hovering a corner, an edge, faces and a circle shows their sizes in the HUD. */
const SCENARIO_MEASURE = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.y3dApp, K = window.y3dKernel, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
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
  const hover = async (p) => { const sc = window.__see(new V(p[0], p[1], p[2])); canvas.dispatchEvent(new PointerEvent("pointermove", { clientX: sc.x, clientY: sc.y, button: 0, bubbles: true })); await sleep(20); return app.hudEl.hidden ? null : app.hudEl.textContent; };
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
  document.querySelector("#measure-panel button[data-act=cancel]").click(); await sleep(20);
  expect("measure: Cancel exits the tool", !app.tool && !document.getElementById("measure-panel"), app.tool && app.tool.name);
  app.run("tool.measure"); await sleep(20);
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
  await sleep(20);
  expect("measure: Esc ends it and hides the HUD", !app.tool && app.hudEl.hidden, { tool: app.tool && app.tool.name, hud: app.hudEl.hidden });
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "+", code: "Equal", shiftKey: true, bubbles: true, cancelable: true }));
  await sleep(20);
  expect("measure: + (Shift+=) is still Union, not Measure", !app.tool, app.tool && app.tool.name);
  const failed = checks.filter((c) => !c.ok);
  // Tab over an edge → dimension: Esc cancels, click places it; text = length; select + Del, undo, save/load
  const key = async (k, code) => { window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code, bubbles: true, cancelable: true })); await sleep(20); };
  const labels = () => [...document.querySelectorAll("#dim-labels .dim-label:not(.preview)")].map((l) => l.textContent);
  app.run("tool.measure"); await sleep(20);
  await hover([5, -15, 20]); await key("Tab", "Tab"); await hover([5, -15, 32]);
  const preview = document.querySelector("#dim-labels .dim-label.preview")?.textContent;
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
  if (!lab) expect("dimension: label present before selecting", false, { html: document.getElementById("dim-labels")?.outerHTML, dims: app.doc.dimensions.length, tool: app.tool && app.tool.name });
  lab?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 })); await sleep(20);
  const selected = document.querySelector("#dim-labels .dim-label.sel") !== null;
  await key("Delete", "Delete");
  expect("dimension: click its text selects it, Del removes it", selected && app.doc.dimensions.length === 0 && labels().length === 0, { selected, dims: app.doc.dimensions.length });
  app.doc.dirty = false; app.loadModel(saved, null); await sleep(50);
  expect("dimension: saved in the .y3d file", app.doc.dimensions.length === 1 && labels().join() === "40", app.doc.dimensions);
  // Linked to the edge: push/pull the box's +X end → 50; move the box → the dimension moves with it; undo → back
  {
    const boxB = app.doc.bodies.find((b) => b.name === "Box 1");
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

/** Sketch (K): on a face and on the ground — lines, tangent arcs, a hole, typed sizes, undo, Done / Cancel. */
const SCENARIO_SKETCH = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.y3dApp, K = window.y3dKernel, vp = app.viewport, V = vp.camera.position.constructor, canvas = vp.canvas;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  // Beginner layout (a Pro layout left on in the test profile would change the panel / hints)
  localStorage.removeItem("y3d.pro"); document.body.classList.remove("pro");
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
  app.doc.replaceShapes(new Map([[pb.id, K.translateShape(pb.shape, [0, 0, 5])]]), "Move"); await sleep(20);
  const moved = Math.abs(app.doc.get(pb.id).shape.boundingBox.bounds[0][2] - 5) < 1e-6;
  app.loadModel(app.modelText(), null); await sleep(20);
  const reread = app.doc.bodies.find((b) => b.kind === "path" && b.shape.edges.length === 2);
  expect("sketch: open lines → a path object (line + arc): picked by its line, Push/Pull refuses it, moves, saved as a path", pb && pb.kind === "path" && kinds === "LINE,CIRCLE" && picked && ppRefused && moved && !!reread, { kind: pb && pb.kind, kinds, picked, ppRefused, moved, reloaded: !!reread });
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
  // Tab (Y3D's exact values): a capsule drawn only with Tab dialogs; a rectangle; then the selection moved + scaled
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
    const back = !document.body.classList.contains("pro") && localStorage.getItem("y3d.pro") === "0";
    expect("pro layout: Ctrl+Shift+F1 → compact sketch panel, short hints, text-only Recent; Ctrl+Shift+P back", fullTip && pro && compact && /Enter: done/.test(sketchHint) && shortHint === "Solid mode: click to select" && noIcons && back, { fullTip, pro, compact, sketchHint, shortHint, noIcons, back });
    // The Pro tip comes once, with the 20th save
    localStorage.setItem("y3d.saves", "18"); localStorage.removeItem("y3d.proTip");
    const tips = () => [...document.querySelectorAll("#toasts .toast")].filter((t) => /Pro layout/.test(t.textContent)).length;
    const t0 = tips(); app.noteSaved(); const t19 = tips(); app.noteSaved(); const t20 = tips(); app.noteSaved(); const t21 = tips();
    expect("pro layout: a one-time tip with the 20th save", t19 === t0 && t20 === t0 + 1 && t21 === t20 && localStorage.getItem("y3d.proTip") === "1", { t0, t19, t20, t21 });
    for (const k of ["y3d.saves", "y3d.proTip", "y3d.pro"]) localStorage.removeItem(k);
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
    const app = window.y3dApp, K = window.y3dKernel, vp = app.viewport;
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
  const cam = () => js<{ p: number[]; d: number; sel: number }>(`(() => { const vp = window.y3dApp.viewport, c = vp.camera.position; return { p: c.toArray(), d: c.distanceTo(vp.controls.target), sel: window.y3dApp.selection.length }; })()`);
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
  const now = await js<{ x: number; y: number }>(`(() => { const vp = window.y3dApp.viewport; const s = vp.toScreen(new vp.camera.position.constructor(0, 0, 10)); return { x: Math.round(s.x), y: Math.round(s.y) }; })()`);
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
  await send({ type: "mouseWheel", x: now.x, y: now.y, deltaX: 0, deltaY: 120 }); // (Electron: + = scroll up / away)
  await sleep(100);
  const zoomed = await cam();
  expect("navigation: the wheel / two-finger slide zooms in", zoomed.d < clicked.d * 0.99, { before: clicked.d, after: zoomed.d });
  // The right panel: drag its left edge to resize it (remembered); double-click → default width
  const side = () => js<{ w: number; saved: string | null; gx: number; gy: number; vw: number }>(`(() => { const s = document.getElementById("sidebar").getBoundingClientRect(), g = document.getElementById("sidebar-grip").getBoundingClientRect(); return { w: s.width, saved: localStorage.getItem("y3d.sidebarWidth"), gx: Math.round(g.left + g.width / 2), gy: Math.round(g.top + g.height / 2), vw: document.getElementById("viewport").getBoundingClientRect().width }; })()`);
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
  try {
    // window.__see(v): a world point on screen, for the scenarios' clicks / hovers. In orbit runs a point
    // hidden behind a solid first turns the view (round its centre) to the first iso corner — or the top
    // view — that shows it, and one behind the camera pans to it, all at the same zoom, so a check isn't
    // lost to a fixed point it can't see.
    await win.webContents.executeJavaScript(`(async () => {
      for (let i = 0; i < 200 && !window.y3dApp; i++) await new Promise((r) => setTimeout(r, 100));
      const vp = window.y3dApp.viewport, orbit = ${!!process.env.Y3D_SMOKE_ORBIT};
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
        const run = window.y3dApp.run.bind(window.y3dApp);
        window.y3dApp.run = (cmd, ...rest) => { if (cmd === "tool.sketch") vp.fit(); return run(cmd, ...rest); };
      }
      // Look at v from the camera's direction d at the same distance — the same zoom (the scenarios' snap /
      // pick tolerances are a few px, so e.g. a radius 10 away must stay well apart from its centre).
      const lookAt = (v, d) => {
        const dist = vp.camera.position.distanceTo(vp.controls.target);
        vp.controls.target.copy(v);
        vp.camera.position.copy(v).add(d.clone().normalize().multiplyScalar(dist));
        vp.controls.update();
      };
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
          const at = window.y3dApp.doc.bodies.filter((b) => {
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
    // Y3D_SMOKE_ORBIT="az,el[,all]": every iso view (with ",all": every view) and the starting camera
    // turned az° about Z and tilted el° — the same checks seen from other angles.
    if (process.env.Y3D_SMOKE_ORBIT) {
      const [az, el, all] = process.env.Y3D_SMOKE_ORBIT.split(",");
      await win.webContents.executeJavaScript(`(async () => {
        for (let i = 0; i < 200 && !window.y3dApp; i++) await new Promise((r) => setTimeout(r, 100));
        const vp = window.y3dApp.viewport, az = ${Number(az) || 0} * Math.PI / 180, el = ${Number(el) || 0} * Math.PI / 180, all = ${all === "all"};
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
    // Y3D_SMOKE_HALF=1 (npm run smoke:half): skip scenarios 1–3 (the first half of the run's time) — the
    // later ones start from their own fresh model.
    if (process.env.Y3D_SMOKE_HALF) {
      await win.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 200 && !window.y3dApp; i++) await new Promise((r) => setTimeout(r, 100)); window.y3dApp.doc.reset([]); return 0; })()`, true);
    } else {
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO, true));
      await shot("1-fillet-preview.png");
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO_2, true));
      await shot("2-final.png");
      report = report.concat(await win.webContents.executeJavaScript(SCENARIO_3, true));
      await shot("3-complex.png");
    }
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
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_HOUSE, true));
    await shot("5b-house.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_PLANTER, true));
    await shot("5c-planter.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_CABLE, true));
    await shot("6-cablebox.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_MEASURE, true));
    await shot("7-measure.png");
    report = report.concat(await win.webContents.executeJavaScript(SCENARIO_SKETCH, true));
    await shot("8-sketch.png");
    await win.webContents.executeJavaScript(`document.querySelector("#sketch-panel button[data-act=cancel]")?.click(); 0`, true);
    report = report.concat(await navigationChecks(win));
  } catch (e) {
    errors.push(`scenario failed: ${String(e)}`);
    await shot("error.png").catch(() => {});
  }
  console.log("SMOKE_REPORT " + JSON.stringify({ report, errors }, null, 1));
  app.exit(errors.length ? 1 : 0);
}
