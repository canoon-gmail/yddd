/**
 * Macro → Random: where copies of an object go on a flat face — random spots, sizes and spins, each copy's
 * footprint (a circle) inside the face's outline (out of its holes) and, unless overlap is allowed, clear of
 * the others. Plain maths (no OpenCascade): the face comes as its segments (see faceSegments).
 */
import type { V3 } from "./kernel";

export interface ScatterOptions {
  count: number;
  /** Sizes, 1 = as it is: each copy's a random one between them. */
  smallest: number;
  biggest: number;
  /** Each copy turned a random angle about the face's normal. */
  spin: boolean;
  overlap: boolean;
  /** The same seed, the same spots. */
  seed: number;
}

/** A copy: which object (index into the radii), its middle's spot on the face, its size and turn (degrees about the face's normal). */
export interface ScatterSpot {
  pick: number;
  at: V3;
  scale: number;
  spin: number;
}

/** A small seeded random number generator (mulberry32): numbers in [0, 1). */
function random(seed: number): () => number {
  let a = (Math.floor(seed) ^ 0x9e3779b9) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Spots for `count` copies of objects whose footprints are circles of radii `radii` (at size 1) on the face: each
 * copy one of them at random. Biggest first (they're the hardest to fit); fewer come back when the face is full.
 */
export function scatter(face: { normal: V3; point: V3; segs: [V3, V3][] }, radii: number[], o: ScatterOptions): ScatterSpot[] {
  const n = face.normal, o3 = face.point;
  // The face's plane: two directions along it
  const a: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const dot = (p: V3, q: V3) => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const k = dot(a, n), u0: V3 = [a[0] - k * n[0], a[1] - k * n[1], a[2] - k * n[2]], ul = Math.hypot(...u0);
  const u: V3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
  const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const flat = (p: V3): [number, number] => {
    const d: V3 = [p[0] - o3[0], p[1] - o3[1], p[2] - o3[2]];
    return [dot(d, u), dot(d, v)];
  };
  const segs = face.segs.map(([p, q]) => [...flat(p), ...flat(q)] as [number, number, number, number]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [ax, ay, bx, by] of segs) {
    x0 = Math.min(x0, ax, bx); x1 = Math.max(x1, ax, bx);
    y0 = Math.min(y0, ay, by); y1 = Math.max(y1, ay, by);
  }
  // Inside: a ray along +x crosses the outline (holes' included) an odd number of times
  const inside = (x: number, y: number) => {
    let odd = false;
    for (const [ax, ay, bx, by] of segs) if ((ay > y) !== (by > y) && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) odd = !odd;
    return odd;
  };
  const edgeDist = (x: number, y: number) => {
    let best = Infinity;
    for (const [ax, ay, bx, by] of segs) {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
      best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
    }
    return best;
  };
  const rnd = random(o.seed);
  const copies = Array.from({ length: o.count }, () => {
    const pick = Math.min(radii.length - 1, Math.floor(rnd() * radii.length)), s = o.smallest + rnd() * (o.biggest - o.smallest);
    return { pick, s, rr: radii[pick] * s };
  }).sort((p, q) => q.rr - p.rr);
  const placed: { x: number; y: number; r: number }[] = [];
  const out: ScatterSpot[] = [];
  for (const { pick, s, rr } of copies) {
    for (let tries = 0; tries < 500; tries++) {
      const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0);
      if (!inside(x, y) || edgeDist(x, y) < rr) continue;
      if (!o.overlap && placed.some((p) => Math.hypot(p.x - x, p.y - y) < p.r + rr)) continue;
      placed.push({ x, y, r: rr });
      out.push({ pick, at: [o3[0] + x * u[0] + y * v[0], o3[1] + x * u[1] + y * v[1], o3[2] + x * u[2] + y * v[2]], scale: s, spin: o.spin ? rnd() * 360 : 0 });
      break;
    }
  }
  return out;
}
