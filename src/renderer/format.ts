/** Number formatting shared by the Measure HUD / panel and dimension labels. */

/** Up to 2 decimals, no trailing zeros, thousands grouped: 13440 → "13,440", 59.5 → "59.5". */
export const num = (n: number) => (Math.abs(n) < 5e-3 ? 0 : n).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Degrees to 0.1°: 45 → "45°". */
export const deg = (a: number) => `${(Math.round(a * 10) / 10).toLocaleString("en-US")}°`;

/** File → Settings: circles, cylinders and spheres are sized by their radius (default) or diameter (localStorage). */
export const CIRCLE_SIZE_KEY = "yddd.circleSize";
export const byDiameter = () => localStorage.getItem(CIRCLE_SIZE_KEY) === "d";
/** Settings: solids' opacity, % — normally and in x-ray. */
export const SOLID_OPACITY_KEY = "yddd.solidOpacity", XRAY_OPACITY_KEY = "yddd.xrayOpacity";
export const opacitySetting = (key: string, fallback: number): number => {
  const v = Number(localStorage.getItem(key));
  return localStorage.getItem(key) !== null && v >= 5 && v <= 100 ? v : fallback;
};

/** The circle size the user enters / sees, from a radius and back; its name and HUD prefix. */
export const circleSize = {
  shown: (r: number) => (byDiameter() ? 2 * r : r),
  radius: (v: number) => (byDiameter() ? v / 2 : v),
  get word() { return byDiameter() ? "diameter" : "radius"; },
  get label() { return byDiameter() ? "Diameter" : "Radius"; },
  get tag() { return byDiameter() ? "Ø" : "R"; },
};

/** Inches typed with a number: "3.34in" / "3.34\"" (also after a comma: "2in,1in"). */
const INCH = /^\s*([+-]?(?:\d+\.?\d*|\.\d+))\s*(?:in|")\s*$/i;

/** A typed length in mm: a plain number is mm (as Number(): "" is 0); "3.34in" or "3.34\"" is inches (×25.4). */
export const parseLen = (s: string): number => {
  const m = INCH.exec(s);
  return m ? Math.round(Number(m[1]) * 25.4 * 1e6) / 1e6 : Number(s);
};

/** A typed-number collector's next text when key `k` starts / finishes an inch unit ("in" or "), else null. */
export const typedUnit = (typed: string, k: string): string | null => {
  if ((k === '"' || k === "i" || k === "I") && /\d\.?$/.test(typed)) return typed + (k === '"' ? '"' : "i");
  if ((k === "n" || k === "N") && /\di$/.test(typed)) return typed + "n";
  return null;
};
