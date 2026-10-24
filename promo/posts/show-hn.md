# Show HN draft

**Title** (max 80 chars):

    Show HN: YDDD – a small direct-modeling CAD for Linux, for 3D-print parts

**URL:** https://github.com/canoon-gmail/yddd

**Text** (first comment, or the post body if text post):

---

Hi HN, I'm a hobbyist and I've been building a simple 3D CAD app for my own 3D prints,
because Fusion 360 doesn't run on Linux and I kept bouncing off FreeCAD's learning curve
for small parts like boxes, lids and brackets.

YDDD is direct modeling: draw a rectangle or circle, push/pull it, type exact sizes,
fillet edges, export 3MF for the slicer. No history tree, no constraints to set up first.

Something concrete: a cable storage box with a fitting lid is about [N] steps —
draw the inside outline, Macro → Box from Face (wall, bottom, depth), Box Lid with a
clearance, Export 3MF. [Time it honestly before posting: "about N minutes".]

Tech, for the curious:
- Electron + TypeScript, Three.js viewport
- OpenCascade compiled to WebAssembly (via replicad), so models are exact B-rep, STEP in/out
- Slow ops (fillet, shell, heavy booleans, export) run in a second OpenCascade in a Web Worker so the UI stays live and Esc cancels
- Face/edge picking maps tessellated triangles back to B-rep topology via shape hashes
- An end-to-end smoke test drives the real app with scripted mouse input

Honest limits: Linux only for now, you build it from source (npm install && npm start)
[or: a .deb on the Releases page], no parametric history, no assemblies/constraints,
one developer. MIT licensed (OpenCascade itself is LGPL-2.1).

What I'd really like to hear:
1. If you design parts for printing: what's the first part you'd try, and where did it get stuck?
2. Is "no history tree" a dealbreaker for you, or a relief?
3. For those who've used OpenCascade in wasm: any tips on memory / boolean robustness?

---

Notes:
- Post Tue–Thu ~13:00–15:00 UTC. Stay in the thread for a few hours.
- Don't ask anyone to upvote. Don't repost if it sinks; HN allows a later repost after big changes.
- Keep replies short and factual; thank critics, say what you'll change.
