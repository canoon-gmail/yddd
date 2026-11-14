/** Inline 24×24 stroke icons for the toolbar (inherit `currentColor`). */
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const FILL = 'fill="currentColor" fill-opacity="0.32"';
const SOFT = 'stroke-opacity="0.45"';
const DASH = 'stroke-dasharray="2.4 2.1"';
const DOT = 'fill="currentColor" stroke="none"';

export const ICONS: Record<string, string> = {
  // Selection modes: isometric cube with whole solid, one face, or one edge highlighted.
  solid: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" ${FILL}/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>`),
  face: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" ${SOFT}/><path d="M12 12L4 7.5" ${SOFT}/><path d="M12 12l8-4.5v9L12 21z" ${FILL}/>`),
  edge: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" ${SOFT}/><path d="M12 12l8-4.5M12 12L4 7.5" ${SOFT}/><path d="M12 12v9" stroke-width="2.8"/><circle cx="12" cy="12" r="1.9" ${DOT}/><circle cx="12" cy="21" r="1.9" ${DOT}/>`),

  // Primitives (3D): shaded top/lighting cue + clean wireframe.
  box: svg(`<path d="M12 3l8 4.5L12 12 4 7.5z" ${FILL}/><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>`),
  cylinder: svg(`<ellipse cx="12" cy="6" rx="7" ry="3" ${FILL}/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" ${SOFT} ${DASH}/>`),
  sphere: svg(`<circle cx="12" cy="12" r="8" ${FILL}/><ellipse cx="12" cy="12" rx="8" ry="3"/><ellipse cx="12" cy="12" rx="3" ry="8" ${SOFT}/>`),
  cone: svg(`<path d="M12 3L5 18c0 1.7 3.1 3 7 3s7-1.3 7-3L12 3z" ${FILL}/><path d="M5 18c0-1.7 3.1-3 7-3s7 1.3 7 3" ${SOFT} ${DASH}/>`),

  // Flat faces & 2D Sketch: geometric shapes with vertex dots / construction plane.
  rectangle: svg(`<rect x="3.5" y="6.5" width="17" height="11" rx="1" ${FILL}/><circle cx="3.5" cy="6.5" r="1.6" ${DOT}/><circle cx="20.5" cy="17.5" r="1.6" ${DOT}/>`),
  circle: svg(`<circle cx="12" cy="12" r="7.5" ${FILL}/><circle cx="12" cy="12" r="1.6" ${DOT}/><path d="M12 12l5.3-5.3" ${SOFT}/>`),
  polygon: svg(`<path d="M12 3l7.8 4.5v9L12 21l-7.8-4.5v-9z" ${FILL}/><circle cx="12" cy="3" r="1.5" ${DOT}/><circle cx="19.8" cy="7.5" r="1.5" ${DOT}/><circle cx="4.2" cy="7.5" r="1.5" ${DOT}/>`),
  edit: svg(`<path d="M4 20l1-4.5L15.5 5a2.1 2.1 0 013 3L8 18.5z" ${FILL}/><path d="M13.5 7l3 3"/>`),
  text: svg(`<path d="M5 5h14M12 5v14M9 19h6"/><path d="M5 5v2.5M19 5v2.5" ${SOFT}/>`),
  // Sketch tools (the Sketch bar): a line, an arc, a Curve with its control lines — end points dotted
  skLine: svg(`<path d="M5 19L19 5"/><circle cx="5" cy="19" r="1.9" ${DOT}/><circle cx="19" cy="5" r="1.9" ${DOT}/>`),
  skRect: svg(`<rect x="4" y="6.5" width="16" height="11" rx="0.6"/><circle cx="4" cy="6.5" r="1.9" ${DOT}/><circle cx="20" cy="17.5" r="1.9" ${DOT}/>`),
  skArc: svg(`<path d="M4 18a8 8 0 0 1 16 0"/><circle cx="4" cy="18" r="1.9" ${DOT}/><circle cx="20" cy="18" r="1.9" ${DOT}/><circle cx="12" cy="10" r="1.3" ${DOT} fill-opacity="0.55"/>`),
  skCurve: svg(`<path d="M3.5 18C6 6 13 20 20.5 6"/><path d="M3.5 18L7.5 6.5M16.5 19.5L20.5 6" ${SOFT} ${DASH}/><circle cx="3.5" cy="18" r="1.9" ${DOT}/><circle cx="20.5" cy="6" r="1.9" ${DOT}/>`),
  sketch: svg(`<path d="M3 16l9-4 9 4-9 5z" ${SOFT}/><path d="M7.5 15.5l4.5-2 4.5 2-4.5 2.2z" ${FILL}/><path d="M14 11l4.5-7 2.5 2.5-7 4.5z" ${FILL}/><circle cx="12" cy="13.5" r="1.3" ${DOT}/>`),
  turnView: svg(`<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3v4h-4"/><rect x="9" y="9" width="6" height="6" rx="0.8" ${FILL}/>`),
  picture: svg(`<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="8.5" cy="10" r="1.6" ${FILL}/><path d="M3 16.5l5-4.5 4 3.5 3-2.5 6 4.5V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" ${FILL}/>`),
  // Divide face: a craft knife (as its cursor) finishing a cut across a face
  knife: svg(`<rect x="2" y="11" width="12" height="10" rx="1.5" ${FILL}/><path d="M2 18.6L10 15.2" stroke-width="2"/><circle cx="2" cy="18.6" r="1.7" ${DOT}/><g transform="translate(10 15.2) rotate(-42)"><path d="M0 0L7.2 -3V2.2Z" stroke-width="1.4"/><path d="M9.4 0H13.4" stroke-width="3.6"/></g>`),

  // Modelling operations.
  pushpull: svg(`<path d="M4 13.5l8-3.2 8 3.2-8 3.2z" ${FILL}/><path d="M4 13.5v4.3L12 21l8-3.2v-4.3"/><path d="M12 16.7V21" ${SOFT}/><path d="M12 10V2.5M8.8 5.7L12 2.5l3.2 3.2" stroke-width="1.9"/>`),
  fillet: svg(`<path d="M4 20v-7a9 9 0 0 1 9-9h7"/><path d="M4 13A9 9 0 0 1 13 4L4 4z" ${FILL} stroke="none"/><path d="M4 11V4h7" ${SOFT} ${DASH}/><circle cx="4" cy="4" r="1.4" ${DOT}/>`),
  chamfer: svg(`<path d="M4 20v-8l8-8h8"/><path d="M4 12l8-8H4z" ${FILL} stroke="none"/><path d="M4 10V4h6" ${SOFT} ${DASH}/><circle cx="4" cy="4" r="1.4" ${DOT}/>`),
  shell: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 6.2l5 2.8L12 11.8 7 9z" ${FILL}/><path d="M12 11.8V15M12 21v-5" ${SOFT}/>`),
  curveFace: svg(`<path d="M4 6v13M20 6v13" ${SOFT}/><path d="M4 6c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5" ${SOFT}/><path d="M7.5 12.2c2.9.9 6.1.9 9 0v3.6c-2.9.9-6.1.9-9 0z" ${FILL}/>`),
  offset: svg(`<rect x="3.5" y="5" width="17" height="14" rx="1.5" ${DASH} ${SOFT}/><rect x="7.5" y="8.5" width="9" height="7" rx="0.8" ${FILL}/><path d="M16.5 12h4M19 10.3l1.7 1.7-1.7 1.7"/>`),
  revolve: svg(`<path d="M6 2.5v19" ${DASH} ${SOFT}/><rect x="10.5" y="5" width="6.5" height="8.5" rx="0.8" ${FILL}/><path d="M19.5 15c0 2.2-4 3.8-9 3.8-2.2 0-4.2-.3-5.6-.8"/><path d="M6.8 16l-2.2 1.8 1.8 2.2"/>`),
  sweep: svg(`<path d="M4 19c0-7.5 5.5-12 14-12" ${DASH}/><path d="M1.5 19C1.5 9.5 8 4 18 4M6.5 19c0-5.5 4.2-9 11.5-9" ${SOFT}/><ellipse cx="4" cy="19" rx="2.8" ry="1.6" ${FILL}/><ellipse cx="18" cy="7" rx="1.6" ry="3" ${FILL}/>`),
  cut: svg(`<path d="M3.5 14v5a1 1 0 0 0 1 1h15a1 1 0 0 0 1-1v-8z" ${FILL}/><path d="M3.5 11.2V6a1 1 0 0 1 1-1h15a1 1 0 0 1 1 1v2.2" ${SOFT}/><path d="M2 13L22 9.5" stroke-width="2" ${DASH}/>`),
  splitFace: svg(`<rect x="4" y="5" width="16" height="14" rx="1.5" ${SOFT}/><path d="M4 14.5L20 9.5V17.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z" ${FILL}/><path d="M2 15.1L22 8.9" stroke-width="1.9" ${DASH}/>`),
  // Guide line: a tape measure (as its cursor), its tape pulled out as the dashed guide, the hook at its end
  guide: svg(`<rect x="12" y="8" width="9.5" height="10.5" rx="2.8" ${FILL}/><circle cx="16.75" cy="13.25" r="1.7" ${DOT}/><path d="M11.6 17.2H4.4" stroke-width="1.8" stroke-dasharray="1.8 1.8"/><path d="M2.6 14.8v4.8" stroke-width="2"/>`),

  // Booleans.
  union: svg(`<path d="M12 6.8A6 6 0 1 0 12 17.2A6 6 0 1 0 12 6.8z" ${FILL}/>`),
  subtract: svg(`<path d="M12 6.8A6 6 0 1 0 12 17.2A6 6 0 0 1 12 6.8z" ${FILL}/><circle cx="15" cy="12" r="6" ${SOFT} ${DASH}/>`),
  intersect: svg(`<path d="M12 6.8A6 6 0 0 1 12 17.2A6 6 0 0 1 12 6.8z" ${FILL}/><circle cx="9" cy="12" r="6" ${SOFT} ${DASH}/><circle cx="15" cy="12" r="6" ${SOFT} ${DASH}/>`),

  // Transforms & copies.
  move: svg(`<path d="M12 2.5v19M2.5 12h19M12 2.5l-2.8 2.8M12 2.5l2.8 2.8M12 21.5l-2.8-2.8M12 21.5l2.8-2.8M2.5 12l2.8-2.8M2.5 12l2.8 2.8M21.5 12l-2.8-2.8M21.5 12l-2.8 2.8"/><circle cx="12" cy="12" r="1.7" ${DOT}/>`),
  moveFrom: svg(`<circle cx="5.5" cy="18.5" r="2.3" ${SOFT} ${DASH}/><circle cx="18.5" cy="5.5" r="2.5" ${FILL}/><path d="M7.5 16.5l8.5-8.5M11.5 8h4.5v4.5"/>`),
  rotateFrom: svg(`<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3v4h-4"/><circle cx="7.5" cy="16.5" r="2.5" ${FILL}/>`),
  rotate: svg(`<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 3v4h-4"/><circle cx="12" cy="12" r="2" ${FILL}/>`),
  scale: svg(`<rect x="3" y="11" width="9.5" height="9.5" rx="1" ${FILL}/><path d="M3 10.5V3.5h17v17h-7" ${SOFT} ${DASH}/><path d="M12.5 11.5L19.5 4.5M15 4.5h4.5V9"/>`),
  repeat: svg(`<rect x="3" y="12" width="6.5" height="6.5" rx="1" ${SOFT} ${DASH}/><rect x="14.5" y="12" width="6.5" height="6.5" rx="1" ${FILL}/><path d="M6.2 9.5c2-4 9.6-4 11.6 0M15.2 9.2l2.6.5.4-2.6"/>`),
  duplicate: svg(`<rect x="4" y="4" width="11" height="11" rx="1.8" ${SOFT}/><rect x="9" y="9" width="11" height="11" rx="1.8" ${FILL}/>`),
  array: svg(`<rect x="2" y="7.5" width="5" height="6.5" rx="1" ${FILL}/><rect x="9.5" y="7.5" width="5" height="6.5" rx="1" ${FILL}/><rect x="17" y="7.5" width="5" height="6.5" rx="1"/><path d="M2.5 18.5h19M18.5 16l3 2.5-3 2.5"/>`),
  mirror: svg(`<path d="M12 2.5v19" ${SOFT} ${DASH}/><path d="M9.5 5.5L3 18.5h6.5z" ${FILL}/><path d="M14.5 5.5L21 18.5h-6.5z"/>`),
  circular: svg(`<circle cx="12" cy="12" r="1.5" ${DOT}/><circle cx="12" cy="12" r="7.5" ${SOFT} ${DASH}/><rect x="10" y="2" width="4" height="4" rx="0.9" ${FILL}/><rect x="18" y="10" width="4" height="4" rx="0.9" ${FILL}/><rect x="10" y="18" width="4" height="4" rx="0.9"/><rect x="2" y="10" width="4" height="4" rx="0.9"/>`),

  // Utility & History.
  measure: svg(`<path d="M3 16.5L16.5 3 21 7.5 7.5 21z" ${FILL}/><path d="M7 12.5l1.8 1.8M9.5 10l2.4 2.4M12 7.5l1.8 1.8M14.5 5l2.4 2.4"/>`),
  undo: svg(`<path d="M8.5 13.5L4 9l4.5-4.5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`),
  redo: svg(`<path d="M15.5 13.5L20 9l-4.5-4.5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>`),

  // Views & visibility: 3D cube with highlighted face (Top / Front / Right) or isometric axes.
  fit: svg(`<path d="M3.5 8.5V4h4.5M20.5 8.5V4H16M3.5 15.5V20h4.5M20.5 15.5V20H16"/><path d="M12 7.5l4.5 2.5v4L12 16.5 7.5 14v-4z" ${FILL}/>`),
  iso: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" ${FILL}/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>`),
  top: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" ${SOFT}/><path d="M12 12v9" ${SOFT}/><path d="M12 3l8 4.5L12 12 4 7.5z" ${FILL}/>`),
  front: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" ${SOFT}/><path d="M12 12l8-4.5" ${SOFT}/><path d="M4 7.5L12 12v9l-8-4.5z" ${FILL}/>`),
  right: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" ${SOFT}/><path d="M12 12L4 7.5" ${SOFT}/><path d="M12 12l8-4.5v9L12 21z" ${FILL}/>`),
  xray: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" ${FILL}/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/><path d="M12 3v9M12 12l-8 4.5M12 12l8 4.5" ${SOFT} ${DASH}/>`),
  eye: svg(`<path d="M2.2 12s3.5-6 9.8-6 9.8 6 9.8 6-3.5 6-9.8 6-9.8-6-9.8-6z"/><circle cx="12" cy="12" r="2.8" ${FILL}/>`),
  eyeOff: svg(`<path d="M2.2 12s3.5-6 9.8-6 9.8 6 9.8 6-3.5 6-9.8 6-9.8-6-9.8-6z" ${SOFT}/><path d="M4 4l16 16"/>`),
  lock: svg(`<rect x="5" y="10.5" width="14" height="10" rx="2" ${FILL}/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.3" ${DOT}/>`),
  unlock: svg(`<rect x="5" y="10.5" width="14" height="10" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 7.6-1.7"/>`),
};

/**
 * The Guide line tools' cursor (the main view's and Sketch's): a tape measure (a gold case, red centre, grey button; the grey tape running down left to its hook) — the
 * point is the hook's tip, bottom left. Thin dark outlines: it shows on the dark view and on light faces.
 */
export const TAPE_CURSOR = (() => {
  // (drawn on a 520 × 600 grid, as the design: a gold case, its round side up left, its corner right; red centre; grey
  // button on its left side; the grey tape out of its bottom, down left to an L hook)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="205 80 520 600">
    <g stroke="#1b2633" stroke-width="13" stroke-linejoin="round">
      <path d="M290 385 A180 180 0 1 1 588 176 L703 352 L412 532 L345 468 Z" fill="#c9a85c"/>
      <path d="M384 516 L406 554 L251 639 L268 660 L255 670 L229 642 L229 601 Z" fill="#d0d3d6"/>
      <path d="M272 395 L305 375 L357 465 L325 482 Z" fill="#d0d3d6"/>
      <circle cx="460" cy="303" r="72" fill="#c23b3b"/>
    </g>
  </svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 5 31, crosshair`;
})();

/**
 * Sketch Fillet's cursor: a crosshair (the point: its centre) with a belt beside it — a big and a small round end joined
 * by straight lines, as F makes; dark, light outlines.
 */
export const FILLET_CURSOR = (() => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <path d="M19.95 5.85 L13.12 16.28 A2.6 2.6 0 0 0 16.72 19.88 L27.15 13.05 A5.2 5.2 0 1 0 19.95 5.85 Z" fill="#2b2c2e" stroke="#e1e4e7" stroke-width="1.5" stroke-linejoin="round"/>
    <g stroke-linecap="square">
      <path d="M8 16 V28 M2 22 H14" stroke="#1b1d20" stroke-width="3.2"/>
      <path d="M8 16 V28 M2 22 H14" stroke="#e1e4e7" stroke-width="1.4"/>
    </g>
  </svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 8 22, crosshair`;
})();

/**
 * The Measure tool's cursor: a crosshair (the point: its centre, a dark dot) with a tilted ruler beside it, up right —
 * gold, light edge, dark tick marks (every 5th long); dark outlines so it shows on the dark view and on light faces.
 */
export const MEASURE_CURSOR = (() => {
  const ticks = Array.from({ length: 8 }, (_, i) => {
    const x = 2.5 + i * 2;
    return `M${x} -8 V${i % 4 === 3 ? -3 : -5.3}`;
  }).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <g transform="translate(11.5 17) rotate(-22)">
      <rect x="0" y="-8" width="19" height="8" fill="#c9a85c" stroke="#1b1d20" stroke-width="3" stroke-linejoin="round"/>
      <rect x="0" y="-8" width="19" height="8" fill="none" stroke="#e1e4e7" stroke-width="1.2" stroke-linejoin="round"/>
      <path d="${ticks}" stroke="#2b2c2e" stroke-width="1.1"/>
    </g>
    <g stroke-linecap="square">
      <path d="M8 16 V28 M2 22 H14" stroke="#1b1d20" stroke-width="3.2"/>
      <path d="M8 16 V28 M2 22 H14" stroke="#e1e4e7" stroke-width="1.4"/>
    </g>
    <rect x="7" y="21" width="2" height="2" fill="#1b1d20"/>
  </svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 8 22, crosshair`;
})();

/**
 * The Divide face tool's cursor: a craft knife — a light triangular blade, its tip the point (bottom left), a short
 * ferrule, a brown round handle up right; dark outlines.
 */
export const KNIFE_CURSOR = (() => {
  // (drawn along the knife, tip at 0 0, then turned up right)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <defs><linearGradient id="h" x1="0" y1="-3.6" x2="0" y2="3.6" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#5a3a24"/><stop offset="0.35" stop-color="#9a6b48"/><stop offset="1" stop-color="#4a2f1d"/>
    </linearGradient></defs>
    <g transform="translate(2.5 28.5) rotate(-38)" stroke="#1b1d20" stroke-width="1" stroke-linejoin="round">
      <path d="M0 0 L13 -4.5 L14.5 4.2 Z" fill="#dfe2e6"/>
      <rect x="13" y="-1.4" width="3.5" height="2.8" fill="#6e4a30"/>
      <path d="M16 -3.6 H27.6 A1.5 3.6 0 0 1 27.6 3.6 H16 A1.5 3.6 0 0 1 16 -3.6 Z" fill="url(#h)"/>
      <ellipse cx="27.6" cy="0" rx="1.5" ry="3.6" fill="#6e4a30"/>
    </g>
  </svg>`;
  return `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}") 2 28, crosshair`;
})();
