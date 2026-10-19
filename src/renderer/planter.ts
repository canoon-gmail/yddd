/**
 * Help → Planter: a tapered square planter — 300 square at the top, 220 at the bottom, 450 high —
 * hollow with an open top and a drainage hole (see tutorials.ts).
 */
import { booleanOp, edgeBetween, makeBox, makeCylinder, moveEdges, shellSolid, type Frame, type Solid, type V3 } from "./kernel";
import type { Doc } from "./document";
import { GROUND, addSolid, faceWith, replaceShape as replace, roleBody as body, type TutCtx, type Tutorial } from "./tutorials";

/** The bottom face's frame (looking up from below): outward normal −Z. */
const BOTTOM: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, -1, 0], z: [0, 0, -1] };

// Sizes (mm), centred on the origin.
const TOP = 300, BASE = 220, HEIGHT = 450, WALL = 30, HOLE_R = 15;
const IN = (TOP - BASE) / 2;
const T = TOP / 2, B = BASE / 2;

/** Move one bottom edge (from a to b, where it is now) by v. */
function moveBottomEdge(doc: Doc, ctx: TutCtx, a: V3, b: V3, v: V3, label: string): void {
  const p = body(doc, ctx, "planter");
  const e = edgeBetween(p.shape, a, b);
  if (e === null) throw new Error("That bottom edge isn't where this step expects — go Back or start again");
  replace(doc, p.id, moveEdges(p.shape as Solid, new Set([e]), v), label);
}

/** "G, drag it a little inward, Tab: …" for one bottom edge. */
const how = (side: string, d: string) =>
  `<kbd>3</kbd> (Edge mode), click the <b>${side}</b> bottom edge, <kbd>G</kbd> and drag the gizmo a little inward, then <kbd>Tab</kbd> (it shows that drag): ${d} → Move — exactly ${IN} in, whatever you dragged.`;

export const PLANTER: Tutorial = {
  title: "Planter",
  steps: [
    {
      title: "Block",
      how: `<kbd>B</kbd> <kbd>B</kbd> (Box), hover the grid, <kbd>Tab</kbd>: Width <b>${TOP}</b>, Depth <b>${TOP}</b>, Height <b>${HEIGHT}</b> → Create.`,
      run(doc, ctx, label) {
        addSolid(doc, ctx, "planter", makeBox(GROUND, [0, 0, 0], TOP, TOP, HEIGHT), "Planter", label);
      },
    },
    {
      title: "Taper the front",
      how: how("front", `ΔX <b>0</b>, ΔY <b>${IN}</b>, ΔZ <b>0</b>`) + " The front leans in; it stays one flat face.",
      run: (doc, ctx, label) => moveBottomEdge(doc, ctx, [-T, -T, 0], [T, -T, 0], [0, IN, 0], label),
    },
    {
      title: "Taper the back",
      how: how("back", `ΔX <b>0</b>, ΔY <b>-${IN}</b>, ΔZ <b>0</b>`),
      run: (doc, ctx, label) => moveBottomEdge(doc, ctx, [-T, T, 0], [T, T, 0], [0, -IN, 0], label),
    },
    {
      title: "Taper the left",
      how: how("left", `ΔX <b>${IN}</b>, ΔY <b>0</b>, ΔZ <b>0</b>`),
      run: (doc, ctx, label) => moveBottomEdge(doc, ctx, [-T, -B, 0], [-T, B, 0], [IN, 0, 0], label),
    },
    {
      title: "Taper the right",
      how: how("right", `ΔX <b>-${IN}</b>, ΔY <b>0</b>, ΔZ <b>0</b>`) + ` The bottom is now ${BASE} × ${BASE}.`,
      run: (doc, ctx, label) => moveBottomEdge(doc, ctx, [T, -B, 0], [T, B, 0], [-IN, 0, 0], label),
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
