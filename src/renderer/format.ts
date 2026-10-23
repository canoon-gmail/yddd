/** Number formatting shared by the Measure HUD / panel and dimension labels. */

/** Up to 2 decimals, no trailing zeros, thousands grouped: 13440 → "13,440", 59.5 → "59.5". */
export const num = (n: number) => (Math.abs(n) < 5e-3 ? 0 : n).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Degrees to 0.1°: 45 → "45°". */
export const deg = (a: number) => `${(Math.round(a * 10) / 10).toLocaleString("en-US")}°`;

/** File → Settings: circles, cylinders and spheres are sized by their radius (default) or diameter (localStorage). */
export const CIRCLE_SIZE_KEY = "y3d.circleSize";
export const byDiameter = () => localStorage.getItem(CIRCLE_SIZE_KEY) === "d";

/** The circle size the user enters / sees, from a radius and back; its name and HUD prefix. */
export const circleSize = {
  shown: (r: number) => (byDiameter() ? 2 * r : r),
  radius: (v: number) => (byDiameter() ? v / 2 : v),
  get word() { return byDiameter() ? "diameter" : "radius"; },
  get label() { return byDiameter() ? "Diameter" : "Radius"; },
  get tag() { return byDiameter() ? "Ø" : "R"; },
};
