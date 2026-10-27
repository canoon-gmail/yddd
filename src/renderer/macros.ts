/**
 * The Macro menu: ready-made parts and box tools (Box from Face, Box Lid, Dividers, Battery case,
 * Random, Gridfinity bin / baseplate), each an op panel on the App.
 */
import * as THREE from "three";
import {
  translateShape,
  rotateShape,
  cloneShape,
  findFace,
  faceSegments,
  boxFromFace,
  boxLid,
  boxDividers,
  batteryCase,
  gridfinityBin,
  gridfinitySizes,
  gridfinityBaseplate,
  gridfinityBaseplateSizes,
  type GridfinityBin,
  type GridfinityBaseplate,
  GRIDFINITY,
  hasBoxRim,
  scaleShape,
  type V3,
  boundsOf,
  type Geom,
  type Solid,
} from "./kernel";
import { scatter } from "./scatter";
import { isBrep, withShape, type Body } from "./document";
import { type SelItem, type ShownDimension } from "./viewport";
import { solidFrom } from "./kernelWorker";
import { escapeHtml, fmt, isPro } from "./ui";
import { OpWaiting, type OpField, type OpOutcome, type OpSpec } from "./ops";
import { inGroupOf } from "./bodies";
import type { App } from "./main";

/** Macro → Battery case: the batteries everyone has (diameter × length, mm), and the Pro layout's more. */
const BATTERIES = [{ name: "AA", diameter: 14.5, length: 50.5 }, { name: "AAA", diameter: 10.5, length: 44.5 }, { name: "18650", diameter: 18.6, length: 65.2 }];
const PRO_BATTERIES = [{ name: "C", diameter: 26.2, length: 50 }, { name: "D", diameter: 34.2, length: 61.5 }];

/**
 * Macro → Box from Face: an open-top box round a flat face — the face is its inside (floor and inner outline);
 * walls grow out from it, the bottom down under it (a face object becomes the box; on a solid's face, a new
 * solid) — wall, bottom, inside depth, and optionally round vertical edges. The panel opens at once and
 * waits for the face if none is selected; a click on another flat face (or a face object's row) changes it.
 */
export function opBoxFromFace(app: App): void {
  openBoxFromFace(app, app.oneFaceTarget());
}

export function openBoxFromFace(app: App, target: { bodyId: number; faceId: number } | null): void {
  const tb = target && app.doc.get(target.bodyId);
  const body = tb && isBrep(tb) && findFace(tb.shape, target!.faceId)?.geomType === "PLANE" ? tb : null;
  const faceId = body ? target!.faceId : 0;
  // What a click picks: a flat face (of a face object or a solid), or something it can't use
  type Target = { bodyId: number; faceId: number } | "bad" | null;
  const targetAt = (e: PointerEvent): Target => {
    const hit = app.viewport.pick(e.clientX, e.clientY, "face");
    const b = hit && app.doc.get(hit.body);
    if (!hit || !b) return null;
    return hit.kind === "face" && isBrep(b) && findFace(b.shape, hit.id)?.geomType === "PLANE" ? { bodyId: b.id, faceId: hit.id } : "bad";
  };
  const targetOf = (id: number): Target => {
    const b = app.doc.get(id);
    return b?.kind === "face" && b.shape.faces[0]?.geomType === "PLANE" ? { bodyId: b.id, faceId: b.shape.faces[0].hashCode } : "bad";
  };
  const take = (t: Target) => {
    if (!t) return;
    if (t === "bad") return app.toast("Box from Face: click a flat face — of a face object (Rectangle, Circle, a sketch...) or a solid", "error");
    spec.remember!(app.opValues().values); // (the panel opens again with them)
    openBoxFromFace(app, t);
  };
  const picked: SelItem[] = body ? [body.kind === "face" ? { kind: "body", body: body.id, id: 0 } : { kind: "face", body: body.id, id: faceId }] : [];
  const todo = "click a flat face: it's the box's inside (floor and inner outline)";
  const d = app.boxDefaults;
  const spec: OpSpec = {
    title: "Box from Face",
    label: "Box from Face",
    note: `Face: ${body ? escapeHtml(body.kind === "face" ? body.name : `a face of ${body.name}`) : "—"}`,
    hint: `Box from Face: ${body ? "click another flat face to change it · Enter apply · " : `${todo} · `}Esc cancel`,
    fields: [
      { key: "wall", label: "Wall (mm)", value: d.wall, step: 0.5, min: 0 },
      { key: "bottom", label: "Bottom (mm)", value: d.bottom, step: 0.5, min: 0 },
      { key: "height", label: "Inside depth (mm)", value: d.height, step: 1, min: 0 },
      { key: "round", label: "Round vertical edges", value: d.round, type: "checkbox" },
      { key: "radius", label: "Inside radius (mm)", value: d.radius, step: 0.5, min: 0 },
    ],
    compute: ({ wall, bottom, height, round, radius }) => {
      if (!body) throw new OpWaiting(todo[0].toUpperCase() + todo.slice(1));
      const solid = boxFromFace(body.shape, faceId, { wall, bottom, height, radius: round ? radius : 0 });
      // A face object becomes the box; on a solid's face it's a new solid
      const replace = body.kind === "face";
      return {
        ghost: new Map([[replace ? body.id : -1, solid]]),
        commit: () => {
          const nb = inGroupOf(app.doc.makeBody(solid, "Box"), body);
          app.doc.commit(replace ? app.doc.bodies.map((b) => (b.id === body.id ? nb : b)) : [...app.doc.bodies, nb], "Box from Face");
          return { select: [nb.id], solidMode: true };
        },
      };
    },
    remember: ({ wall, bottom, height, round, radius }) => (app.boxDefaults = { wall, bottom, height, round, radius }),
    pick: (e) => take(targetAt(e)),
    pickBody: (id) => take(targetOf(id)),
    hover: (e) => {
      const t = targetAt(e);
      app.viewport.setHighlight(picked, t && t !== "bad" ? { kind: "face", body: t.bodyId, id: t.faceId } : null);
      app.viewport.canvas.style.cursor = t === "bad" ? "not-allowed" : t ? "pointer" : "crosshair";
    },
  };
  app.startOp(spec);
  app.viewport.setHighlight(picked, null);
}

/** The one selected solid (or a face of it), for Box Lid; null for anything else. */
export function selectedLidBox(app: App): number | null {
  const ids = [...new Set(app.selection.map((s) => s.body))];
  return ids.length === 1 && app.doc.get(ids[0])?.kind === "solid" ? ids[0] : null;
}

/**
 * Macro → Box Lid: a lid for an open-top box (Box from Face, Shell...), closed on it — `over` false: a plate on the
 * rim with a lip fitting in the opening; true: a cap, bigger, its skirt round the box's outside. The panel waits for
 * the box if none is selected; a click on another one changes it.
 */
export function openBoxLid(app: App, over: boolean, boxId: number | null): void {
  const tb = boxId === null ? undefined : app.doc.get(boxId);
  const box = tb?.kind === "solid" ? tb : null;
  const kind = over ? "Lid over the box" : "Lid with inside lip";
  // What a click picks: a solid with an open top, or something it can't use
  const targetOf = (id: number | null | undefined): number | "bad" | null => {
    if (id === null || id === undefined) return null;
    const b = app.doc.get(id);
    return b?.kind === "solid" && hasBoxRim(b.shape as Solid) ? b.id : "bad";
  };
  const take = (t: number | "bad" | null) => {
    if (t === null) return;
    if (t === "bad") return app.toast(`${kind}: click an open-top box — a solid with a flat rim round its opening (Box from Face, Shell...)`, "error");
    spec.remember!(app.opValues().values); // (the panel opens again with them)
    openBoxLid(app, over, t);
  };
  const at = (e: PointerEvent) => targetOf(app.viewport.pick(e.clientX, e.clientY, "body")?.body);
  const d = over ? app.lidDefaults.over : app.lidDefaults.in;
  const part = over ? "Skirt" : "Lip";
  const todo = "click the open-top box to make it for";
  const spec: OpSpec = {
    title: over ? "Box Lid — over the box" : "Box Lid — inside lip",
    label: kind,
    note: `Box: ${box ? escapeHtml(box.name) : "—"}`,
    hint: `${kind}: ${box ? "click another box to change it · Enter apply · " : `${todo} · `}Esc cancel`,
    fields: [
      { key: "thickness", label: "Lid thickness (mm)", value: d.thickness, step: 0.5, min: 0 },
      { key: "depth", label: `${part} depth (mm${over ? "" : ", 0: none"})`, value: d.depth, step: 0.5, min: 0 },
      { key: "wall", label: `${part} wall (mm${over ? "" : ", 0: solid"})`, value: d.wall, step: 0.5, min: 0 },
      { key: "clearance", label: "Clearance (mm)", value: d.clearance, step: 0.1, min: 0 },
    ],
    compute: ({ thickness, depth, wall, clearance }) => {
      if (!box) throw new OpWaiting(todo[0].toUpperCase() + todo.slice(1));
      const lid = boxLid(box.shape as Solid, { over, thickness, lipDepth: depth, lipWall: wall, clearance });
      return {
        ghost: new Map([[-1, lid]]),
        commit: () => {
          const nb = inGroupOf(app.doc.makeBody(lid, "Lid"), box);
          app.doc.commit([...app.doc.bodies, nb], kind);
          return { select: [nb.id], solidMode: true };
        },
      };
    },
    remember: ({ thickness, depth, wall, clearance }) => (app.lidDefaults[over ? "over" : "in"] = { thickness, depth, wall, clearance }),
    pick: (e) => take(at(e)),
    pickBody: (id) => take(targetOf(id)),
    hover: (e) => {
      const t = at(e);
      app.viewport.setHighlight(box ? [{ kind: "body", body: box.id, id: 0 }] : [], typeof t === "number" ? { kind: "body", body: t, id: 0 } : null);
      app.viewport.canvas.style.cursor = t === "bad" ? "not-allowed" : t !== null ? "pointer" : "crosshair";
    },
  };
  app.startOp(spec);
  app.viewport.setHighlight(box ? [{ kind: "body", body: box.id, id: 0 }] : [], null);
}

/**
 * Macro → Dividers: walls in an open-top box (Box from Face, Shell...) — a grid of equal compartments, columns along
 * its long side, rows across it; the walls from the floor up to a gap under the rim (room for a lid's lip), fused into
 * the box. The panel waits for the box if none is selected; a click on another one changes it.
 */
export function openDividers(app: App, boxId: number | null): void {
  const tb = boxId === null ? undefined : app.doc.get(boxId);
  const box = tb?.kind === "solid" && hasBoxRim(tb.shape as Solid) ? tb : null;
  const targetOf = (id: number | null | undefined): number | "bad" | null => {
    if (id === null || id === undefined) return null;
    const b = app.doc.get(id);
    return b?.kind === "solid" && hasBoxRim(b.shape as Solid) ? b.id : "bad";
  };
  const take = (t: number | "bad" | null) => {
    if (t === null) return;
    if (t === "bad") return app.toast("Dividers: click an open-top box — a solid with a flat rim round its opening (Box from Face, Shell...)", "error");
    spec.remember!(app.opValues().values); // (the panel opens again with them)
    openDividers(app, t);
  };
  const at = (e: PointerEvent) => targetOf(app.viewport.pick(e.clientX, e.clientY, "body")?.body);
  const d = app.dividerDefaults;
  const todo = "click the open-top box to divide";
  const spec: OpSpec = {
    title: "Dividers",
    label: "Dividers",
    note: `Box: ${box ? escapeHtml(box.name) : "—"}`,
    hint: `Dividers: ${box ? "click another box to change it · Enter apply · " : `${todo} · `}Esc cancel`,
    fields: [
      { key: "columns", label: "Columns (along the long side)", value: d.columns, step: 1, min: 1 },
      { key: "rows", label: "Rows (across it)", value: d.rows, step: 1, min: 1 },
      { key: "wall", label: "Wall (mm)", value: d.wall, step: 0.2, min: 0 },
      { key: "topGap", label: "Below the rim (mm, room for a lid's lip)", value: d.topGap, step: 0.5, min: 0 },
    ],
    compute: ({ columns, rows, wall, topGap }) => {
      if (!box) throw new OpWaiting(todo[0].toUpperCase() + todo.slice(1));
      const solid = boxDividers(box.shape as Solid, { columns, rows, wall, topGap });
      return {
        ghost: new Map([[box.id, solid]]),
        commit: () => {
          app.doc.commit(app.doc.bodies.map((b) => (b.id === box.id ? withShape(b, solid) : b)), "Dividers");
          return { select: [box.id], solidMode: true };
        },
      };
    },
    remember: ({ columns, rows, wall, topGap }) => (app.dividerDefaults = { columns, rows, wall, topGap }),
    pick: (e) => take(at(e)),
    pickBody: (id) => take(targetOf(id)),
    hover: (e) => {
      const t = at(e);
      app.viewport.setHighlight(box ? [{ kind: "body", body: box.id, id: 0 }] : [], typeof t === "number" ? { kind: "body", body: t, id: 0 } : null);
      app.viewport.canvas.style.cursor = t === "bad" ? "not-allowed" : t !== null ? "pointer" : "crosshair";
    },
  };
  app.startOp(spec);
  app.viewport.setHighlight(box ? [{ kind: "body", body: box.id, id: 0 }] : [], null);
}

/**
 * Macro → Battery case: a block with a grid of holes the batteries stand in (AA, AAA, 18650), beside what's
 * there. The Pro layout has more: C and D cells, a custom size, the hole depth, clearance, wall and floor.
 */
export function openBatteryCase(app: App): void {
  const pro = isPro(), d = app.batteryDefaults;
  const types = pro ? [...BATTERIES, ...PRO_BATTERIES] : BATTERIES;
  const options = types.map((t) => `${t.name} (${fmt(t.diameter)} × ${fmt(t.length)} mm)`);
  if (pro) options.push("Custom (size below)");
  const fields: OpField[] = [
    { key: "battery", label: "Battery", type: "select", options, value: Math.min(d.battery, options.length - 1) },
    { key: "columns", label: "Columns", value: d.columns, step: 1, min: 1 },
    { key: "rows", label: "Rows", value: d.rows, step: 1, min: 1 },
  ];
  if (pro) {
    fields.push(
      { key: "depth", label: "Hole depth (% of the battery)", value: d.depth, step: 5, min: 1 },
      { key: "clearance", label: "Clearance (mm, added to the hole)", value: d.clearance, step: 0.1, min: 0 },
      { key: "wall", label: "Wall (mm)", value: d.wall, step: 0.2, min: 0.4 },
      { key: "floor", label: "Floor (mm)", value: d.floor, step: 0.2, min: 0.4 },
      { key: "diameter", label: "Custom diameter (mm)", value: d.diameter, step: 0.5, min: 1 },
      { key: "length", label: "Custom length (mm)", value: d.length, step: 1, min: 1 },
    );
  }
  // Beside the solids already there (the right of them), else at the origin.
  const right = app.rightOfBodies();
  const params = (v: Record<string, number>) => {
    const t = types[v.battery];
    return {
      diameter: t ? t.diameter : v.diameter, length: t ? t.length : v.length, columns: v.columns, rows: v.rows,
      depth: pro ? v.depth : d.depth, clearance: pro ? v.clearance : d.clearance, wall: pro ? v.wall : d.wall, floor: pro ? v.floor : d.floor,
    };
  };
  app.startOp({
    title: "Battery case",
    label: "Battery case",
    fields,
    compute: (v) => {
      const p = params(v), t = types[v.battery];
      let solid = batteryCase(p);
      if (right > -Infinity) solid = translateShape(solid, [right + 10 - solid.boundingBox.bounds[0][0], 0, 0]);
      return {
        ghost: new Map([[-1, solid]]),
        commit: () => {
          const b = app.doc.makeBody(solid, `Battery case ${t ? t.name : `${fmt(p.diameter)} mm`}`);
          app.doc.commit([...app.doc.bodies, b], "Battery case");
          return { select: [b.id], solidMode: true };
        },
      };
    },
    remember: (v) => (app.batteryDefaults = { ...d, ...v }),
  });
}

/**
 * Macro → Gridfinity bin: width × depth grid squares (42 mm), height in 7 mm units, compartments, the stacking lip,
 * magnet holes — beside what's there, its sizes measured on the preview. The Pro layout adds the wall.
 */
/**
 * Macro → Random: copies of the selected object (several: each copy one of them, at random) scattered on a flat face (clicked, or a flat face selected with
 * it) — Count, sizes between Smallest and Biggest %, each standing on the face (its Z along the face's normal):
 * on it, half in or sunk in; spun at random about the normal; kept on the face and, unless Allow overlap, apart.
 * Seed: the same one, the same spots. The copies: a new group, one undo step; the object itself stays as it is.
 */
export function openRandom(app: App): void {
  const bodies = app.selectedBodyIds().map((id) => app.doc.get(id)!).filter(Boolean);
  const sources = bodies.filter((b) => b.kind === "solid" || b.kind === "mesh");
  if (!sources.length) return app.toast("Random: select the object to copy first (a solid or an STL mesh), then Macro → Random", "error");
  const faceOf = (body: number, id: number) => {
    const b = app.doc.get(body);
    return b && isBrep(b) ? faceSegments(b.shape, id) : null;
  };
  /** The face to scatter on: a flat face selected with it, else clicked. */
  let target: { body: number; face: number } | null = null;
  const flat = bodies.find((b) => b.kind === "face");
  if (flat && isBrep(flat)) target = { body: flat.id, face: flat.shape.faces[0].hashCode };
  const faceAt = (e: PointerEvent) => {
    const p = app.viewport.pick(e.clientX, e.clientY, "face");
    return p && p.kind === "face" && faceOf(p.body, p.id) ? { body: p.body, face: p.id } : null;
  };
  // Each object at 100 %: its box's middle, its half height, the footprint's radius round the middle (its edges' farthest
  // point across X–Y — a peg's own radius; a mesh: half its box's X–Y diagonal)
  const kits = sources.map((source) => {
    const [lo, hi] = boundsOf(source.shape);
    const c = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2) as V3, hz = (hi[2] - lo[2]) / 2;
    let r0 = Math.hypot(hi[0] - lo[0], hi[1] - lo[1]) / 2;
    if (isBrep(source)) {
      const far = Math.max(...source.shape.edges.flatMap((e) => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map((k) => {
        const p = e.pointAt(k / 15).toTuple();
        return Math.hypot(p[0] - c[0], p[1] - c[1]);
      })));
      if (far > 0 && far < r0) r0 = far;
    }
    return { source, c, hz, r0, name: source.name.replace(/\s+\d+$/, "") };
  });
  const d = app.randomDefaults;
  const ALIGN = ["On the face", "Half in", "Sunk in"]; // (its bottom / middle / top on the face)
  app.startOp({
    title: "Random",
    label: "Random",
    note: `Copies of <b>${sources.map((b) => escapeHtml(b.name)).join(", ")}</b>${sources.length > 1 ? " (each one of them, at random)" : ""} scattered on a flat face — click one (a solid's or a flat face)`,
    fields: [
      { key: "count", label: "Count", value: d.count, step: 1, min: 1 },
      { key: "smallest", label: "Smallest (%)", value: d.smallest, step: 10, min: 1 },
      { key: "biggest", label: "Biggest (%)", value: d.biggest, step: 10, min: 1 },
      { key: "align", label: "Align", type: "select", options: ALIGN, value: d.align },
      { key: "spin", label: "Random spin (about the face's normal)", type: "checkbox", value: d.spin },
      { key: "overlap", label: "Allow overlap", type: "checkbox", value: d.overlap },
      { key: "seed", label: "Seed (change it: a new layout)", value: d.seed, step: 1, min: 0 },
    ],
    hint: "Random: click the flat face to scatter on · Count, sizes, Align · Seed: a new layout · Enter or Apply · Esc cancel",
    pick: (e) => {
      const t = faceAt(e);
      if (!t) return app.toast("Random: click a flat face", "error");
      target = t;
      app.previewOp();
    },
    hover: (e) => {
      const t = faceAt(e);
      app.viewport.setHighlight(app.selection, t ? { kind: "face", body: t.body, id: t.face } : null);
      app.viewport.canvas.style.cursor = t ? "pointer" : "crosshair";
    },
    compute: ({ count, smallest, biggest, align, spin, overlap, seed }) => {
      const face = target && faceOf(target.body, target.face);
      if (!face) throw new OpWaiting("Click the flat face to scatter the copies on");
      if (!(count >= 1) || count !== Math.round(count)) throw new Error("Count must be a whole number, 1 or more");
      if (count > 500) throw new Error("At most 500 copies");
      if (!(smallest > 0) || !(biggest > 0)) throw new Error("Sizes must be more than 0 %");
      if (biggest < smallest) throw new Error("Biggest must be at least Smallest");
      const spots = scatter(face, kits.map((k) => k.r0), { count, smallest: smallest / 100, biggest: biggest / 100, spin: !!spin, overlap: !!overlap, seed });
      if (!spots.length) throw new Error("None fit on that face — smaller sizes, or a bigger face");
      const n = new THREE.Vector3(...face.normal);
      // Standing on the face: Z turned to its normal (the shortest turn; facing down: half a turn about X)
      const z = new THREE.Vector3(0, 0, 1), axis = z.clone().cross(n);
      const tilt = axis.length() > 1e-9 ? { axis: axis.normalize(), deg: THREE.MathUtils.radToDeg(z.angleTo(n)) } : n.z < 0 ? { axis: new THREE.Vector3(1, 0, 0), deg: 180 } : null;
      const lift = [1, 0, -1][align] ?? 1; // (the middle that many half heights out along the normal)
      const placeOf = (s: (typeof spots)[number]) => n.clone().multiplyScalar(lift * kits[s.pick].hz * s.scale).add(new THREE.Vector3(...s.at));
      const matrixOf = (s: (typeof spots)[number]) => {
        const { c } = kits[s.pick];
        const m = new THREE.Matrix4().makeTranslation(placeOf(s));
        if (tilt) m.multiply(new THREE.Matrix4().makeRotationAxis(tilt.axis, THREE.MathUtils.degToRad(tilt.deg)));
        return m.multiply(new THREE.Matrix4().makeRotationZ(THREE.MathUtils.degToRad(s.spin)))
          .multiply(new THREE.Matrix4().makeScale(s.scale, s.scale, s.scale))
          .multiply(new THREE.Matrix4().makeTranslation(-c[0], -c[1], -c[2]));
      };
      const build = (s: (typeof spots)[number]): Geom => {
        const { source, c } = kits[s.pick];
        let g: Geom = cloneShape(source.shape);
        if (Math.abs(s.scale - 1) > 1e-12) g = scaleShape(g, [s.scale, s.scale, s.scale], c);
        if (s.spin) g = rotateShape(g, s.spin, c, [0, 0, 1]);
        if (tilt) g = rotateShape(g, tilt.deg, c, tilt.axis.toArray() as V3);
        return translateShape(g, placeOf(s).sub(new THREE.Vector3(...c)).toArray() as V3);
      };
      return {
        ghost: new Map(),
        placed: spots.map((s) => ({ id: kits[s.pick].source.id, matrix: matrixOf(s) })),
        warn: spots.length < count ? { text: `${spots.length} of ${count} fit — fewer, smaller, or Allow overlap`, action: overlap ? undefined : { label: "Allow overlap", set: { overlap: 1 } } } : undefined,
        commit: () => {
          const group = app.newGroupName("Random");
          const copies = spots.map((s) => ({ ...app.doc.makeBody(build(s), kits[s.pick].name, kits[s.pick].source.kind), group }) as Body);
          app.doc.commit([...app.doc.bodies, ...copies], `Random ×${copies.length}`);
          return { select: copies.map((b) => b.id), solidMode: true, then: () => app.toast(`${copies.length} copies of ${sources.map((b) => b.name).join(", ")} as "${group}" in the Bodies panel`) };
        },
      };
    },
    remember: (v) => (app.randomDefaults = { ...d, ...v }),
  });
}

export function openGridfinityBin(app: App): void {
  const pro = isPro(), d = app.gridfinityDefaults, g = GRIDFINITY;
  const fields: OpField[] = [
    { key: "width", label: `Width (grid squares of ${g.grid} mm)`, value: d.width, step: 1, min: 1 },
    { key: "depth", label: `Depth (grid squares of ${g.grid} mm)`, value: d.depth, step: 1, min: 1 },
    { key: "height", label: `Height (units of ${g.unit} mm)`, value: d.height, step: 1, min: 2 },
    { key: "columns", label: "Compartments across", value: d.columns, step: 1, min: 1 },
    { key: "rows", label: "Compartments front to back", value: d.rows, step: 1, min: 1 },
    { key: "lip", label: "Stacking lip", type: "checkbox", value: d.lip },
    { key: "magnets", label: `Magnet holes (${g.magnet.d} × ${g.magnet.depth} mm, 4 per square)`, type: "checkbox", value: d.magnets },
  ];
  if (pro) fields.push({ key: "wall", label: "Wall (mm)", value: d.wall, step: 0.1, min: 0.4 });
  const squares = (n: number) => `${n} square${n === 1 ? "" : "s"}`;
  const params = (v: Record<string, number>) => ({
    width: Math.round(v.width), depth: Math.round(v.depth), height: Math.round(v.height), columns: Math.round(v.columns), rows: Math.round(v.rows),
    lip: !!v.lip, magnets: !!v.magnets, wall: pro ? v.wall : d.wall,
  });
  const right = app.rightOfBodies();
  const place = (p: GridfinityBin): V3 => [right > -Infinity ? right + 10 + gridfinitySizes(p).w / 2 : 0, 0, 0];
  const outcome = (p: GridfinityBin, at: V3, solid: Solid): OpOutcome => {
    // Measured on the preview: width along the front, depth down the right side, height (and the lip) up the
    // back right corner (clear of those two, and of the panel on the left), a compartment across the top
    const { w, d: dd, h, cellW, cellD } = gridfinitySizes(p);
    const x0 = at[0] - w / 2, x1 = at[0] + w / 2, y0 = -dd / 2, y1 = dd / 2, gap = 8;
    const dims: ShownDimension[] = [
      { a: [x0, y0, 0], b: [x1, y0, 0], o: [0, -gap, 0], text: `${squares(p.width)} · ${fmt(w)} mm` },
      { a: [x1, y0, 0], b: [x1, y1, 0], o: [gap, 0, 0], text: `${squares(p.depth)} · ${fmt(dd)} mm` },
      { a: [x1, y1, 0], b: [x1, y1, h], o: [gap * 0.7, gap * 0.7, 0], text: `${p.height} units · ${fmt(h)} mm` },
    ];
    if (p.lip) dims.push({ a: [x1, y1, h], b: [x1, y1, h + g.lip], o: [gap * 0.7, gap * 0.7, 0], text: `lip ${fmt(g.lip)}` });
    if (p.columns > 1 || p.rows > 1) {
      const cx = x0 + p.wall, cy = y1 - p.wall, top = p.lip ? h + g.lip : h;
      dims.push({ a: [cx, cy, top], b: [cx + cellW, cy, top], o: [0, 0, gap * 0.6], text: `compartment ${fmt(cellW)} × ${fmt(cellD)} mm` });
    }
    return {
      ghost: new Map([[-1, solid]]),
      dims,
      commit: () => {
        const b = app.doc.makeBody(solid, `Gridfinity bin ${p.width}×${p.depth}×${p.height}`);
        app.doc.commit([...app.doc.bodies, b], "Gridfinity bin");
        return { select: [b.id], solidMode: true };
      },
    };
  };
  app.startOp({
    title: "Gridfinity bin",
    label: "Gridfinity bin",
    note: "Fits Gridfinity baseplates; bins stack on the lip",
    fields,
    compute: (v) => {
      const p = params(v), at = place(p);
      return outcome(p, at, gridfinityBin(p, at));
    },
    // (in the background kernel: a big bin takes a second or more)
    computeAsync: async (v) => {
      const p = params(v), at = place(p);
      return outcome(p, at, solidFrom(await app.bgKernel.run({ op: "gridfinity", bin: p, at })));
    },
    remember: (v) => (app.gridfinityDefaults = { ...d, ...v }),
  });
}

/**
 * Macro → Gridfinity baseplate: width × depth grid squares the bins drop into — or as many as fit a drawer, a border
 * filling the rest; magnet holes (a floor under the pockets). Beside what's there, measured on the preview.
 */
export function openGridfinityBaseplate(app: App): void {
  const d = app.baseplateDefaults, g = GRIDFINITY, BED = 256;
  const fields: OpField[] = [
    { key: "width", label: `Width (grid squares of ${g.grid} mm)`, value: d.width, step: 1, min: 1, off: (v) => v.drawerWidth > 0 },
    { key: "depth", label: `Depth (grid squares of ${g.grid} mm)`, value: d.depth, step: 1, min: 1, off: (v) => v.drawerDepth > 0 },
    { key: "drawerWidth", label: "Or fill a drawer: width (mm, 0 = off)", value: d.drawerWidth, step: 1, min: 0 },
    { key: "drawerDepth", label: "Fill a drawer: depth (mm, 0 = off)", value: d.drawerDepth, step: 1, min: 0 },
    { key: "magnets", label: `Magnet holes (${g.magnet.d} × ${g.magnet.depth} mm, 4 per square)`, type: "checkbox", value: d.magnets },
  ];
  const squares = (n: number) => `${n} square${n === 1 ? "" : "s"}`;
  const params = (v: Record<string, number>): GridfinityBaseplate => ({ width: Math.round(v.width), depth: Math.round(v.depth), drawerWidth: v.drawerWidth, drawerDepth: v.drawerDepth, magnets: !!v.magnets });
  const right = app.rightOfBodies();
  const place = (p: GridfinityBaseplate): V3 => [right > -Infinity ? right + 10 + gridfinityBaseplateSizes(p).w / 2 : 0, 0, 0];
  const outcome = (p: GridfinityBaseplate, at: V3, solid: Solid): OpOutcome => {
    // Measured: the outside along the front and down the right side (squares, and the drawer border if any), the
    // height up the back right corner
    const z = gridfinityBaseplateSizes(p);
    const x0 = at[0] - z.w / 2, x1 = at[0] + z.w / 2, y0 = -z.d / 2, y1 = z.d / 2, gap = 8;
    const side = (n: number, size: number, pad: number) => `${squares(n)}${pad > 1e-6 ? ` + border ${fmt(pad)}` : ""} · ${fmt(size)} mm`;
    const dims: ShownDimension[] = [
      { a: [x0, y0, 0], b: [x1, y0, 0], o: [0, -gap, 0], text: side(z.nx, z.w, z.padX) },
      { a: [x1, y0, 0], b: [x1, y1, 0], o: [gap, 0, 0], text: side(z.ny, z.d, z.padY) },
      { a: [x1, y1, 0], b: [x1, y1, z.h], o: [gap * 0.7, gap * 0.7, 0], text: `${fmt(z.h)} mm` },
    ];
    return {
      ghost: new Map([[-1, solid]]),
      dims,
      ...(Math.max(z.w, z.d) > BED ? { warn: { text: `Bigger than most print beds (${BED} mm): print it in parts — e.g. two plates side by side` } } : {}),
      commit: () => {
        const b = app.doc.makeBody(solid, `Gridfinity baseplate ${z.nx}×${z.ny}`);
        app.doc.commit([...app.doc.bodies, b], "Gridfinity baseplate");
        return { select: [b.id], solidMode: true };
      },
    };
  };
  app.startOp({
    title: "Gridfinity baseplate",
    label: "Gridfinity baseplate",
    note: "Gridfinity bins drop into its squares",
    fields,
    compute: (v) => {
      const p = params(v), at = place(p);
      return outcome(p, at, gridfinityBaseplate(p, at));
    },
    // (in the background kernel: a drawer-sized plate takes a second or more)
    computeAsync: async (v) => {
      const p = params(v), at = place(p);
      return outcome(p, at, solidFrom(await app.bgKernel.run({ op: "gridfinity", baseplate: p, at })));
    },
    remember: (v) => (app.baseplateDefaults = { ...d, ...v }),
  });
}
