/**
 * 3MF export (File → Export 3MF): the 3D Manufacturing Format slicers like Bambu Studio / PrusaSlicer / Cura open
 * natively — a ZIP holding the model as XML: one object per body (its name), an indexed triangle mesh each, in mm.
 */
import type { IndexedMesh } from "./kernel";

export interface ThreeMfObject {
  name: string;
  mesh: IndexedMesh;
}

const CONTENT_TYPES =
  `<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`;

const RELS =
  `<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

const xmlText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** A coordinate as text: µm precision (0.001 mm), no trailing zeros. */
const num = (v: number) => {
  const t = (Math.round(v * 1e6) / 1e6).toString();
  return t === "-0" ? "0" : t;
};

/**
 * Where the plate's middle is (mm): a slicer's plate has (0, 0) at a corner, yddd's models sit round (0, 0) — the
 * whole lot is moved there together, its bottom at z 0 (256 × 256: Bambu X1 / P1 / A1; others: Arrange in the slicer).
 */
export const PLATE_CENTRE: [number, number] = [128, 128];

/** The model XML: each object's vertices and triangles; all of them moved together onto the plate's middle. */
function modelXml(objects: ThreeMfObject[]): string {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const o of objects) {
    const P = o.mesh.positions;
    for (let k = 0; k < P.length; k++) {
      lo[k % 3] = Math.min(lo[k % 3], P[k]);
      hi[k % 3] = Math.max(hi[k % 3], P[k]);
    }
  }
  const shift = objects.length ? [PLATE_CENTRE[0] - (lo[0] + hi[0]) / 2, PLATE_CENTRE[1] - (lo[1] + hi[1]) / 2, -lo[2]] : [0, 0, 0];
  const place = `1 0 0 0 1 0 0 0 1 ${shift.map(num).join(" ")}`;
  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">`,
    `<metadata name="Application">YDDD</metadata><resources>`,
  ];
  objects.forEach((o, i) => {
    parts.push(`<object id="${i + 1}" type="model" name="${xmlText(o.name)}"><mesh><vertices>`);
    const P = o.mesh.positions, T = o.mesh.triangles;
    for (let k = 0; k < P.length; k += 3) parts.push(`<vertex x="${num(P[k])}" y="${num(P[k + 1])}" z="${num(P[k + 2])}"/>`);
    parts.push(`</vertices><triangles>`);
    for (let k = 0; k < T.length; k += 3) parts.push(`<triangle v1="${T[k]}" v2="${T[k + 1]}" v3="${T[k + 2]}"/>`);
    parts.push(`</triangles></mesh></object>`);
  });
  parts.push(`</resources><build>`, ...objects.map((_, i) => `<item objectid="${i + 1}" transform="${place}"/>`), `</build></model>`);
  return parts.join("");
}

export async function write3mf(objects: ThreeMfObject[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  return zip([
    { name: "[Content_Types].xml", data: enc.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: enc.encode(RELS) },
    { name: "3D/3dmodel.model", data: enc.encode(modelXml(objects)) },
  ]);
}

// ---------------------------------------------------------------- a small ZIP writer (deflate, no ZIP64: files < 4 GB)

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function zip(files: { name: string; data: Uint8Array }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const entries = await Promise.all(files.map(async (f) => ({ name: enc.encode(f.name), crc: crc32(f.data), size: f.data.length, packed: await deflateRaw(f.data) })));
  const local = entries.reduce((n, e) => n + 30 + e.name.length + e.packed.length, 0);
  const central = entries.reduce((n, e) => n + 46 + e.name.length, 0);
  const out = new Uint8Array(local + central + 22), dv = new DataView(out.buffer);
  let o = 0;
  const offsets: number[] = [];
  // (DOS date / time: 1980-01-01 00:00 — the date isn't used by readers)
  const head = (sig: number, e: (typeof entries)[number], central: boolean) => {
    dv.setUint32(o, sig, true);
    o += 4;
    if (central) (dv.setUint16(o, 20, true), (o += 2)); // version made by
    dv.setUint16(o, 20, true); // version needed
    dv.setUint16(o + 2, 0x0800, true); // flags: UTF-8 names
    dv.setUint16(o + 4, 8, true); // deflate
    dv.setUint16(o + 6, 0, true);
    dv.setUint16(o + 8, 0x21, true);
    dv.setUint32(o + 10, e.crc, true);
    dv.setUint32(o + 14, e.packed.length, true);
    dv.setUint32(o + 18, e.size, true);
    dv.setUint16(o + 22, e.name.length, true);
    dv.setUint16(o + 24, 0, true); // extra
    o += 26;
  };
  for (const e of entries) {
    offsets.push(o);
    head(0x04034b50, e, false);
    out.set(e.name, o);
    o += e.name.length;
    out.set(e.packed, o);
    o += e.packed.length;
  }
  const cdStart = o;
  entries.forEach((e, i) => {
    head(0x02014b50, e, true);
    dv.setUint16(o, 0, true); // comment
    dv.setUint16(o + 2, 0, true); // disk
    dv.setUint16(o + 4, 0, true); // internal attributes
    dv.setUint32(o + 6, 0, true); // external attributes
    dv.setUint32(o + 10, offsets[i], true);
    o += 14;
    out.set(e.name, o);
    o += e.name.length;
  });
  dv.setUint32(o, 0x06054b50, true);
  dv.setUint16(o + 4, 0, true);
  dv.setUint16(o + 6, 0, true);
  dv.setUint16(o + 8, entries.length, true);
  dv.setUint16(o + 10, entries.length, true);
  dv.setUint32(o + 12, o - cdStart, true);
  dv.setUint32(o + 16, cdStart, true);
  dv.setUint16(o + 20, 0, true);
  return out;
}
