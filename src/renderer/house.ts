/**
 * Help → House: an L-shaped house — a long main block and a front wing, both with gable roofs that
 * meet in valleys — with a chimney, hollowed out (open at the bottom), with a door and a window cut
 * through the front wall (see tutorials.ts).
 */
import { booleanOp, edgeBetween, makeBox, moveEdges, shellSolid, splitFaceByLine, translateShape, type Frame, type Solid, type V3 } from "./kernel";
import type { Body, Doc } from "./document";
import { GROUND, addSolid, faceWith, replaceShape as replace, roleBody as body, type TutCtx, type Tutorial } from "./tutorials";

/** The house's front wall (looking from the front view, Num 1): outward normal −Y, its "up" is +Z. */
const FRONT: Frame = { origin: [0, 0, 0], x: [1, 0, 0], y: [0, 0, 1], z: [0, -1, 0] };

// Sizes (mm). The main block is centred on the origin; the wing stands in front of its left end.
const MAIN_L = 160, MAIN_D = 70, WALL_H = 40, RIDGE = 25;
const WING_W = 70;
const DOOR_W = 16, DOOR_H = 30, DOOR_X = 18;
const WIN_W = 18, WIN_H = 14, WIN_X = 52;
/** Wall thickness (Shell). */
const WALL = 3;
const CHIMNEY = 8, CHIMNEY_H = 72, CHIMNEY_X = 58, CHIMNEY_Y = 14;

const FRONT_Y = -MAIN_D / 2;
/**
 * The wing is drawn in front of the main block (x from its left end, y from its front wall), then
 * moves back WING_BACK into it, so its roof runs into the main roof (where the valleys form) — and
 * still sticks out WING_OUT in front.
 */
const WING_OUT = 60, WING_BACK = MAIN_D / 2, WING_D = WING_OUT + WING_BACK;
const WING_X0 = -MAIN_L / 2, WING_Y0 = FRONT_Y - WING_D;

/** Divide a block's top face along a line and lift that new edge into a ridge (one commit each). */
function ridgeLine(doc: Doc, ctx: TutCtx, role: string, a: V3, b: V3, label: string): void {
  const h = body(doc, ctx, role);
  replace(doc, h.id, splitFaceByLine(h.shape as Solid, a, b), label);
}
function gable(doc: Doc, ctx: TutCtx, role: string, a: V3, b: V3, label: string): void {
  const h = body(doc, ctx, role);
  const ridge = edgeBetween(h.shape, a, b);
  if (ridge === null) throw new Error("The ridge edge is missing — do the ridge line step first");
  replace(doc, h.id, moveEdges(h.shape as Solid, new Set([ridge]), [0, 0, RIDGE]), label);
}

/** An opening cut through the main front wall: w × h, its bottom-centre at (x, z). */
function opening(doc: Doc, ctx: TutCtx, x: number, z: number, w: number, h: number, label: string): void {
  const house = body(doc, ctx, "house");
  // (from 1 in front of the wall to 1 past its inside)
  const cut = makeBox(FRONT, [x, FRONT_Y - 1, z + h / 2], w, h, -(WALL + 2));
  replace(doc, house.id, booleanOp("subtract", house.shape as Solid, [cut]), label);
}

// The wing's ridge, where it stands before moving back.
const WING_MID_X = WING_X0 + WING_W / 2;
const wingFront: V3 = [WING_MID_X, WING_Y0, WALL_H], wingBack: V3 = [WING_MID_X, FRONT_Y, WALL_H];

export const HOUSE: Tutorial = {
  title: "House",
  steps: [
    {
      title: "Main block",
      how: `<kbd>B</kbd> <kbd>B</kbd> (Box), hover the grid, <kbd>Tab</kbd>: Width <b>${MAIN_L}</b>, Depth <b>${MAIN_D}</b>, Height <b>${WALL_H}</b> → Create.`,
      run(doc, ctx, label) {
        addSolid(doc, ctx, "house", makeBox(GROUND, [0, 0, 0], MAIN_L, MAIN_D, WALL_H), "House", label);
      },
    },
    {
      title: "Main ridge line",
      how: "<b>Divide face</b> (toolbar, next to Measure): click the <b>midpoint</b> of the top's left edge, then of its right edge (midpoints snap). The new edge is selected.",
      run: (doc, ctx, label) => ridgeLine(doc, ctx, "house", [-MAIN_L / 2, 0, WALL_H], [MAIN_L / 2, 0, WALL_H], label),
    },
    {
      title: "Main gable roof",
      how: `With the ridge edge selected: <kbd>G</kbd>, <kbd>Tab</kbd>: ΔZ <b>${RIDGE}</b> → Enter. The top becomes two slopes, with a gable at each end.`,
      run: (doc, ctx, label) => gable(doc, ctx, "house", [-MAIN_L / 2, 0, WALL_H], [MAIN_L / 2, 0, WALL_H], label),
    },
    {
      title: "Front wing",
      how: `<kbd>B</kbd> <kbd>B</kbd>, hold <kbd>Ctrl</kbd> and click the main block's <b>front left</b> bottom corner, move the mouse a little to the front right, <kbd>Tab</kbd>: Width <b>${WING_W}</b>, Depth <b>${WING_D}</b>, Height <b>${WALL_H}</b> → Create. It stands in front of the main block's left end.`,
      run(doc, ctx, label) {
        addSolid(doc, ctx, "wing", makeBox(GROUND, [WING_X0 + WING_W / 2, WING_Y0 + WING_D / 2, 0], WING_W, WING_D, WALL_H), "Wing", label);
      },
    },
    {
      title: "Wing ridge line",
      how: "<b>Divide face</b> again: click the <b>midpoint</b> of the wing's front top edge, then of its back top edge (where it meets the main block).",
      run: (doc, ctx, label) => ridgeLine(doc, ctx, "wing", wingFront, wingBack, label),
    },
    {
      title: "Wing gable roof",
      how: `<kbd>G</kbd>, <kbd>Tab</kbd>: ΔZ <b>${RIDGE}</b> → Enter. Its gable faces the front; at the back it still stands up above the main roof.`,
      run: (doc, ctx, label) => gable(doc, ctx, "wing", wingFront, wingBack, label),
    },
    {
      title: "Push the wing back",
      how: `<kbd>1</kbd> (Solid mode), click the wing, <kbd>Shift</kbd>+<kbd>G</kbd> (Move from point): blue marks show on its corners. Press the mark at the <b>top of its back gable</b> (the back end of its ridge) and start dragging back, then hold <kbd>Ctrl</kbd> (snap) + <kbd>Shift</kbd> (straight along Y) and let go on the <b>main roof's ridge</b>. The wing moves back ${WING_BACK} into the main block (it still sticks out ${WING_OUT} in front), and its roof now runs into the main roof. (Or <kbd>G</kbd>, <kbd>Tab</kbd>: ΔY <b>${WING_BACK}</b>.)`,
      run(doc, ctx, label) {
        const w = body(doc, ctx, "wing");
        replace(doc, w.id, translateShape(w.shape, [0, WING_BACK, 0]), label);
      },
    },
    {
      title: "Join the wing",
      how: "Click the main block, <kbd>Shift</kbd>-click the wing, <kbd>+</kbd> (Union). Where the two roofs meet they form valleys.",
      run(doc, ctx, label) {
        const h = body(doc, ctx, "house"), w = body(doc, ctx, "wing");
        const joined = booleanOp("union", h.shape as Solid, [w.shape as Solid]);
        doc.commit(doc.bodies.filter((b) => b.id !== w.id).map((b) => (b.id === h.id ? ({ ...b, shape: joined } as Body) : b)), label);
      },
    },
    {
      title: "Chimney",
      how: `<kbd>B</kbd> <kbd>B</kbd> on the grid behind the house, <kbd>Tab</kbd>: <b>${CHIMNEY}</b> × <b>${CHIMNEY}</b> × <b>${CHIMNEY_H}</b> → Create. <kbd>7</kbd> (top view), <kbd>G</kbd>: drag it onto the back slope near the right end, just behind the ridge. <kbd>5</kbd>: only its top sticks out of the roof. Click the house, <kbd>Shift</kbd>-click the chimney, <kbd>+</kbd> (Union).`,
      run(doc, ctx, label) {
        const h = body(doc, ctx, "house");
        const chimney = makeBox(GROUND, [CHIMNEY_X, CHIMNEY_Y, 0], CHIMNEY, CHIMNEY, CHIMNEY_H);
        replace(doc, h.id, booleanOp("union", h.shape as Solid, [chimney]), label);
      },
    },
    {
      title: "Hollow it",
      how: `<kbd>2</kbd> (Face mode), <kbd>V</kbd> <kbd>V</kbd> (bottom view), click the house's bottom face, <kbd>H</kbd> (Shell) thickness <b>${WALL}</b> → Enter: walls and roof ${WALL} thick, open at the bottom — the chimney is hollow too. <kbd>5</kbd> back to iso.`,
      run(doc, ctx, label) {
        const h = body(doc, ctx, "house");
        replace(doc, h.id, shellSolid(h.shape as Solid, new Set([faceWith(h.shape, [0, 0, -1])]), WALL), label);
      },
    },
    {
      title: "Door",
      how: `<kbd>B</kbd> <kbd>B</kbd> on the front wall right of the wing, <kbd>Tab</kbd>: Width <b>${DOOR_W}</b>, Depth <b>${DOOR_H}</b>, Height <b>-${WALL + 2}</b> (into the wall, through it) → Create, then <kbd>G</kbd> to sit it on the ground. <kbd>1</kbd>, click the house, <kbd>Shift</kbd>-click the door, <kbd>−</kbd> (Subtract): a doorway into the house.`,
      run: (doc, ctx, label) => opening(doc, ctx, DOOR_X, 0, DOOR_W, DOOR_H, label),
    },
    {
      title: "Window",
      how: `The same to the right of the door: <kbd>Tab</kbd> <b>${WIN_W}</b> × <b>${WIN_H}</b> × <b>-${WALL + 2}</b>, level with the top of the door, then <kbd>−</kbd> (Subtract). Done — <kbd>Ctrl</kbd>+<kbd>S</kbd> to save.`,
      run: (doc, ctx, label) => opening(doc, ctx, WIN_X, DOOR_H - WIN_H, WIN_W, WIN_H, label), // (its top level with the door's)
    },
  ],
};
