/**
 * Key cast (hidden, Ctrl + Shift + F1): shows key presses and mouse drags at the middle left of the view,
 * for recording videos. Typed characters in a row join into one line ("25", "Box"); `skipDrag` leaves out
 * drags the video already shows (drawing a solid / face). Stays on across restarts until toggled off.
 */
const STORE = "yddd.keycast";
const SHOW_MS = 1600;
const JOIN_MS = 900;
const MAX_LINES = 4;
const DRAG_PX = 5;

const KEY_NAMES: Record<string, string> = {
  " ": "Space", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→", Escape: "Esc", Delete: "Del",
};
const BUTTONS = ["Left", "Middle", "Right"];

export class KeyCast {
  private on = localStorage.getItem(STORE) === "1";
  private box: HTMLDivElement;
  private last: { el: HTMLDivElement; text: string; at: number; count: number; typed: boolean } | null = null;
  private drag: { x: number; y: number; label: string; el: HTMLDivElement | null } | null = null;

  constructor(view: HTMLElement, private skipDrag: () => boolean) {
    this.box = document.createElement("div");
    this.box.id = "keycast";
    view.appendChild(this.box);
    window.addEventListener("keydown", (e) => this.key(e), { capture: true });
    view.addEventListener("pointerdown", (e) => this.down(e), { capture: true });
    window.addEventListener("pointermove", (e) => this.move(e), { capture: true });
    window.addEventListener("pointerup", () => this.up(), { capture: true });
  }

  private key(e: KeyboardEvent): void {
    if (e.key === "F1" && e.ctrlKey && e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.on = !this.on;
      localStorage.setItem(STORE, this.on ? "1" : "0");
      this.box.replaceChildren();
      this.last = null;
      this.flash(this.on ? "Key cast on" : "Key cast off", false);
      return;
    }
    if (!this.on || (e.repeat && this.last?.text === this.name(e)) || ["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
    const typed = e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.altKey && !e.metaKey;
    const l = this.last;
    if (typed && l?.typed && performance.now() - l.at < JOIN_MS && l.el.isConnected) {
      l.text += e.key;
      this.refresh(l);
      return;
    }
    this.flash(typed ? e.key : this.name(e), typed);
  }

  private name(e: KeyboardEvent): string {
    const key = KEY_NAMES[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key);
    return [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.metaKey && "Meta", e.shiftKey && "Shift", key].filter(Boolean).join(" + ");
  }

  private down(e: PointerEvent): void {
    if (!this.on || this.skipDrag()) return;
    const mods = [e.ctrlKey && "Ctrl", e.altKey && "Alt", e.shiftKey && "Shift"].filter(Boolean).join(" + ");
    const label = `${mods ? `${mods} + ` : ""}${BUTTONS[e.button] ?? "Mouse"} drag`;
    this.drag = { x: e.clientX, y: e.clientY, label, el: null };
  }

  private move(e: PointerEvent): void {
    const d = this.drag;
    if (!d || d.el || Math.hypot(e.clientX - d.x, e.clientY - d.y) < DRAG_PX) return;
    // Shown while dragging, then fades like a key.
    d.el = this.flash(d.label, false, true);
  }

  private up(): void {
    const el = this.drag?.el;
    this.drag = null;
    if (el) setTimeout(() => this.fade(el), SHOW_MS);
  }

  private flash(text: string, typed: boolean, hold = false): HTMLDivElement {
    const l = this.last;
    if (l && !typed && l.text === text && l.el.isConnected && !hold) {
      l.count++;
      this.refresh(l);
      return l.el;
    }
    const el = document.createElement("div");
    el.className = "kc-line";
    this.box.appendChild(el);
    while (this.box.children.length > MAX_LINES) this.box.firstElementChild!.remove();
    this.last = { el, text, at: 0, count: 1, typed };
    this.refresh(this.last, hold);
    return el;
  }

  private refresh(l: NonNullable<KeyCast["last"]>, hold = false): void {
    l.at = performance.now();
    l.el.textContent = l.count > 1 ? `${l.text}  ×${l.count}` : l.text;
    l.el.classList.remove("kc-out");
    clearTimeout(Number(l.el.dataset.timer));
    if (!hold) l.el.dataset.timer = String(setTimeout(() => this.fade(l.el), SHOW_MS));
  }

  private fade(el: HTMLDivElement): void {
    el.classList.add("kc-out");
    setTimeout(() => el.remove(), 400);
  }
}
