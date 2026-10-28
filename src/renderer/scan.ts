/**
 * Sketch → Scan: a picture's grey levels in an area turned into lines. Works on a grid of grey values (0 = black,
 * 1 = white; row 0 at the bottom): what counts as dark (a level — automatic: Otsu's —, optionally against the light
 * round each spot, so shadows and uneven light don't count), specks dropped, then either the edges of the dark areas
 * (closed loops) or the middle of drawn lines (thinned to one pixel, followed from end to end). Points in grid units:
 * (x, y) = a pixel's corner, (0, 0) the bottom left of the grid.
 */

export type GP = [number, number];

export interface ScanOptions {
  /** "face": the edges of dark areas (closed); "outline": the middle of drawn lines. */
  kind: "face" | "outline";
  /** Dark below this grey level (0..1); null: automatic. */
  dark: number | null;
  /** Compare each spot with the light round it (shadows, a photo darker on one side). */
  even: boolean;
  /** Dark (and light) bits smaller than this many pixels are dropped. */
  specks: number;
}

export interface ScanResult {
  loops: GP[][];
  paths: GP[][];
  /** The grey level used (the automatic one, if so). */
  level: number;
}

/**
 * Each grey value against the paper's brightness round it, so shadows and uneven light don't count: the paper's
 * brightness per block (~1/12 of the area, at least 8 px; the 90th-percentile grey in it), only allowed to fall
 * slowly from block to block (a shadow fades in; a big dark shape doesn't pass for paper), blended between blocks.
 * Paper ≈ 1, ink darker.
 */
function evenOut(g: Float32Array, w: number, h: number): Float32Array {
  const B = Math.max(8, Math.round(Math.min(w, h) / 12)), bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const bg = new Float32Array(bw * bh), vals: number[] = [];
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      vals.length = 0;
      for (let y = by * B; y < Math.min(h, (by + 1) * B); y++) for (let x = bx * B; x < Math.min(w, (bx + 1) * B); x++) vals.push(g[y * w + x]);
      vals.sort((a, b) => a - b);
      bg[by * bw + bx] = vals[Math.floor(0.9 * (vals.length - 1))];
    }
  }
  // (at most this much darker than a neighbouring block — passes both ways until nothing changes)
  const FALL = 0.08;
  for (let changed = true, guard = 0; changed && guard < bw + bh + 2; guard++) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      for (let k = 0; k < bw * bh; k++) {
        const i = pass ? bw * bh - 1 - k : k, x = i % bw, y = (i - x) / bw;
        let lo = bg[i];
        for (const j of [x > 0 ? i - 1 : -1, x < bw - 1 ? i + 1 : -1, y > 0 ? i - bw : -1, y < bh - 1 ? i + bw : -1]) if (j >= 0) lo = Math.max(lo, bg[j] - FALL);
        if (lo > bg[i] + 1e-6) {
          bg[i] = lo;
          changed = true;
        }
      }
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / B - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / B - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const b = (bg[y0 * bw + x0] * (1 - tx) + bg[y0 * bw + x1] * tx) * (1 - ty) + (bg[y1 * bw + x0] * (1 - tx) + bg[y1 * bw + x1] * tx) * ty;
      out[y * w + x] = Math.min(1, g[y * w + x] / Math.max(1e-3, b));
    }
  }
  return out;
}

/** Otsu's level: the grey value splitting the values into two groups as far apart as can be. */
function otsu(g: Float32Array): number {
  const bins = 256, hist = new Float64Array(bins);
  for (const v of g) hist[Math.min(bins - 1, Math.max(0, Math.floor(v * bins)))]++;
  const total = g.length;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, level = bins / 2;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      level = i + 1;
    }
  }
  return level / bins;
}

/** Connected bits (4-neighbours) of value `v` smaller than `min` pixels flipped to the other value. */
function dropSpecks(m: Uint8Array, w: number, h: number, v: 0 | 1, min: number): void {
  if (min <= 1) return;
  const seen = new Uint8Array(w * h), stack: number[] = [], bit: number[] = [];
  for (let s = 0; s < w * h; s++) {
    if (seen[s] || m[s] !== v) continue;
    stack.push(s);
    seen[s] = 1;
    bit.length = 0;
    let edge = false;
    while (stack.length) {
      const i = stack.pop()!, x = i % w, y = (i - x) / w;
      bit.push(i);
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !seen[j] && m[j] === v) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    // (light bits touching the area's edge are the paper round it, not holes)
    if (bit.length < min && !(v === 0 && edge)) for (const i of bit) m[i] = 1 - v;
  }
}

/**
 * The edges of the dark areas as closed loops: the pixel edges between dark and light followed round (dark on the
 * left; dark pixels touching only at a corner are joined), each loop through its edges' middles.
 */
function contours(m: Uint8Array, w: number, h: number): GP[][] {
  const dark = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  // Directed pixel edges from lattice point (x, y), dark on the left: out[point] = the directions leaving it
  // (0: +x, 1: +y, 2: −x, 3: −y)
  const W = w + 1, out = new Map<number, number[]>();
  const add = (x: number, y: number, d: number) => {
    const k = y * W + x, l = out.get(k);
    if (l) l.push(d);
    else out.set(k, [d]);
  };
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      // bottom edge of pixel (x, y) runs +x when it's dark and the one below isn't
      if (x < w && dark(x, y) && !dark(x, y - 1)) add(x, y, 0);
      if (x < w && !dark(x, y) && dark(x, y - 1)) add(x + 1, y, 2);
      // left edge of pixel (x, y) runs −y when it's dark and the one to the left isn't
      if (y < h && dark(x, y) && !dark(x - 1, y)) add(x, y + 1, 3);
      if (y < h && !dark(x, y) && dark(x - 1, y)) add(x, y, 1);
    }
  }
  const step: GP[] = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const loops: GP[][] = [];
  for (const [k0, l0] of out) {
    while (l0.length) {
      let x = k0 % W, y = (k0 - x) / W, d = l0.pop()!;
      const sx = x, sy = y, pts: GP[] = [];
      for (let guard = 0; guard < 4 * (w + 2) * (h + 2); guard++) {
        pts.push([x + step[d][0] / 2, y + step[d][1] / 2]);
        x += step[d][0];
        y += step[d][1];
        if (x === sx && y === sy) break;
        const l = out.get(y * W + x)!;
        // Two ways on (a corner where two dark pixels touch): turn right — joins them (a thin slanted line stays one piece)
        const right = (d + 3) % 4, left = (d + 1) % 4;
        const pick = l.includes(right) ? right : l.includes(d) ? d : left;
        l.splice(l.indexOf(pick), 1);
        d = pick;
      }
      if (pts.length >= 4) loops.push(pts);
    }
  }
  return loops;
}

/** Zhang–Suen thinning: dark areas worn down to lines one pixel wide (in place). */
function thin(m: Uint8Array, w: number, h: number): void {
  const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? m[y * w + x] : 0);
  const del: number[] = [];
  for (let changed = true; changed; ) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) continue;
          // neighbours clockwise from up: p2..p9
          const p = [at(x, y + 1), at(x + 1, y + 1), at(x + 1, y), at(x + 1, y - 1), at(x, y - 1), at(x - 1, y - 1), at(x - 1, y), at(x - 1, y + 1)];
          const b = p.reduce((s, v) => s + v, 0);
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let i = 0; i < 8; i++) if (!p[i] && p[(i + 1) % 8]) a++;
          if (a !== 1) continue;
          if (pass === 0 ? p[0] * p[2] * p[4] || p[2] * p[4] * p[6] : p[0] * p[2] * p[6] || p[0] * p[4] * p[6]) continue;
          del.push(y * w + x);
        }
      }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  // Staircase corners: a pixel whose up / right (etc.) neighbours are both on and isn't needed to join them
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      const n = at(x, y + 1), e = at(x + 1, y), s = at(x, y - 1), wv = at(x - 1, y);
      const corner = (n && e && !at(x - 1, y - 1) && !s && !wv) || (e && s && !at(x - 1, y + 1) && !n && !wv) || (s && wv && !at(x + 1, y + 1) && !n && !e) || (wv && n && !at(x + 1, y - 1) && !s && !e);
      if (corner) m[y * w + x] = 0;
    }
  }
}

/** The thinned lines followed from end to end (or junction to junction); closed rings as loops. Pixel centres. */
function follow(m: Uint8Array, w: number, h: number): { paths: GP[][]; loops: GP[][] } {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && m[y * w + x] === 1;
  const nbrs = (i: number): number[] => {
    const x = i % w, y = (i - x) / w, out: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && on(x + dx, y + dy)) out.push((y + dy) * w + x + dx);
    return out;
  };
  const deg = new Map<number, number>();
  for (let i = 0; i < w * h; i++) if (m[i]) deg.set(i, nbrs(i).length);
  const node = (i: number) => deg.get(i) !== 2;
  const used = new Set<string>(), key = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);
  const pt = (i: number): GP => [(i % w) + 0.5, Math.floor(i / w) + 0.5];
  const walk = (start: number, next: number): number[] => {
    const chain = [start];
    let prev = start, cur = next;
    used.add(key(prev, cur));
    for (;;) {
      chain.push(cur);
      if (node(cur) || cur === start) break;
      const nx = nbrs(cur).find((j) => j !== prev && !used.has(key(cur, j)));
      if (nx === undefined) break;
      used.add(key(cur, nx));
      prev = cur;
      cur = nx;
    }
    return chain;
  };
  const paths: GP[][] = [], loops: GP[][] = [];
  for (const [i] of deg) if (node(i)) for (const j of nbrs(i)) if (!used.has(key(i, j))) paths.push(walk(i, j).map(pt));
  // (what's left: rings with no ends)
  for (const [i] of deg) {
    if (node(i)) continue;
    const j = nbrs(i).find((k) => !used.has(key(i, k)));
    if (j === undefined) continue;
    const c = walk(i, j);
    if (c[c.length - 1] === i) loops.push(c.slice(0, -1).map(pt));
    else paths.push(c.map(pt));
  }
  return { paths, loops };
}

/** Douglas–Peucker: the fewest points within `tol` of the line (closed: round back to the start). */
export function simplify(pts: GP[], tol: number, closed: boolean): GP[] {
  if (pts.length < 3) return pts;
  const dp = (a: number, b: number, keep: Uint8Array) => {
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
    let far = -1, fd = tol;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i], d = L < 1e-12 ? Math.hypot(px - ax, py - ay) : Math.abs(dx * (py - ay) - dy * (px - ax)) / L;
      if (d > fd) {
        fd = d;
        far = i;
      }
    }
    if (far < 0) return;
    keep[far] = 1;
    dp(a, far, keep);
    dp(far, b, keep);
  };
  if (!closed) {
    const keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    dp(0, pts.length - 1, keep);
    return pts.filter((_, i) => keep[i]);
  }
  // Closed: split at the point farthest from the first, simplify both halves
  let far = 0, fd = -1;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]);
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const ring = [...pts, pts[0]], keep = new Uint8Array(ring.length);
  keep[0] = keep[far] = keep[ring.length - 1] = 1;
  const dpRing = (a: number, b: number) => {
    const sub = ring.slice(a, b + 1), k = new Uint8Array(sub.length);
    k[0] = k[sub.length - 1] = 1;
    const save = pts;
    pts = sub;
    dp(0, sub.length - 1, k);
    pts = save;
    k.forEach((v, i) => v && (keep[a + i] = 1));
  };
  dpRing(0, far);
  dpRing(far, ring.length - 1);
  return ring.filter((_, i) => keep[i] && i < ring.length - 1);
}

const ringArea = (p: GP[]) => Math.abs(p.reduce((s, [x, y], i) => { const [u, v] = p[(i + 1) % p.length]; return s + x * v - u * y; }, 0)) / 2;
const pathLength = (p: GP[]) => p.reduce((s, q, i) => (i ? s + Math.hypot(q[0] - p[i - 1][0], q[1] - p[i - 1][1]) : 0), 0);

/**
 * Scan a grid of grey values (`w` × `h`, row 0 at the bottom): loops (edges of dark areas, or closed drawn lines) and
 * open paths (drawn lines) in grid units, simplified to within `tol` pixels.
 */
export function scanGrid(grey: Float32Array, w: number, h: number, o: ScanOptions, tol = 0.8): ScanResult {
  if (w < 2 || h < 2) return { loops: [], paths: [], level: o.dark ?? 0.5 };
  const g = o.even ? evenOut(grey, w, h) : grey;
  const level = o.dark ?? otsu(g);
  const m = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) m[i] = g[i] < level ? 1 : 0;
  const min = Math.max(1, Math.round(o.specks));
  dropSpecks(m, w, h, 1, min);
  dropSpecks(m, w, h, 0, min);
  if (o.kind === "face") {
    const loops = contours(m, w, h).filter((l) => ringArea(l) >= Math.max(2, min / 2)).map((l) => simplify(l, tol, true)).filter((l) => l.length >= 3);
    return { loops, paths: [], level };
  }
  thin(m, w, h);
  const { paths, loops } = follow(m, w, h);
  // (spurs: short bits with a free end — from bumps on a thick line)
  const spur = Math.max(3, Math.sqrt(min) * 2);
  return {
    loops: loops.filter((l) => l.length >= 8).map((l) => simplify(l, tol, true)).filter((l) => l.length >= 3),
    paths: paths.filter((p) => pathLength(p) >= spur).map((p) => simplify(p, tol, false)).filter((p) => p.length >= 2),
    level,
  };
}
