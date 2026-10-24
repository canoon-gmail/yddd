# Reply guide

Principles: thank first, be short, be honest about limits, never argue, never
trash other tools. Turn every complaint into a question ("what would you need?")
and write it down in a feedback list. If you fix it, come back and reply "fixed in <commit>".

## "Why not FreeCAD?"

> FreeCAD is great and far more capable — I use/respect it. YDDD is for the person who
> wants a box, bracket or name tag in a few minutes without learning workbenches,
> sketches with constraints and a history tree. If you're happy in FreeCAD, keep using it!
> (Under the hood both use OpenCascade, so STEP files move between them.)

## "Why not Fusion 360 / Onshape / Shapr3D?"

> Fusion doesn't run on Linux, and its free tier has rules that change. Onshape runs in a
> browser and is excellent, but your files live in their cloud (free plan = public docs).
> YDDD is local, offline, free and MIT. It's much smaller — no assemblies, no drawings.

## "Why not Tinkercad?"

> Tinkercad is the closest in spirit — simple. YDDD adds exact sizes typed in, fillets,
> real B-rep geometry (STEP export), offline use, and tools for print fits (hole resize,
> lid clearance).

## "Why not OpenSCAD / CadQuery / build123d?"

> Those are great if you like code. YDDD is for people who want to click and drag.
> (It's built on replicad, which is a code-CAD library, just with a GUI on top.)

## "Windows? Mac?"

> Not yet — it's Electron so it should port, but I haven't built or tested it. It's the
> next thing on my list. Would you test a Windows build if I post one? [collect names]

## "Electron for CAD? Heavy / slow."

> Fair concern. The geometry runs in OpenCascade (WebAssembly), heavy ops in a worker,
> and the viewport is Three.js/WebGL. Startup/RAM: [give real numbers: ~X MB, Y s start].
> If something feels slow, tell me what you did and I'll profile it.

## "No history / parametric? That's a dealbreaker."

> Understood — for many parts it is. YDDD is direct modeling on purpose (like SketchUp or
> Shapr3D): you change the shape itself, e.g. push a face or resize a hole after the fact.
> What change would you want to make later that you'd miss history for? That tells me what to add.

## "License?"

> MIT for YDDD. It bundles OpenCascade (compiled to wasm), which is LGPL-2.1; replicad and
> Three.js are MIT. [Make sure the LICENSE file is in the repo before posting.]

## "Is this AI-generated / vibe-coded?"

> Answer honestly about how it was made (including any AI-assisted coding). Point to the
> automated end-to-end test (npm run smoke) and that it's used for real prints.

## "Will it stay free? Business model?"

> It's a hobby project, MIT, no account, no telemetry. [Only say "no telemetry" if true — check.]

## "How do I install it?" / "npm install failed"

> Sorry! Which distro and Node version? Please open an issue with the error output.
> [Link Releases/AppImage if available.]

## "It crashed / my fillet failed"

> Thanks — could you send the .yddd file (File → Save) or the STEP and what you clicked?
> Fillets that are too big are left sharp and the panel offers the largest size that works;
> if it's not that, it's a bug I want.

## "Feature X is missing" (constraints, assemblies, threads, drawings...)

> Good to know — is it for a specific part? A picture of what you want to make helps me
> decide what to build next.

## Rude / dismissive comments

Don't reply, or reply once: "Fair enough, thanks for looking." Move on.

## Things not to say

- Don't promise dates (Windows "next week").
- Don't claim it's better than FreeCAD/Fusion.
- Don't ask for upvotes or stars.
