/**
 * Opt-in benchmarks, not loaded during normal use. Each prints a report and quits.
 * - Snapping:  N=2000 npm run bench — loads the stress scene, times object-snap queries and draw-tool pointer moves.
 * - Modelling: npm run bench:ops — times kernel operations (boolean, fillet / chamfer / shell, stretch, array)
 *   and meshing their results for display; YDDD_BENCH_FILE=model.yddd also times opening that model.
 */
import type { BrowserWindow } from "electron";
import { app } from "electron";
import * as path from "node:path";

const SCENARIO = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 600 && !(window.ydddApp && window.ydddApp.doc.bodies.length); i++) await sleep(100);
  const app = window.ydddApp;
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


/** Modelling operations, timed in the kernel (median of a few runs, after a warm-up). */
const OPS = String.raw`
(async () => {
  for (let i = 0; i < 600 && !(window.ydddApp && window.ydddKernel); i++) await new Promise((r) => setTimeout(r, 100));
  const app = window.ydddApp, K = window.ydddKernel;
  if (!app || !K) throw new Error("app did not start");
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  const rows = [];
  const tris = (sh) => { try { return K.tessellate(sh).faces.triangles.length / 3; } catch { return null; } };
  /** Time fn (runs times, the median); note whether the result is a valid solid and its triangle count. */
  const bench = (group, name, fn, runs = 5, check = true) => {
    const ms = []; let res, err = null;
    for (let i = 0; i < runs; i++) {
      const t = performance.now();
      try { res = fn(); } catch (e) { err = String(e && e.message || e); break; }
      ms.push(performance.now() - t);
    }
    ms.sort((a, b) => a - b);
    const row = { group, name, ms: ms.length ? +ms[Math.floor(ms.length / 2)].toFixed(1) : null, runs: ms.length };
    if (err) row.error = err;
    else if (check && res && !Array.isArray(res)) { row.valid = K.isValidShape(res); row.tris = tris(res); }
    rows.push(row);
    return err ? null : res;
  };
  const grid = (n, step, make) => { const out = []; for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push(make((i - (n - 1) / 2) * step, (j - (n - 1) / 2) * step)); return out; };
  const box = K.makeBox(G, [0, 0, 0], 40, 30, 20); // (centred on X / Y, from z 0 up)
  const cyl = K.makeCylinder(G, [0, 0, -5], 8, 30);
  const sphere = K.makeSphereAt([20, 15, 20], 12);
  K.booleanOp("subtract", K.makeBox(G, [0, 0, 0], 10, 10, 10), [K.makeCylinder(G, [0, 0, -1], 2, 12)]); // warm-up

  // Boolean
  const holed = bench("boolean", "box − cylinder", () => K.booleanOp("subtract", box, [cyl]));
  bench("boolean", "box ∪ sphere", () => K.booleanOp("union", box, [sphere]));
  bench("boolean", "cylinder ∩ sphere", () => K.booleanOp("intersect", K.makeCylinder(G, [0, 0, 0], 10, 20), [K.makeSphereAt([0, 0, 10], 12)]));
  const plate = K.makeBox(G, [0, 0, 0], 200, 200, 5);
  const holes100 = grid(10, 18, (x, y) => K.makeCylinder(G, [x, y, -1], 3, 7));
  const plate100 = bench("boolean", "plate − 100 holes (one subtract)", () => K.booleanOp("subtract", plate, holes100), 3);
  const row20 = Array.from({ length: 20 }, (_, i) => K.makeCylinder(G, [i * 6, 0, 0], 4, 10));
  bench("boolean", "union of 20 overlapping cylinders", () => K.booleanOp("union", row20[0], row20.slice(1)), 3);

  // Fillet / chamfer / shell
  const rounded = bench("fillet", "box: all 12 edges, r 2", () => K.filletEdges(box, null, 2));
  if (holed) bench("fillet", "box − cylinder: all edges, r 1", () => K.filletEdges(holed, null, 1));
  const plate25 = K.booleanOp("subtract", K.makeBox(G, [0, 0, 0], 100, 100, 5), grid(5, 18, (x, y) => K.makeCylinder(G, [x, y, -1], 3, 7)));
  bench("fillet", "plate − 25 holes: all edges, r 0.5", () => K.filletEdges(plate25, null, 0.5), 3);
  bench("fillet", "box: chamfer all edges, 2", () => K.chamferEdges(box, null, 2));
  const top = box.faces.reduce((a, f) => (f.center.z > a.center.z ? f : a));
  bench("fillet", "box: shell, top open, 2 thick", () => K.shellSolid(box, new Set([top.hashCode]), 2));

  // Stretch (per-axis scale: curved faces become free-form surfaces)
  const half = K.booleanOp("subtract", K.makeSphereAt([0, 0, 0], 36.5), [K.makeBox(G, [0, 0, -100], 200, 200, 100)]);
  const dome = bench("stretch", "dome (half sphere) 60% wide", () => K.scaleShape(half, [0.6, 1, 1], [0, 0, 0]));
  const oval = bench("stretch", "cylinder 150% on X", () => K.scaleShape(K.makeCylinder(G, [0, 0, 0], 10, 20), [1.5, 1, 1], [0, 0, 0]));
  if (holed) bench("stretch", "box − cylinder 120 / 80 / 150%", () => K.scaleShape(holed, [1.2, 0.8, 1.5], [0, 0, 0]));
  if (dome) bench("stretch", "then: stretched dome − box (a slot)", () => K.booleanOp("subtract", dome, [K.makeBox(G, [0, 0, 20], 60, 6, 40)]), 3);
  if (oval) bench("stretch", "then: stretched cylinder, fillet r 1", () => K.filletEdges(oval, null, 1), 3);

  // Array copy (translated copies; subtracting a whole array is "plate − 100 holes" above)
  if (rounded) bench("array", "50 copies of a rounded box (row)", () => Array.from({ length: 50 }, (_, i) => K.translateShape(rounded, [i * 45, 0, 0])), 5, false);
  bench("array", "10 × 10 grid of cylinders", () => grid(10, 25, (x, y) => K.translateShape(cyl, [x, y, 0])), 5, false);
  const copies = rounded ? Array.from({ length: 50 }, (_, i) => K.translateShape(rounded, [i * 45, 0, 0])) : [];
  if (copies.length) bench("array", "mesh 50 copies from scratch (the app reuses one)", () => copies.map((c) => K.tessellate(c)), 3, false);

  // Meshing results for display (what each result costs to show)
  if (plate100) bench("display", "mesh: plate − 100 holes", () => K.tessellate(plate100), 3, false);
  if (dome) bench("display", "mesh: stretched dome", () => K.tessellate(dome), 3, false);
  if (rounded) bench("display", "mesh: rounded box", () => K.tessellate(rounded), 5, false);

  // A real model (YDDD_BENCH_FILE)
  const file = window.__benchFile;
  if (file) {
    const text = await window.yddd.readFile(file);
    if (!text) rows.push({ group: "file", name: file, error: "could not read" });
    else {
      bench("file", "open " + file.split("/").pop() + " (parse only; meshed when drawn)", () => app.loadModel(text, null), 3, false);
      const solids = app.doc.bodies.filter((b) => b.kind === "solid");
      bench("file", "re-mesh its " + solids.length + " solids", () => solids.map((b) => K.tessellate(b.shape)), 3, false);
      // F on its first solid: the fillet preview (all edges, the default radius) — kernel, meshing, and the whole key press
      if (solids.length) {
        const s0 = solids[0], r = app.defaults.fillet;
        const f = bench("fillet", "F on " + s0.name + " (" + s0.shape.faces.length + " faces, " + s0.shape.edges.length + " edges): fillet all, r " + r + " (kernel)", () => K.filletEdges(s0.shape, null, r), 1, false);
        if (f) bench("fillet", "  mesh the result", () => K.tessellate(f), 1, false);
        app.setSelection([{ kind: "body", body: s0.id, id: 0 }]);
        const t = performance.now();
        app.run("op.fillet");
        rows.push({ group: "fillet", name: "  key F → the panel on screen (blocked this long first)", ms: +(performance.now() - t).toFixed(1) });
        while (app.op && !app.op.result) await new Promise((r) => setTimeout(r, 5));
        rows.push({ group: "fillet", name: "  … and the preview shown", ms: +(performance.now() - t).toFixed(1) });
        app.cancelOp();
      }
      if (solids.length >= 2) bench("file", "its first solid − the next one", () => K.booleanOp("subtract", solids[0].shape, [solids[1].shape]), 3);
      // Linked copies: fillet one object of its first array / circular copy (every copy follows), then draw
      const rec = app.doc.arrays.find((r) => app.doc.get(r.sources[0])?.kind === "solid");
      if (rec) {
        const one = app.doc.get(rec.sources[0]), n = rec.sources.length + rec.copies.length;
        let filleted = null, rad = 0;
        for (const x of [1, 0.5, 0.2]) { try { filleted = K.filletEdges(one.shape, null, x); rad = x; break; } catch (e) {} }
        if (!filleted) rows.push({ group: "linked", name: "fillet " + one.name, error: "fillet failed" });
        else {
          bench("linked", "fillet " + one.name + " (kernel only)", () => K.filletEdges(one.shape, null, rad), 1, false);
          const prev = app.doc.bodies, next = prev.map((b) => (b.id === one.id ? { ...b, shape: filleted } : b));
          bench("linked", "arrayToChange (is it still as made?)", () => app.arrayToChange([...rec.sources, ...rec.copies]), 1, false);
          bench("linked", "a turned copy's bounding box (slow: why arrays check corner points)", () => K.rotateShape(filleted, 30, [0, 0, 0], [0, 0, 1]).boundingBox.bounds, 5, false);
          bench("linked", "mesh the filleted one", () => K.tessellate(filleted), 3, false);
          bench("linked", "linkCopies (no drawing)", () => app.linkCopies(prev, next, app.doc.arrays, "Fillet"), 1, false);
          const t = performance.now();
          app.doc.replaceShapes(new Map([[one.id, filleted]]), "Fillet");
          rows.push({ group: "linked", name: "follow + draw: " + n + " in " + rec.group, ms: +(performance.now() - t).toFixed(1) });
          app.doc.undo();
        }
      }
      // Subtract a whole group from the first solid outside it (select it, −, click the group in the Bodies panel)
      const grp = rec?.group ?? app.doc.bodies.find((b) => b.group)?.group;
      if (grp) {
        const target = app.doc.bodies.find((b) => b.kind === "solid" && b.group !== grp);
        if (target) {
          const tools = app.doc.bodies.filter((b) => b.group === grp);
          const cut = bench("subtract", target.name + " − " + tools.length + " in " + grp + " (kernel)", () => K.booleanOp("subtract", target.shape, tools.map((b) => b.shape)), 1, false);
          if (cut) {
            bench("subtract", "  its faces / valid", () => [cut.faces.length, K.isValidShape(cut)], 1, false);
            bench("subtract", "  mesh the result", () => K.tessellate(cut), 1, false);
          }
          const t = performance.now();
          app.applyBoolean("subtract", target.id, tools.map((b) => b.id), "Subtract");
          rows.push({ group: "subtract", name: "  whole step in the app (with drawing)", ms: +(performance.now() - t).toFixed(1) });
          // (a slow one runs behind the busy dialog, after the next paint: timed until it closes)
          const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
          const step = async (cmd, name) => {
            const t = performance.now(); app.run(cmd);
            const busy = !!document.getElementById("busy");
            while (document.getElementById("busy")) await sleep(5);
            rows.push({ group: "subtract", name: name + (busy ? " — busy dialog" : ""), ms: +(performance.now() - t).toFixed(1) });
          };
          await step("edit.undo", "  then Undo (" + tools.length + " back on screen)");
          await step("edit.redo", "  then Redo");
          await step("edit.undo", "  Undo again");
        }
        // Cut the whole group by the first guide (select it, C, click the guide)
        if (app.doc.guides.length) {
          const ids = app.doc.bodies.filter((b) => b.group === grp && b.kind === "solid").map((b) => b.id);
          bench("cut", "hover the guide: its cut plane (" + ids.length + " solids)", () => app.cutPlane(0, ids), 3, false);
          bench("cut", "hover the guide: draw the plane square", () => app.showCutPlane(app.cutPlane(0, ids), ids), 3, false);
          const { point, normal } = app.cutPlane(0, ids);
          const one = app.doc.get(ids[0]);
          bench("cut", "cut " + one.name + " by the guide (kernel)", () => K.splitByPlane(one.shape, point, normal), 1, false);
          const t = performance.now();
          app.opCut(ids, 0);
          while (document.getElementById("busy")) await new Promise((r) => setTimeout(r, 5));
          rows.push({ group: "cut", name: "  cut all " + ids.length + " in " + grp + " (with drawing)", ms: +(performance.now() - t).toFixed(1) });
          const pieces = app.doc.bodies.filter((b) => b.group === grp);
          const vol = (b) => K.solidVolume(b.shape);
          rows.push({ group: "cut", name: "  " + pieces.length + " pieces, all valid: " + pieces.every((b) => K.isValidShape(b.shape)) + ", last copy's volume / first's: " + (vol(app.doc.get(ids[ids.length - 1])) / vol(app.doc.get(ids[0]))).toFixed(6), ms: 0 });
          app.doc.undo();
        }
      }
    }
  }
  return { rows };
})()
`;

export async function runBench(win: BrowserWindow): Promise<void> {
  try {
    if (process.env.YDDD_BENCH === "ops") {
      const file = process.env.YDDD_BENCH_FILE ? path.resolve(process.env.YDDD_BENCH_FILE) : "";
      await win.webContents.executeJavaScript(`window.__benchFile = ${JSON.stringify(file)}; 0`, true);
      const res = await win.webContents.executeJavaScript(OPS, true);
      for (const r of res.rows) {
        const ok = r.valid === undefined ? "" : r.valid ? "  valid" : "  INVALID";
        console.log(`${r.group.padEnd(8)} ${r.name.padEnd(42)} ${r.error ? "ERROR " + r.error : `${String(r.ms).padStart(8)} ms${ok}${r.tris == null ? "" : `  ${r.tris} tris`}`}`);
      }
    } else {
      const res = await win.webContents.executeJavaScript(SCENARIO, true);
      console.log(JSON.stringify(res, null, 1));
    }
  } catch (e) {
    console.log(JSON.stringify({ error: String(e) }));
  }
  app.exit(0);
}
