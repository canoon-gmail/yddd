/**
 * Help → Cable Storage Box: an open box with rounded corners and 4 compartments, a lid that fits over it and a
 * raised label on the lid (see tutorials.ts) — made with Box from Face, Box Lid and Text.
 */
import { booleanOp, boxFromFace, boxLid, extrudeFace, makeBox, makeRectFace, makeTextFaces, translateShape, type Solid } from "./kernel";
import type { Body, TextRecord } from "./document";
import { GROUND, addSolid, replaceShape, roleBody, type Tutorial } from "./tutorials";

// Sizes (mm). The box is centred on the origin, standing on the ground, long side along X.
const L = 240, W = 120, H = 60, WALL = 4, CORNER = 8, DIVIDERS = 3;
const IN_L = L - 2 * WALL, IN_W = W - 2 * WALL, IN_H = H - WALL;
/** The inside corners' radius: the outside ones are that + the wall (CORNER). */
const IN_R = CORNER - WALL;
/** Width of each compartment: the inside length less the dividers, shared out evenly (55). */
const BAY = (IN_L - DIVIDERS * WALL) / (DIVIDERS + 1);
/** Centre X of divider `i` (0-based). */
const dividerX = (i: number) => -IN_L / 2 + (i + 1) * BAY + i * WALL + WALL / 2;
// The lid: over the box, its skirt round the outside; a label on it.
const LID = 3, SKIRT = 10, SKIRT_WALL = 2, CLEARANCE = 0.3;
const LABEL = "CABLES", LABEL_H = 16, LABEL_UP = 1.5, LABEL_FONT = "builtin:NotoSans-Bold";

const divider = (i: number): Solid => makeBox(GROUND, [dividerX(i), 0, WALL], WALL, IN_W, IN_H);

export const CABLE_STORAGE_BOX: Tutorial = {
  title: "Cable storage box",
  steps: [
    {
      title: "The inside floor",
      how: `<kbd>A</kbd> (Rectangle), hover the grid, <kbd>Tab</kbd>: Width <b>${IN_L}</b>, Depth <b>${IN_W}</b> → Create. This flat face is the box's <b>inside</b>: the walls grow out from it.`,
      run: (doc, ctx, label) => {
        const b = doc.makeBody(makeRectFace(GROUND, [0, 0, 0], IN_L, IN_W), "Rectangle", "face");
        ctx.set("box", b.id);
        doc.commit([...doc.bodies, b], label);
      },
    },
    {
      title: "Box from Face",
      how: `With the rectangle selected: <b>Macro → Box from Face…</b>, Wall <b>${WALL}</b>, Bottom <b>${WALL}</b>, Inside depth <b>${IN_H}</b>, tick <b>Round vertical edges</b>, Inside radius <b>${IN_R}</b> → Enter. A ${L} × ${W} box with ${WALL} mm walls; the outside corners are R ${CORNER}.`,
      run(doc, ctx, label) {
        const face = roleBody(doc, ctx, "box");
        const box = boxFromFace(face.shape, face.shape.faces[0].hashCode, { wall: WALL, bottom: WALL, height: IN_H, radius: IN_R });
        doc.commit(doc.bodies.map((b) => (b.id === face.id ? ({ ...b, kind: "solid", name: "Box", shape: box } as Body) : b)), label);
      },
    },
    {
      title: "Stand it on the grid",
      how: `The bottom grew <i>down</i> from the floor face. <kbd>G</kbd> (Move), <kbd>Tab</kbd>: ΔZ <b>${WALL}</b> → Enter, then Enter again: the box stands on the grid, ${H} mm tall.`,
      run(doc, ctx, label) {
        const box = roleBody(doc, ctx, "box");
        replaceShape(doc, box.id, translateShape(box.shape, [0, 0, WALL]), label);
      },
    },
    {
      title: "First divider",
      how: `<kbd>B</kbd> <kbd>B</kbd>, hold <kbd>Ctrl</kbd> and click the inside floor at the <b>back left</b>, the point where the back wall's flat inside starts (the round corner ends) — easy to see in the iso view, <kbd>5</kbd>; move the mouse a little into the box, <kbd>Tab</kbd>: Width <b>${WALL}</b>, Depth <b>${IN_W}</b>, Height <b>${IN_H}</b> → Create (flush with the rim). Then <kbd>G</kbd>, <kbd>Tab</kbd>: ΔX <b>${BAY - IN_R}</b> → Enter: the first compartment is ${BAY} mm wide.`,
      run: (doc, ctx, label) => addSolid(doc, ctx, "divider 1", divider(0), "Divider", label),
    },
    {
      title: "More dividers",
      how: `With the divider selected: <kbd>Shift</kbd>+<kbd>D</kbd> (Duplicate), <kbd>Tab</kbd>: ΔX <b>${BAY + WALL}</b> → Enter, then <kbd>Shift</kbd>+<kbd>R</kbd> (Repeat) for the third. Four equal compartments.`,
      run(doc, ctx, label) {
        const made = [1, 2].map((i) => doc.makeBody(divider(i), "Divider"));
        made.forEach((b, k) => ctx.set(`divider ${k + 2}`, b.id));
        doc.commit([...doc.bodies, ...made], label);
      },
    },
    {
      title: "Join into one part",
      how: "<kbd>1</kbd>, click the box, <kbd>Shift</kbd>-click the three dividers, <kbd>+</kbd> (Union).",
      run(doc, ctx, label) {
        const box = roleBody(doc, ctx, "box");
        const divs = [1, 2, 3].map((i) => roleBody(doc, ctx, `divider ${i}`));
        const joined = booleanOp("union", box.shape as Solid, divs.map((d) => d.shape as Solid));
        const gone = new Set(divs.map((d) => d.id));
        doc.commit(doc.bodies.filter((b) => !gone.has(b.id)).map((b) => (b.id === box.id ? ({ ...b, name: "Cable box", shape: joined } as Body) : b)), label);
      },
    },
    {
      title: "A lid over it",
      how: `With the box selected: <b>Macro → Box Lid → Over the Box…</b>, Lid thickness <b>${LID}</b>, Skirt depth <b>${SKIRT}</b>, Skirt wall <b>${SKIRT_WALL}</b>, Clearance <b>${CLEARANCE}</b> (room to slide on after printing) → Enter. It's made closed on the box.`,
      run(doc, ctx, label) {
        const box = roleBody(doc, ctx, "box");
        addSolid(doc, ctx, "lid", boxLid(box.shape as Solid, { over: true, thickness: LID, lipDepth: SKIRT, lipWall: SKIRT_WALL, clearance: CLEARANCE }), "Lid", label);
      },
    },
    {
      title: "A label on the lid",
      how: `<kbd>T</kbd> (Text), click the lid's top a little <b>below its middle</b>, type <b>${LABEL}</b>, Font <b>Noto Sans (built in)</b> Style <b>Bold</b>, Height <b>${LABEL_H}</b>, Align <b>Center</b> → Enter. Then <kbd>P</kbd> (Push/Pull) <b>${LABEL_UP}</b> → Enter: raised letters.`,
      run(doc, ctx, label) {
        const lid = roleBody(doc, ctx, "lid");
        const top = lid.shape.boundingBox.bounds[1][2];
        const text: TextRecord = { text: LABEL, font: LABEL_FONT, height: LABEL_H, align: "center", letterSpacing: 0, lineSpacing: 1, frame: { ...GROUND, origin: [0, -LABEL_H / 2, top] } };
        const letters = makeTextFaces(text.frame, text.frame.origin, LABEL, text).map((f) => ({ ...doc.makeBody(extrudeFace(f, f.faces[0].hashCode, LABEL_UP), "Text"), group: `Text "${LABEL}"`, text }));
        letters.forEach((b, k) => ctx.set(`letter ${k}`, b.id));
        ctx.set("letters", letters.length);
        doc.commit([...doc.bodies, ...letters], label);
      },
    },
    {
      title: "Join the label to the lid",
      how: `<kbd>1</kbd>, click the lid, <kbd>Shift</kbd>-click the <b>Text "${LABEL}"</b> row in the Bodies panel, <kbd>+</kbd> (Union). Done — <kbd>Ctrl</kbd>+<kbd>S</kbd> to save, File → Export STL to print (turn the lid upside down in the slicer).`,
      run(doc, ctx, label) {
        const lid = roleBody(doc, ctx, "lid");
        const letters = Array.from({ length: ctx.get("letters") ?? 0 }, (_, k) => roleBody(doc, ctx, `letter ${k}`));
        const joined = booleanOp("union", lid.shape as Solid, letters.map((b) => b.shape as Solid));
        const gone = new Set(letters.map((b) => b.id));
        doc.commit(doc.bodies.filter((b) => !gone.has(b.id)).map((b) => (b.id === lid.id ? ({ ...b, name: "Cable box lid", shape: joined } as Body) : b)), label);
      },
    },
  ],
};
