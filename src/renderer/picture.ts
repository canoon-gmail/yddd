/**
 * Pictures (File → Open Picture…): an image shown on a flat rectangle face object, e.g. a photo to model from.
 * The face is an ordinary one (moved, turned, scaled, hidden, locked, grouped like any face; not exported);
 * the image keeps to its corners: `corner` is the index (in the face's outline, see pointCenter) of the corner
 * at the image's bottom left, `dir` which way round the next one is its bottom right (+1) or its top left (−1).
 * The corners' order stays with the shape through moves / turns / mirrors, so the image does too.
 */
export interface PictureRecord {
  /** The image (see addImage). */
  readonly img: string;
  readonly corner: number;
  readonly dir: 1 | -1;
}

/** The images by id, as data URLs (kept once however many bodies / undo steps show them; saved in the file). */
const images = new Map<string, string>();

/** Keep an image (a data URL); its id (the same image: the same id). */
export function addImage(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) h = Math.imul(h ^ url.charCodeAt(i), 0x01000193);
  const id = `${(h >>> 0).toString(36)}-${url.length.toString(36)}`;
  images.set(id, url);
  return id;
}

export const imageUrl = (id: string): string | undefined => images.get(id);

/** The images with these ids (for a file). */
export function imagesOf(ids: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const id of ids) {
    const u = images.get(id);
    if (u) out[id] = u;
  }
  return out;
}

/** A file's images, kept. */
export function loadImages(saved: Record<string, string> | undefined): void {
  for (const [id, url] of Object.entries(saved ?? {})) if (typeof url === "string") images.set(id, url);
}

/** Picture file types (by extension) and their MIME types. */
export const PICTURE_TYPES: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", bmp: "image/bmp" };
