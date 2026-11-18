# Parked: Push/Pull timing on a labelled face

Asked on 2026-11-14 — in `~/test.yddd` (Solid 1, one free-form solid) a label reads **"push/pull this face and check time"**,
its arrow at (45.97, 5.94, 8.58). Skipped, not run: timing it means opening the model and running the bench, and that can
freeze the user's machine. Some operations we just don't do; this waits until it can be run without the freeze.

## What it would measure

On the face nearest the label's arrow tip (found from the display mesh: the closest triangle):
- the kernel alone: `pushPull` by 5 mm and by −1 mm (median of 3);
- as the user does it: key P → the panel on screen → the first preview; typed 5 and −1 (instant or exact preview);
  Apply (−1 mm); the result's validity; then undone.

Earlier numbers to compare with: a gear's pocket floor (203 faces) — ~0.13 s per typed value, Apply ~1.7 s.

## To run it

1. `src/main/bench.ts`, in `OPS`, after the "F on its first solid" block (after its `app.cancelOp(); }`): the code below.
2. `YDDD_BENCH_FILE=~/test.yddd npm run bench:ops` — rows `label` / `pushpull`. Threads off by default; `YDDD_THREADS=16`
   for full speed.
3. Any model works: put a label (Shift+=) with its arrow on the face to time.

```js
      // A label in the model points at a face: Push/Pull it (key P, a typed 5 and -1, Apply) — the face nearest its arrow's tip
      const near = (p, a, b, c) => { // closest point on triangle abc to p (Ericson), its distance
        const sub = (u, v) => [u[0] - v[0], u[1] - v[1], u[2] - v[2]], dot = (u, v) => u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
        const at = (s, t) => [a[0] + s * ab[0] + t * ac[0], a[1] + s * ab[1] + t * ac[1], a[2] + s * ab[2] + t * ac[2]];
        const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a), d1 = dot(ab, ap), d2 = dot(ac, ap);
        let q;
        if (d1 <= 0 && d2 <= 0) q = a;
        else {
          const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp), cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp);
          const vc = d1 * d4 - d3 * d2, vb = d5 * d2 - d1 * d6, va = d3 * d6 - d5 * d4;
          if (d3 >= 0 && d4 <= d3) q = b;
          else if (d6 >= 0 && d5 <= d6) q = c;
          else if (vc <= 0 && d1 >= 0 && d3 <= 0) q = at(d1 / (d1 - d3), 0);
          else if (vb <= 0 && d2 >= 0 && d6 <= 0) q = at(0, d2 / (d2 - d6));
          else if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / (d4 - d3 + d5 - d6); q = [b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2])]; }
          else { const den = 1 / (va + vb + vc); q = at(vb * den, vc * den); }
        }
        return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
      };
      for (const lab of (app.doc.dimensions || []).filter((d) => d.kind === "label")) {
        let best = null;
        for (const s of solids) {
          const m = K.tessellate(s.shape).faces, V = m.vertices, T = m.triangles, v = (i) => [V[3 * i], V[3 * i + 1], V[3 * i + 2]];
          for (const g of m.faceGroups) for (let k = g.start; k < g.start + g.count; k += 3) {
            const dist = near(lab.a, v(T[k]), v(T[k + 1]), v(T[k + 2]));
            if (!best || dist < best.dist) best = { dist, s, faceId: g.faceId };
          }
        }
        const title = '"' + lab.text + '"';
        if (!best) { rows.push({ group: "label", name: title, error: "no solid face near it" }); continue; }
        const { s, faceId } = best, info = K.faceInfo ? (() => { try { return K.faceInfo(s.shape, faceId); } catch { return null; } })() : null;
        rows.push({ group: "label", name: title + " → " + s.name + " face " + faceId + " (" + best.dist.toFixed(2) + " mm off" + (info && info.type ? ", " + info.type : "") + "; " + s.shape.faces.length + " faces)", ms: 0 });
        for (const d of [5, -1]) bench("pushpull", "  kernel pushPull " + d + " mm", () => K.pushPull(s.shape, faceId, d), 3);
        app.setMode("face");
        app.setSelection([{ kind: "face", body: s.id, id: faceId }]);
        let t = performance.now();
        app.run("op.pushpull");
        rows.push({ group: "pushpull", name: "  key P → the panel on screen", ms: +(performance.now() - t).toFixed(1) });
        await new Promise((r) => setTimeout(r, 50));
        while (app.op && !app.op.result) await new Promise((r) => setTimeout(r, 5));
        rows.push({ group: "pushpull", name: "  … and the first preview shown", ms: +(performance.now() - t).toFixed(1) });
        for (const d of [5, -1]) {
          const inp = app.op && app.op.inputs.find((i) => i.dataset.key === "d");
          if (!inp) break;
          inp.value = String(d);
          t = performance.now();
          const res = app.previewOp();
          rows.push({ group: "pushpull", name: "  typed " + d + " → preview" + (res && res.drawn ? " (instant)" : " (exact)"), ms: +(performance.now() - t).toFixed(1) });
        }
        t = performance.now();
        await app.applyOpWhenReady();
        rows.push({ group: "pushpull", name: "  Apply (-1 mm)", ms: +(performance.now() - t).toFixed(1) });
        const after = app.doc.get(s.id);
        if (after && after.shape !== s.shape) { rows.push({ group: "pushpull", name: "  result", ms: 0, valid: K.isValidShape(after.shape) }); app.doc.undo(); }
        else rows.push({ group: "pushpull", name: "  Apply", error: "not applied" });
        app.setMode("body");
      }
```
