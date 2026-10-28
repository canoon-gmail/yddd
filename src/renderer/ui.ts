/** Small DOM / text helpers shared by the app controller and its parts. */
import { parseLen, typedUnit } from "./format";
export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
export const fmt = (n: number) => String(Math.round(n * 100) / 100);
export const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
export const isPro = () => document.body.classList.contains("pro");

/**
 * Number fields take inches: "in" or " typed after a number turns the field into a text field for the moment
 * (its own listeners don't see the half-typed unit); Enter, Tab or leaving it puts back the size in mm
 * (3.34in → 84.836) as a number field — before Enter applies anything.
 */
export function inchFields(): void {
  const inInch = (t: EventTarget | null): t is HTMLInputElement => t instanceof HTMLInputElement && t.dataset.inch !== undefined;
  const done = (f: HTMLInputElement) => {
    const v = parseLen(f.value);
    delete f.dataset.inch;
    f.type = "number";
    f.value = Number.isFinite(v) ? String(v) : "";
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new Event("change", { bubbles: true }));
  };
  window.addEventListener("keydown", (e) => {
    const f = e.target;
    if (!(f instanceof HTMLInputElement) || e.ctrlKey || e.altKey || e.metaKey) return;
    if (f.dataset.inch !== undefined) {
      if (e.key === "Enter" || e.key === "Tab") done(f);
    } else if (f.type === "number" && /\d$/.test(f.value)) {
      const next = typedUnit(f.value, e.key);
      if (next === null) return;
      e.preventDefault();
      f.dataset.inch = "";
      f.type = "text";
      f.value = next;
      f.setSelectionRange(next.length, next.length);
    }
  }, true);
  window.addEventListener("input", (e) => inInch(e.target) && e.stopImmediatePropagation(), true);
  window.addEventListener("focusout", (e) => inInch(e.target) && done(e.target), true);
}
