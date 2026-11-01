# Parked: Curve (a pushed solid round a cylinder)

Taken out on 2026-11-01 — **Curve face** (Modify → Curve face) does the job better: it wraps the *flat* faces (a scanned
logo before Push/Pull) round a cup's side at their true widths, in well under a second, then pushes them out and joins them.
This is the older tool, kept here in case it's wanted again (e.g. for a relief that's already pushed).

## What it did

Select one solid that is a **flat relief** (a scanned logo pushed up from its plate: flat layers, straight sides) →
Modify → Curve → **Radius** (a cup's) and **Round** (the longer / shorter side) → Apply. The largest flat face is the back:
it goes on the cylinder; each layer (between the heights of its flat faces) is as thick round it as it was; the back's middle
stays put. Then move it onto the cup (Shift+G) and Union by hand.

- **Projected, not wrapped:** the outline is projected onto the cylinder, so near the sides it comes out narrower
  (a 42 mm logo on r 40: ~13 % at its ends).
- Refused: no flat face; wider than the cylinder (radius must be more than half its width); anything with a slope or a
  rounding (a dome, a chamfer, a fillet) — it would have been left out silently.
- Time: the user's 83 × 42 mm lettered plaque (212 faces) on r 45 — 8.6 s at first, **4.8 s** after: each layer's prisms
  made from the solid's own flat tops (no cutting into layers), one `common` per layer with all its prisms, the layers
  glued (`booleanOnce(…, "shift")`), one validity check. Most of what's left is OpenCascade intersecting the B-spline walls
  with the two cylinders. It ran in the background kernel behind the busy dialog (Stop / Esc).

## To put it back

1. `src/renderer/kernel.ts`: the function below (after `solidPieces`). It uses `booleanOnce`, `booleanOp`, `extrudeFace`,
   `translateShape`, `makeCylinder`, `solidPieces`, `measureArea`, `normalAtUV`, `isValidShape`.
2. `src/renderer/kernel.worker.ts`: import `curveSolid`; job `{ op: "curve"; brep: string; radius: number; aroundShort: boolean }`,
   result `({ op: "curve" } & JobSolid)`, and in `run`:
   `case "curve": return { op: "curve", ...made(curveSolid(solidOf(job.brep), job.radius, job.aroundShort)) };`
3. `src/renderer/main.ts`: import `curveSolid`; `defaults`: `curveRadius: 40, curveShort: false`; in the command switch
   `case "op.curve": return this.opCurve();`; the method below; optionally `curveSolid` in the `ydddKernel` test list.
4. `src/renderer/keymap.ts` (Modify group): `["op.curve", "Curve: a flat relief (a scanned logo) round a cup"],`
5. `src/renderer/toolbar.ts` (Modify drawer): `{ cmd: "op.curve", icon: "curve", label: "Curve" },`
6. `src/renderer/icons.ts`: the icon below.
7. `src/main/test.ts`: the scenario below, run after `SCENARIO_WRAPTEXT` (and a `YDDD_TEST_ONLY === "curve"` hook).

### kernel.ts

```ts
/**
 * Curve: a flat relief (a scanned logo on its plate, letters pushed up) laid round a cylinder of `radius` — its back
 * (its largest flat face) on the cylinder, each layer (between the heights of its flat faces) as thick round it as it
 * was, so it sits on a cup's side; the back's middle stays where it was. Its outline is projected onto the cylinder
 * (not stretched round it): near the sides it's a little narrower (a 42 mm logo on r 40: ~13% at its ends) — nearly,
 * then moved onto the cup and joined by hand. `aroundShort`: the shorter side goes round (else the longer).
 */
export function curveSolid(shape: Solid, radius: number, aroundShort = false): Solid {
  if (!(radius > 0)) throw new Error("Curve: the radius must be more than 0");
  const planes = shape.faces.filter((f) => f.geomType === "PLANE");
  if (!planes.length) throw new Error("Curve: needs a flat back (e.g. a plate or pushed-up letters)");
  const areas = new Map(planes.map((f) => [f, measureArea(f)]));
  const back = planes.reduce((m, f) => (areas.get(f)! > areas.get(m)! ? f : m));
  const n = norm3((back.normalAt().toTuple() as V3).map((x) => -x) as V3), O = back.center.toTuple() as V3;
  // Only a flat relief: flat faces facing along ±n, and walls straight along n — a slope or a rounding (a dome, a
  // chamfer, a fillet) has no layer to go in and would be left out without a word
  const flatOrWall = (f: Face) =>
    f.geomType === "PLANE"
      ? Math.abs(Math.abs(dot3(norm3(f.normalAt().toTuple() as V3), n)) - 1) < 1e-6 || Math.abs(dot3(norm3(f.normalAt().toTuple() as V3), n)) < 1e-6
      : [0.1, 0.5, 0.9].every((a) => [0.1, 0.5, 0.9].every((b) => Math.abs(dot3(normalAtUV(f, a, b), n)) < 1e-6));
  if (!shape.faces.every(flatOrWall))
    throw new Error("Curve: works on flat reliefs (flat layers, straight sides — like a scanned logo pushed up) — this has a slope or a rounding (a dome, a chamfer, a fillet) it would leave out");
  // Round which way: along the back's longer (or shorter) side
  let u = norm3(cross3(Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], n)), v = cross3(n, u);
  const pts = shape.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple() as V3));
  const span = (d: V3) => { const s = pts.map((p) => dot3(p, d)); return [Math.min(...s), Math.max(...s)]; };
  const len = (d: V3) => { const [a, b] = span(d); return b - a; };
  if (len(v) > len(u) !== aroundShort) [u, v] = [v, cross3(n, v)];
  const [u0, u1] = span(u), half = Math.max(dot3(O, u) - u0, u1 - dot3(O, u));
  if (half >= radius) throw new Error(`Curve: it's ${+(u1 - u0).toFixed(1)} mm across — the radius must be more than ${+half.toFixed(1)} mm (half of it from its middle)`);
  // Layers: the heights of its flat faces facing along ±n, from the back
  const h0 = dot3(O, n);
  const levels = [...new Set(planes.filter((f) => Math.abs(Math.abs(dot3(f.normalAt().toTuple() as V3, n)) - 1) < 1e-6).map((f) => Math.round((dot3(f.center.toTuple() as V3, n) - h0) * 1e5) / 1e5))].sort((a, b) => a - b);
  if (levels[0] < -1e-6 || levels.length < 2) throw new Error("Curve: needs a flat back (e.g. a plate or pushed-up letters)");
  // The cylinder's axis: along v, `radius` behind the back's middle
  const [v0, v1] = span(v);
  const base = add3(add3(O, n.map((x) => -x * radius) as V3), v.map((x) => x * (v0 - dot3(O, v) - 2)) as V3);
  const frame: Frame = { origin: [0, 0, 0], x: u, y: cross3(v, u), z: v };
  const cyl = (r: number) => makeCylinder(frame, base, r, v1 - v0 + 4);
  // Each layer's outline, as upright prisms reaching through its whole ring: the bottom one, the back; the others, the
  // flat tops at or above the layer's top (a relief: each layer within the one below) — the solid's own faces, so it
  // isn't cut into layers first (~1 s on a lettered plate)
  const level = (f: Face) => dot3(f.center.toTuple() as V3, n) - h0;
  const ups = planes.filter((f) => dot3(f.normalAt().toTuple() as V3, n) > 1 - 1e-6);
  const prism = (f: Face, from: number, to: number) => translateShape(extrudeFace(shape, f.hashCode, -(from + radius + 4)), n.map((x) => x * (to + 2 - from)) as V3);
  const curved: Shape3D[] = [];
  for (let i = 0; i + 1 < levels.length; i++) {
    const a = levels[i], b = levels[i + 1];
    const prisms = i === 0 ? [translateShape(extrudeFace(shape, back.hashCode, radius + b + 4), n.map((x) => x * (b + 2)) as V3)] : ups.filter((f) => level(f) > b - 1e-6).map((f) => prism(f, level(f), b));
    if (!prisms.length) continue;
    // (common with several tools: the ring's part inside any of them — one pass, not one per prism)
    const got = booleanOnce("common", booleanOp("subtract", cyl(radius + b), [cyl(radius + a)]), prisms, "off");
    if (solidPieces(got as Shape).length) curved.push(got);
  }
  if (!curved.length) throw new Error("Curve: nothing came out — is it a flat relief (a plate, pushed-up letters)?");
  // The layers only touch on their round faces (one's top on the next one's bottom): glued (3.9 → s), else a plain union
  let out: Shape3D | null = curved.length > 1 ? null : curved[0];
  if (!out) {
    try {
      const g = booleanOnce("fuse", curved[0], curved.slice(1), "shift").simplify();
      if (isValidShape(g as Shape) && solidPieces(g as Shape).length === 1) out = g;
    } catch {
      // the plain union below
    }
    if (!out) {
      out = booleanOp("union", curved[0] as Solid, curved.slice(1) as Solid[]);
      if (!isValidShape(out as Shape)) throw new Error("Curve: the curved solid isn't valid — try another radius");
    }
  } else if (!isValidShape(out as Shape)) throw new Error("Curve: the curved solid isn't valid — try another radius");
  return out as Solid;
}
```

### main.ts

```ts
  /**
   * Curve: a flat relief (a scanned logo on its plate) laid round a cylinder of a radius — a cup's — to be moved onto
   * the cup and joined by hand (see curveSolid). In the background kernel: a lettered plate takes a few seconds.
   */
  private opCurve(): void {
    const ids = [...new Set(this.selection.map((s) => s.body))];
    // Flat faces selected (a scanned logo not pushed yet): that's Curve face
    if (ids.length && ids.every((id) => this.doc.get(id)?.kind === "face")) return this.opCurveFace();
    const body = ids.length === 1 ? this.doc.get(ids[0]) : undefined;
    if (!body || body.kind !== "solid" || !isBrep(body)) {
      this.toast("Curve: select one solid with a flat back — e.g. a scanned logo pushed up from its plate (flat faces: Curve face)", "error");
      return;
    }
    const bodyId = body.id;
    let brep: string | undefined;
    this.startOp({
      title: "Curve",
      label: "Curve",
      note: `<span class="op-help">Round a cylinder of this radius (a cup's), its back on it — then move it onto the cup (Shift+G) and Union</span>`,
      fields: [
        { key: "r", label: "Radius (mm)", value: this.defaults.curveRadius, step: 1, min: 0 },
        { key: "short", label: "Round", value: this.defaults.curveShort ? 1 : 0, type: "select", options: ["The longer side", "The shorter side"] },
      ],
      compute: ({ r, short }) => this.replaceOutcome(new Map([[bodyId, curveSolid(this.solidOf(bodyId, "Curve"), r, !!short)]]), "Curve"),
      computeAsync: async ({ r, short }) => {
        if (!(r > 0)) throw new Error("Curve: the radius must be more than 0");
        brep ??= serializeShape(this.solidOf(bodyId, "Curve"));
        // Seconds on a lettered plate (its curved walls cut by the cylinders): the busy dialog meanwhile — Stop / Esc
        // closes the Curve, nothing changed
        const busy = this.showBusy(`Curving round ${fmt(r)} mm…`, () => {
          this.cancelOp();
          this.toast("Curve stopped — nothing changed");
        });
        try {
          const res = await this.bgKernel.run({ op: "curve", brep, radius: r, aroundShort: !!short });
          return this.replaceOutcome(new Map([[bodyId, solidFrom(res)]]), "Curve");
        } finally {
          busy.close();
        }
      },
      remember: ({ r, short }) => {
        this.defaults.curveRadius = r;
        this.defaults.curveShort = !!short;
      },
    });
  }
```

### icons.ts

```ts
  curve: svg(`<path d="M3 15.5c5-4 13-4 18 0" ${SOFT}/><path d="M5 12.5c4.2-3.2 9.8-3.2 14 0v3.2c-4.2-3.2-9.8-3.2-14 0z" ${FILL}/><path d="M9 9.6V8M12 9V7.3M15 9.6V8"/>`),
```

### test.ts

```ts
/** Curve: a plaque (a plate with a bar raised on it) laid round a cylinder — its back on the radius, each layer as thick round it; too small a radius refused. */
const SCENARIO_CURVE = String.raw`
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const app = window.ydddApp, K = window.ydddKernel;
  const checks = [];
  const expect = (label, ok, got) => checks.push({ label, ok: !!ok, got });
  const G = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
  app.doc.reset([]);
  // 30 × 10 plate, 2 thick, its back on z 0; a 20 × 4 bar 1 high on it
  const plaque = K.booleanOp("union", K.makeBox(G, [0, 0, 0], 30, 10, 2), [K.makeBox(G, [0, 0, 2], 20, 4, 1)]);
  const b = app.doc.makeBody(plaque, "Plaque");
  app.doc.commit([b], "plaque"); await sleep(30);
  app.run("mode.body"); app.setSelection([{ kind: "body", body: b.id, id: 0 }]);
  const waitJob = async () => { await sleep(150); for (let k = 0; k < 600 && (app.op?.job || /Working/.test(document.querySelector("#op-panel .op-error")?.textContent || "")); k++) await sleep(25); };
  const setR = async (v) => { const i = document.querySelector("#op-panel input[data-key=r]"); i.value = String(v); i.dispatchEvent(new Event("input", { bubbles: true })); await waitJob(); };
  app.run("op.curve"); await waitJob();
  await setR(14);
  const refused = document.querySelector("#op-panel .op-error")?.textContent || "";
  expect("curve: radius 14 refused for a 30 mm plaque (more than 15 needed)", /radius must be more than 15/.test(refused), refused);
  await setR(20);
  app.applyOp(); for (let k = 0; k < 200 && app.op; k++) await sleep(25);
  const c = app.doc.bodies[0].shape;
  // Round the Y axis through (0, *, −20): the back on r 20, the plate's top on 22, the bar's on 23
  const r = c.edges.flatMap((e) => [0, 0.5, 1].map((t) => e.pointAt(t).toTuple())).map(([x, , z]) => Math.hypot(x, z + 20));
  const near = (v) => r.some((x) => Math.abs(x - v) < 1e-4);
  expect("curve: radius 20 — one valid solid round the Y axis, its back on r 20, the plate's top on 22, the bar's on 23, nothing off them",
    !app.op && K.isValidShape(c) && K.solidPieces(c).length === 1 && Math.min(...r) > 20 - 1e-4 && Math.max(...r) < 23 + 1e-4 && near(20) && near(22) && near(23) && app.doc.undoLabel === "Curve",
    { valid: K.isValidShape(c), min: Math.min(...r), max: Math.max(...r), undo: app.doc.undoLabel });
  // Not a flat relief (a dome on the plate): refused, not curved with the dome left out
  const dome = K.booleanOp("union", K.makeBox(G, [0, 0, 0], 30, 10, 2), [K.booleanOp("intersect", K.makeSphereAt([0, 0, 2], 4), [K.makeBox(G, [0, 0, 2], 10, 10, 5)])]);
  let domeErr = ""; try { K.curveSolid(dome, 20, false); } catch (e) { domeErr = String(e && e.message || e); }
  expect("curve: a plate with a dome on it refused (a rounding it would leave out)", /flat reliefs/.test(domeErr), domeErr);
  app.doc.reset([]);
  const failed = checks.filter((x) => !x.ok);
  if (failed.length) console.error("curve scenario failed: " + JSON.stringify(failed));
  return [{ label: "curve", passed: checks.length - failed.length, total: checks.length, checks }];
})()
`;
```
