# Reddit drafts: r/3Dprinting and r/functionalprint

Check flair + rules on the day (verify). Post with a photo/GIF, not just a link.

## r/3Dprinting

**Title:**

    I made a simple free CAD app for designing print parts on Linux — looking for honest feedback

**Image:** GIF: draw a rectangle → push up → Box from Face → fillet → Export 3MF → open in PrusaSlicer/Bambu Studio. Second image: the printed box.

**Body:**

---

For me the hardest part of 3D printing was never the printer, it was the CAD.
So I've been building YDDD, a small CAD app aimed at simple functional parts.

How it works: draw a rectangle/circle/polygon, push/pull it into a solid, type exact
sizes in mm. Round or chamfer edges, cut holes, resize a hole by "0.2 mm bigger"
for a looser fit, mirror, circular/array copy, raised text (any installed font).
Export 3MF goes straight into Bambu Studio / PrusaSlicer / Cura, and it checks that
your solids are closed before export.

Example: the box with a lid in the picture took me about [N] minutes:
inside outline → Box from Face (2 mm wall, 2 mm bottom, 40 mm deep) → Box Lid with
0.3 mm clearance → 3MF. [replace with your real numbers]

Honest limits: Linux only right now (Windows/mac later), [install: build from source with
npm / .deb on Releases], no history tree, one-person hobby project, free and MIT.

Repo: https://github.com/canoon-gmail/yddd

Questions I'd love answers to:
1. What simple part do you usually design yourself — would it be doable in this?
2. Would you use something like this, or is Tinkercad / Fusion / FreeCAD already fine for you? Why?
3. What one feature would you need before you'd try it (Windows build, more fit/tolerance tools, something else)?

---

## r/functionalprint (lead with the print, not the software)

**Title:**

    Cable storage box + lid (0.3 mm clearance, snug fit) — designed in a little CAD app I'm writing

**Image:** the printed box and lid, in use. Second image: screenshot in YDDD.

**Body:**

---

Needed a box for cables, so I designed one in YDDD, a small free CAD tool I'm building
for Linux (direct modeling: draw, push/pull, exact sizes). Box from Face makes the walls
and bottom from the inside outline, and Box Lid makes a lid with a clearance you choose.

Print: [material, layer height, time]. Fit: [how it came out].
Files: [Printables link with STEP + 3MF].
App: https://github.com/canoon-gmail/yddd

If you design parts like this: what would you want a "make a box with a lid" tool to
do that this doesn't? And what clearance do you use for lids on your printer?

---
