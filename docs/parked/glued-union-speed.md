# Parked: a faster union of solids that touch exactly on a face

Parked on 2026-11-25. Two solids sharing a face exactly (two mirrored halves meeting on x = 0) union through `gluedUnion`
in `src/renderer/kernel.ts`: right, but slower than the same solids overlapped a little (0.01–0.2 mm), which skips the
checks round the glued fuse. Overlapping is the advice for now.

Not timed (heavy runs freeze the desktop): what follows is from the steps traced on the user's halves (`~/test.yddd`,
2026-11-25: two 16-face halves of a capsule-like solid, each with a sphere face).

## Where the time goes (exact touch)

1. Every face pair compared (area, centre, corners).
2. Both solids copied, glued fuse, faces merged.
3. On the halves the merge broke the result: the fuse run again without it (cheap here — a glued fuse skips intersecting
   faces).
4. Validity check, three volumes.
5. **`pointsOutside`: both solids copied again and meshed at full display quality** (a sphere face: slow).
6. **Ray test:** up to ~600 points of one solid against every triangle of the other, both ways round.

## Ideas, in order

### 1. Mesh reuse in `gluedUnion` (step 5) — DONE, careful: can cause another bug

`pointsOutside` meshes the solids it's given (`tessellate`), and a meshed solid can fail OpenCascade's check (the halves:
the sphere face and two flat faces invalid once meshed, tolerances unchanged — the check reacts to the mesh), as does
everything made from it. `booleanOp` retries on mesh-free copies for that reason, so `gluedUnion` now meshes its own
copies (2026-11-25). The idea: skip those copies when a solid already has its display mesh (a real body on the first try).

Why it's risky:
- **Partly meshed solids:** heavy faces are meshed separately (`meshFaces`, `whole` false), so a body can lack a mesh on
  some faces. Counted as "meshed", `pointsOutside` would mesh the rest in place — on one of `booleanOp`'s mesh-free copies
  that brings back the spoilt-input bug (every later try broken). Only "every face has a triangulation" may count.
- **Background-kernel meshes:** kept in `meshedElsewhere`, not on the solid — OpenCascade sees no mesh; must still copy.
- **Which solid is which:** `gluedUnion` is reached from the first try (real bodies) and from the copy / swap / sphere
  retries (copies). A wrong guess silently breaks unions again, and only on some shapes — hard to notice.

**Done 2026-11-25** (`displayMeshed`): a solid is used as it is if its display mesh was made in the background kernel, or
if every face but the linear-extrusion ones (meshed as stand-ins, never in place) has a triangulation; otherwise copied.
"Every face" alone would never have held — the halves have two extrusion faces. Checked on `~/test.yddd`: meshed bodies
reused (no copies), mesh-free solids copied, the same union both ways, a subtract after it still right; `half` passed.
If unions start failing on some shapes again, suspect this first.

### 2. A grid for the ray test (step 6) — safe, same answers

Cheap on the halves (their boxes barely overlap: most points dropped by the box check), costly when one solid sits inside
the other's box and that one has many triangles (a handle on a cup's side: ~600 × 20 000 × 2 ≈ 24 M triangle tests,
~0.5–1 s). The ray always goes along `D`: sort the other solid's triangles once into a 2D grid seen along `D`, each point
tests only its cell's triangles. Fewer points (200) would be simpler but could miss a small crossing.

### 3. The merge rerun (step 3) — leave unless a slow case shows up

Only when `SimplifyResult` breaks a result (it also spoils the unmerged one in place — no clean copy to fall back to, so the
boolean runs again without merging). Cheap on the glued path; on the plain path a full boolean again (seconds on threads).
Fix if it ever shows: merge a copy of the result (`ShapeUpgrade_UnifySameDomain` on a `deepCopy`) instead of rerunning.
