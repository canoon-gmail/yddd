/**
 * Stopwatch (hidden, Ctrl + Shift + F5): at the top right of the view, with Start / Stop and Reset — for
 * timing jobs in videos. Shown / hidden by the key; keeps running while hidden.
 */
export class Stopwatch {
  private box: HTMLDivElement;
  private time: HTMLSpanElement;
  private startBtn: HTMLButtonElement;
  /** Time counted before the current run, and when the current run started (null: stopped). */
  private before = 0;
  private since: number | null = null;
  private timer = 0;

  constructor(view: HTMLElement) {
    this.box = document.createElement("div");
    this.box.id = "stopwatch";
    this.box.hidden = true;
    this.time = document.createElement("span");
    this.time.className = "stopwatch-time";
    this.startBtn = this.button("Start", () => this.toggle());
    const reset = this.button("Reset", () => this.reset());
    this.box.append(this.time, this.startBtn, reset);
    view.appendChild(this.box);
    this.show();
    window.addEventListener("keydown", (e) => {
      if (e.key !== "F5" || !e.ctrlKey || !e.shiftKey) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      this.box.hidden = !this.box.hidden;
    }, { capture: true });
  }

  private button(text: string, onClick: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = text;
    b.tabIndex = -1; // (Space / Enter stay the app's)
    b.addEventListener("pointerdown", (e) => e.stopPropagation());
    b.addEventListener("click", onClick);
    return b;
  }

  private elapsed(): number {
    return this.before + (this.since === null ? 0 : performance.now() - this.since);
  }

  private toggle(): void {
    if (this.since === null) {
      this.since = performance.now();
      this.timer = window.setInterval(() => this.show(), 31);
    } else {
      this.before = this.elapsed();
      this.since = null;
      clearInterval(this.timer);
    }
    this.startBtn.textContent = this.since === null ? "Start" : "Stop";
    this.show();
  }

  private reset(): void {
    this.before = 0;
    if (this.since !== null) this.since = performance.now();
    this.show();
  }

  private show(): void {
    const ms = this.elapsed();
    const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, cs = Math.floor(ms / 10) % 100;
    this.time.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
  }
}
