/**
 * Calculator (Help → Calculator): a small one at the bottom right of the view, closed by its ×. Its line takes the
 * keyboard while it has focus (number pad too: digits, + − × ÷, Enter =, Backspace, Delete / Esc clear) — the app's
 * keys don't run then; a click in the view gives them back.
 */
export class Calculator {
  private box: HTMLDivElement;
  private line: HTMLInputElement;
  private last: HTMLDivElement;
  /** The line shows a result just worked out: a digit typed next starts a new sum, an operator goes on from it. */
  private shown = false;

  constructor(view: HTMLElement) {
    this.box = document.createElement("div");
    this.box.id = "calculator";
    this.box.hidden = true;
    const head = document.createElement("div");
    head.className = "calc-head";
    const title = document.createElement("span");
    title.textContent = "Calculator";
    const close = this.button("×", () => this.close(), "calc-close");
    close.title = "Close";
    head.append(title, close);
    this.last = document.createElement("div");
    this.last.className = "calc-last";
    this.line = document.createElement("input");
    this.line.className = "calc-line";
    this.line.spellcheck = false;
    this.line.autocomplete = "off";
    this.line.addEventListener("keydown", (e) => this.key(e));
    // (only what a sum is made of: typed or pasted)
    this.line.addEventListener("input", () => {
      const clean = this.line.value.replace(/[^0-9.+\-*/()% ]/g, "");
      if (clean !== this.line.value) this.line.value = clean;
    });
    const pad = document.createElement("div");
    pad.className = "calc-pad";
    for (const k of ["C", "(", ")", "÷", "7", "8", "9", "×", "4", "5", "6", "−", "1", "2", "3", "+", "0", ".", "⌫", "="]) {
      pad.append(this.button(k, () => this.press(k), k === "=" ? "calc-eq" : /[0-9.]/.test(k) ? "" : "calc-op"));
    }
    this.box.append(head, this.last, this.line, pad);
    // (clicks on it stay here: not a pick in the view)
    this.box.addEventListener("pointerdown", (e) => e.stopPropagation());
    this.box.addEventListener("pointerup", () => this.line.focus());
    view.appendChild(this.box);
  }

  /** Help → Calculator: shown (focused, ready to type); again: closed. */
  toggle(): void {
    if (!this.box.hidden) return this.close();
    this.box.hidden = false;
    this.line.focus();
    this.line.select();
  }

  private close(): void {
    this.box.hidden = true;
    this.line.blur();
  }

  private button(text: string, onClick: () => void, cls = ""): HTMLButtonElement {
    const b = document.createElement("button");
    b.textContent = text;
    if (cls) b.className = cls;
    b.tabIndex = -1; // (the line keeps the focus)
    b.addEventListener("click", onClick);
    return b;
  }

  private key(e: KeyboardEvent): void {
    e.stopPropagation(); // (none of the app's keys while typing here)
    if (e.key === "Enter" || e.key === "=") {
      e.preventDefault();
      this.press("=");
    } else if (e.key === "Escape" || e.key === "Delete") {
      e.preventDefault();
      this.press("C");
    } else if (this.shown && /^[0-9.]$/.test(e.key)) {
      this.line.value = ""; // (a new sum after a result)
      this.shown = false;
    } else if (e.key.length === 1) this.shown = false;
  }

  private press(k: string): void {
    const ops: Record<string, string> = { "÷": "/", "×": "*", "−": "-", "+": "+" };
    if (k === "C") {
      this.line.value = "";
      this.last.textContent = "";
    } else if (k === "⌫") this.line.value = this.line.value.slice(0, -1);
    else if (k === "=") {
      const sum = this.line.value.trim();
      if (!sum) return;
      const v = evaluate(sum);
      this.last.textContent = `${sum} =`;
      this.line.value = v === null ? "Error" : format(v);
      this.shown = v !== null;
      this.line.select();
      this.line.focus();
      return;
    } else {
      if (this.line.value === "Error" || (this.shown && /[0-9.]/.test(k))) this.line.value = "";
      this.line.value += ops[k] ?? k;
    }
    this.shown = false;
    this.line.focus();
  }
}

/** A result shown: up to 10 decimals, no float noise (0.1 + 0.2 → 0.3). */
function format(v: number): string {
  return String(+v.toFixed(10));
}

/**
 * A sum worked out — + − * /, % (of 100), brackets, minus signs — by a small parser (no eval: only arithmetic can run).
 * Null if it isn't a sum or comes out not a number (÷ 0).
 */
export function evaluate(text: string): number | null {
  const s = text.replace(/\s+/g, "");
  let i = 0;
  const num = (): number => {
    if (s[i] === "(") {
      i++;
      const v = sum();
      if (s[i++] !== ")") throw new Error();
      return v;
    }
    if (s[i] === "-") return i++, -num();
    if (s[i] === "+") return i++, num();
    const m = /^(\d+\.?\d*|\.\d+)/.exec(s.slice(i));
    if (!m) throw new Error();
    i += m[0].length;
    let v = Number(m[0]);
    while (s[i] === "%") i++, (v /= 100);
    return v;
  };
  const product = (): number => {
    let v = num();
    while (s[i] === "*" || s[i] === "/") v = s[i++] === "*" ? v * num() : v / num();
    return v;
  };
  const sum = (): number => {
    let v = product();
    while (s[i] === "+" || s[i] === "-") v = s[i++] === "+" ? v + product() : v - product();
    return v;
  };
  try {
    const v = sum();
    return i === s.length && Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}
