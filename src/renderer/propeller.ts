/**
 * Help → Propeller: an 80 mm 3-blade propeller (see tutorials.ts) — a hub, one blade swept from a slot-shaped
 * profile along a straight path with Twist (45° at the root → 15° at the tip) and End size (narrower to the
 * tip), copied round the hub (Circular copy), joined, a shaft hole through.
 */
import { booleanOp, makeCylinder, rotateShape, sketchFaces, sketchPath, sweepFace, type Solid, type V3 } from "./kernel";
import type { Body } from "./document";
import { GROUND, roleBody as body, type Tutorial } from "./tutorials";

// Sizes (mm). The hub is centred on the origin (half above, half below the grid), the blades leave it along X.
const HUB_R = 7, HUB_H = 10, SHAFT_R = 1.5;
/** The blade's profile: a CHORD × THICK slot (a rectangle with Round corner R = half its thickness), drawn off to the side. */
const CHORD = 12, THICK = 2, PROFILE_Y = -30;
/** The path: from inside the hub (the blade's root fuses into it) out to the tip. */
const ROOT_X = 4, TIP_X = 40;
/** The blade's angle at the root, the twist to the tip (45° → 15°), the tip's size. */
const PITCH = 45, TWIST = 30, TIP_SIZE = 60;
const BLADES = 3;

export const PROPELLER: Tutorial = {
  title: "Propeller",
  steps: [
    {
      title: "The hub",
      how: `<kbd>B</kbd> <kbd>C</kbd> (Cylinder): click the <b>origin</b> (where the red and green axes cross), radius <b>${HUB_R}</b> Enter, height <b>${HUB_H}</b> Enter. Then <kbd>G</kbd> (Move), <kbd>Tab</kbd>: ΔZ <b>${-HUB_H / 2}</b> → Enter, Enter again: the hub sits half above, half below the grid — the blades will run out of its middle.`,
      run(doc, ctx, label) {
        const b = doc.makeBody(makeCylinder(GROUND, [0, 0, -HUB_H / 2], HUB_R, HUB_H), "Hub");
        ctx.set("hub", b.id);
        doc.commit([...doc.bodies, b], label);
      },
    },
    {
      title: "The blade's profile",
      how: `<kbd>Esc</kbd> (nothing selected), <kbd>K</kbd> (Sketch on the ground), <kbd>R</kbd> (Rectangle): type <b>${-CHORD / 2},${PROFILE_Y - THICK / 2}</b> Enter (its first corner), then <b>${CHORD},${THICK}</b> Enter: a ${CHORD} × ${THICK} rectangle beside the hub. <kbd>F</kbd> (Round corner): type <b>${THICK / 2}</b> Enter, click <b>inside</b> the rectangle (all 4 corners), the box's <b>Done</b>: round ends, the blade's cross-section. The panel's <b>Done</b>: a flat face.`,
      run(doc, ctx, label) {
        const y0 = PROFILE_Y - THICK / 2, y1 = PROFILE_Y + THICK / 2, x0 = -CHORD / 2 + THICK / 2, x1 = CHORD / 2 - THICK / 2, r = THICK / 2, k = r * (1 - Math.SQRT1_2);
        const p = (x: number, y: number): V3 => [x, y, 0];
        const [face] = sketchFaces({ kind: "path", segs: [
          { kind: "line", a: p(x0, y0), b: p(x1, y0) },
          { kind: "arc", a: p(x1, y0), m: p(x1 + r - k, y0 + k), b: p(x1 + r, PROFILE_Y) },
          { kind: "arc", a: p(x1 + r, PROFILE_Y), m: p(x1 + r - k, y1 - k), b: p(x1, y1) },
          { kind: "line", a: p(x1, y1), b: p(x0, y1) },
          { kind: "arc", a: p(x0, y1), m: p(x0 - r + k, y1 - k), b: p(x0 - r, PROFILE_Y) },
          { kind: "arc", a: p(x0 - r, PROFILE_Y), m: p(x0 - r + k, y0 + k), b: p(x0, y0) },
        ] }, [], [0, 0, 1]);
        const b = doc.makeBody(face, "Blade profile", "face");
        ctx.set("blade", b.id);
        doc.commit([...doc.bodies, b], label);
      },
    },
    {
      title: "The blade's path",
      how: `<kbd>K</kbd> again, <kbd>L</kbd> (Line): type <b>${ROOT_X},0</b> Enter (inside the hub), then <b>${TIP_X - ROOT_X},0</b> Enter (${TIP_X - ROOT_X} mm along X), <kbd>Enter</kbd> (left open: a path). The panel's <b>Done</b>. The blade will run along it, out to ${TIP_X} mm from the centre: an ${2 * TIP_X} mm propeller.`,
      run(doc, ctx, label) {
        const b = doc.makeBody(sketchPath([{ kind: "line", a: [ROOT_X, 0, 0], b: [TIP_X, 0, 0] }]), "Path", "path");
        ctx.set("path", b.id);
        doc.commit([...doc.bodies, b], label);
      },
    },
    {
      title: "Sweep a twisted blade",
      how: `<b>Push/Pull ▾ → Sweep</b>: click the profile, then the path. In the panel: Turn profile <b>${PITCH}</b>, Twist <b>${TWIST}</b>, End size <b>${TIP_SIZE}</b> → Enter. The profile moves onto the path's end inside the hub, tilted ${PITCH}°, and turns evenly on the way out — ${PITCH - TWIST}° at the tip, like a real propeller blade — getting narrower (${TIP_SIZE}%) as it goes.`,
      run(doc, ctx, label) {
        const prof = body(doc, ctx, "blade"), path = doc.get(ctx.get("path") ?? -1);
        if (!path || path.kind !== "path") throw new Error("The path is missing — go Back or start again");
        const blade = sweepFace(prof.shape, prof.shape.faces[0].hashCode, path.shape, true, false, PITCH, 1, TWIST, TIP_SIZE / 100);
        doc.commit(doc.bodies.map((b) => (b.id === prof.id ? ({ ...b, kind: "solid", name: "Blade", shape: blade } as Body) : b)), label);
      },
    },
    {
      title: "Three blades",
      how: `<kbd>1</kbd> (Solid mode), click the blade. <b>Push/Pull ▾ → Circular copy</b>: Copies <b>${BLADES}</b>, Total angle <b>360</b>, Axis <b>Z axis</b> → Enter: ${BLADES} blades evenly round the hub.`,
      run(doc, ctx, label) {
        const blade = body(doc, ctx, "blade");
        const copies = Array.from({ length: BLADES - 1 }, (_, i) => doc.makeBody(rotateShape(blade.shape, ((i + 1) * 360) / BLADES, [0, 0, 0], [0, 0, 1]), "Blade"));
        copies.forEach((b, i) => ctx.set(`blade ${i + 2}`, b.id));
        doc.commit([...doc.bodies, ...copies], label);
      },
    },
    {
      title: "Join into one part",
      how: `Click the hub, <kbd>Shift</kbd>-click the ${BLADES} blades, <kbd>+</kbd> (Union). Then click the path (or its row in the Bodies panel) and <kbd>Del</kbd>: it's done its job.`,
      run(doc, ctx, label) {
        const hub = body(doc, ctx, "hub");
        const blades = [body(doc, ctx, "blade"), ...Array.from({ length: BLADES - 1 }, (_, i) => body(doc, ctx, `blade ${i + 2}`))];
        const joined = booleanOp("union", hub.shape as Solid, blades.map((b) => b.shape as Solid));
        const gone = new Set([...blades.map((b) => b.id), ctx.get("path")]);
        doc.commit(doc.bodies.filter((b) => !gone.has(b.id)).map((b) => (b.id === hub.id ? ({ ...b, name: "Propeller", shape: joined } as Body) : b)), label);
      },
    },
    {
      title: "Shaft hole",
      how: `<kbd>B</kbd> <kbd>C</kbd>: click the <b>centre</b> of the hub's top (it snaps), radius <b>${SHAFT_R}</b> Enter, height <b>${-(HUB_H + 2)}</b> Enter (down through the hub). <kbd>1</kbd>, click the propeller, <kbd>Shift</kbd>-click the cylinder, <kbd>−</kbd> (Subtract): a ${2 * SHAFT_R} mm hole for the motor shaft. Done — <kbd>Ctrl</kbd>+<kbd>S</kbd> to save, File → Export 3MF to print (supports under the blades).`,
      run(doc, ctx, label) {
        const p = body(doc, ctx, "hub");
        const drill = makeCylinder(GROUND, [0, 0, -HUB_H / 2 - 1], SHAFT_R, HUB_H + 2);
        doc.commit(doc.bodies.map((b) => (b.id === p.id ? ({ ...b, shape: booleanOp("subtract", p.shape as Solid, [drill]) } as Body) : b)), label);
      },
    },
  ],
};
