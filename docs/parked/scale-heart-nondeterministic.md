# Scale Y on a heart: a second one in the same session can stick

Found 2026-11-26 while scripting hearts (Hull → Mirror → Union → Fillet R 9 on the crease → Scale Y 60 %).

- Each heart alone (a fresh app): Scale Y in ~2.3 s, valid — the cut-in-half fallback (stretchInHalves) cuts across X
  (the mirror plane) and each half stretches.
- Two hearts in one session (X 5.5, then X 4.5): for the second, the X cut fails at once (it worked alone), the Y cut is
  tried, its halves go deep into stretchCurved's own halving (depth 4) and then hang for 40 s+ (the renderer idle by
  then — maybe a promise / the face repair; not found).
- So OpenCascade answers differently for the same shape depending on what ran before (likely order by memory address).
- In the app an uneven Scale of curved solids runs in the background kernel with Stop, so the window doesn't freeze.

Also seen: Union of the two Hull halves refused ("left part of a solid out … edge to edge") at lobe X 5 and 5.01
(sphere R 10, tip R 1.5 at Z −22); fine at 4.5, 5.02, 5.5, 6.

To look at: why the X cut fails the second time (splitByPlane on the exact mirror plane through the fillet's middle —
try cutting a hair off it); a time / depth budget for the Y fallback; the Union refusal at X 5.
