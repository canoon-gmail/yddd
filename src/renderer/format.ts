/** Number formatting shared by the Measure HUD / panel and dimension labels. */

/** Up to 2 decimals, no trailing zeros, thousands grouped: 13440 → "13,440", 59.5 → "59.5". */
export const num = (n: number) => (Math.abs(n) < 5e-3 ? 0 : n).toLocaleString("en-US", { maximumFractionDigits: 2 });

/** Degrees to 0.1°: 45 → "45°". */
export const deg = (a: number) => `${(Math.round(a * 10) / 10).toLocaleString("en-US")}°`;
