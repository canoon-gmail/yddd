/** Inline 24×24 stroke icons for the toolbar (inherit `currentColor`). */
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const FILL = 'fill="currentColor" fill-opacity="0.35"';

export const ICONS: Record<string, string> = {
  solid: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" ${FILL}/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>`),
  face: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5v9L12 21z" ${FILL}/>`),
  edge: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z" stroke-opacity="0.45"/><path d="M12 12v9" stroke-width="3"/>`),
  box: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"/>`),
  cylinder: svg(`<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/>`),
  rectangle: svg(`<rect x="4" y="7" width="16" height="10" rx="0.5" ${FILL}/>`),
  circle: svg(`<circle cx="12" cy="12" r="7.5" ${FILL}/>`),
  polygon: svg(`<path d="M12 3l8.5 6.2-3.3 10H6.8L3.5 9.2z" ${FILL}/>`),
  sphere: svg(`<circle cx="12" cy="12" r="8"/><ellipse cx="12" cy="12" rx="8" ry="3"/>`),
  pushpull: svg(`<path d="M4 14l8-3 8 3-8 3z" ${FILL}/><path d="M4 14v4l8 3 8-3v-4"/><path d="M12 9V2M9 5l3-3 3 3"/>`),
  fillet: svg(`<path d="M4 20V12a8 8 0 0 1 8-8h8"/><path d="M4 8V4h4" stroke-opacity="0.4" stroke-dasharray="2 2"/>`),
  chamfer: svg(`<path d="M4 20V10l6-6h10"/><path d="M4 10V4h6" stroke-opacity="0.4" stroke-dasharray="2 2"/>`),
  shell: svg(`<path d="M3 6v15h18V6"/><path d="M7 6v11h10V6"/><path d="M3 6h4M17 6h4"/>`),
  union: svg(`<path d="M12 6.8A6 6 0 1 0 12 17.2A6 6 0 1 0 12 6.8z" ${FILL}/><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/>`),
  subtract: svg(`<path d="M12 6.8A6 6 0 1 0 12 17.2A6 6 0 0 1 12 6.8z" ${FILL}/><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6" stroke-dasharray="2 2"/>`),
  intersect: svg(`<path d="M12 6.8A6 6 0 0 1 12 17.2A6 6 0 0 1 12 6.8z" ${FILL}/><circle cx="9" cy="12" r="6" stroke-opacity="0.5"/><circle cx="15" cy="12" r="6" stroke-opacity="0.5"/>`),
  move: svg(`<path d="M12 3v18M3 12h18M12 3l-3 3M12 3l3 3M12 21l-3-3M12 21l3-3M3 12l3-3M3 12l3 3M21 12l-3-3M21 12l-3 3"/>`),
  rotate: svg(`<path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/>`),
  duplicate: svg(`<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>`),
  delete: svg(`<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6"/>`),
  undo: svg(`<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>`),
  redo: svg(`<path d="M15 14l5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>`),
  fit: svg(`<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/><rect x="9" y="9" width="6" height="6"/>`),
  iso: svg(`<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5" stroke-opacity="0.5"/>`),
  top: svg(`<rect x="5" y="5" width="14" height="14"/><path d="M5 5l14 14M19 5L5 19" stroke-opacity="0.3"/>`),
  xray: svg(`<rect x="4" y="8" width="11" height="11"/><rect x="9" y="4" width="11" height="11" stroke-opacity="0.5" stroke-dasharray="2 2"/>`),
  right: svg(`<rect x="5" y="8" width="11" height="11"/><path d="M16 19l3-3V5l-3 3" stroke-opacity="0.4"/>`),
  front: svg(`<rect x="5" y="8" width="14" height="11"/><path d="M5 8l3-3h14l-3 3" stroke-opacity="0.4"/>`),
  eye: svg(`<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.5"/>`),
  eyeOff: svg(`<path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z" stroke-opacity="0.35"/><path d="M4 4l16 16"/>`),
};
