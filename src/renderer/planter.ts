/**
 * Help → Planter: a tapered square planter — 300 square at the top, 220 at the bottom, 450 high —
 * hollow with an open top and a drainage hole (see tutorials.ts). The taper: a 220 square pulled up by its
 * centre dot with a 300 mm top.
 */
import { booleanOp, makeCylinder, makeRectFace, pullToPoint, shellSolid, type Frame, type Solid } from "./kernel";
import type { Body } from "./document";
import { GROUND, faceWith, replaceShape as replace, roleBody as body, type Tutorial } from "./tutorials";

/** The bottom face's frame (looking up from below): outward normal −Z. */
const BOTTOM: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] };

// Sizes (mm), centred on the origin.
const TOP = 300, BASE = 220, HEIGHT = 450, WALL = 30, HOLE_R = 15;

export const PLANTER: Tutorial = {
  title: "Planter",
  steps: [
    {
      title: "Base",
      how: `<kbd>A</kbd> (Rectangle), hover the grid at the middle, <kbd>Tab</kbd>: Width <b>${BASE}</b>, Depth <b>${BASE}</b> → Create: a flat ${BASE} square, the planter's bottom.`,
      run(doc, ctx, label) {
        const b = doc.makeBody(makeRectFace(GROUND, [0, 0, 0], BASE, BASE), "Planter", "face");
        ctx.set("planter", b.id);
        doc.commit([...doc.bodies, b], label);
      },
    },
    {
      title: "Flare it up",
      how: `The square is still selected, with a white dot in its middle: click the <b>dot</b>, <kbd>G</kbd> — in the panel Height <b>${HEIGHT}</b>, Top size <b>${TOP}mm</b> → Enter. It becomes a solid ${HEIGHT} high that widens to ${TOP} × ${TOP} at the top: all four sides lean out at once.`,
      run(doc, ctx, label) {
        const p = body(doc, ctx, "planter");
        const solid = pullToPoint(p.shape, p.shape.faces[0].hashCode, HEIGHT, TOP / BASE);
        doc.commit(doc.bodies.map((b) => (b.id === p.id ? ({ ...b, kind: "solid", shape: solid } as Body) : b)), label);
      },
    },
    {
      title: "Hollow it",
      how: `<kbd>2</kbd> (Face mode), click the <b>top</b> face, <kbd>H</kbd> (Shell) thickness <b>${WALL}</b> → Enter: open at the top, walls and floor ${WALL} thick (the walls follow the taper).`,
      run(doc, ctx, label) {
        const p = body(doc, ctx, "planter");
        replace(doc, p.id, shellSolid(p.shape as Solid, new Set([faceWith(p.shape, [0, 0, 1])]), WALL), label);
      },
    },
    {
      title: "Drainage hole",
      how: `<kbd>V</kbd> <kbd>V</kbd> (bottom view), <kbd>B</kbd> <kbd>C</kbd> (Cylinder): click the <b>centre</b> of the bottom face (it snaps), radius <b>${HOLE_R}</b> Enter, height <b>-${WALL + 10}</b> Enter (up through the floor). <kbd>1</kbd>, click the planter, <kbd>Shift</kbd>-click the cylinder, <kbd>−</kbd> (Subtract). <kbd>5</kbd> back to iso. Done — <kbd>Ctrl</kbd>+<kbd>S</kbd> to save.`,
      run(doc, ctx, label) {
        const p = body(doc, ctx, "planter");
        const drill = makeCylinder(BOTTOM, [0, 0, 0], HOLE_R, -(WALL + 10));
        replace(doc, p.id, booleanOp("subtract", p.shape as Solid, [drill]), label);
      },
    },
  ],
};
