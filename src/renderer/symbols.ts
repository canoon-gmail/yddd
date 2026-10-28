/**
 * Text → Symbols: a grid of symbols (hearts, faces, stars...) to put in the text — all drawn by the built-in
 * Noto Sans Symbols / Symbols 2 (the Text tool's fallback for letters a font hasn't got), so each one prints.
 */
import symbols1 from "../../vendor/fonts/NotoSansSymbols-Regular.ttf?url";
import symbols2 from "../../vendor/fonts/NotoSansSymbols2-Regular.ttf?url";

/** The symbols by row: [character, name]. */
export const SYMBOLS: { row: string; items: [string, string][] }[] = [
  { row: "Hearts", items: [["♥", "Heart"], ["♡", "White heart"], ["❤", "Heavy heart"], ["❥", "Rotated heart"], ["❣", "Heart exclamation"], ["❦", "Floral heart"], ["❧", "Rotated floral heart"]] },
  { row: "Faces", items: [["☺", "Smiling face"], ["☻", "Black smiling face"], ["☹", "Frowning face"], ["☠", "Skull and crossbones"]] },
  { row: "Stars", items: [["★", "Star"], ["☆", "White star"], ["✦", "Four-pointed star"], ["✧", "White four-pointed star"], ["✪", "Circled star"], ["✯", "Pinwheel star"], ["❄", "Snowflake"], ["✻", "Teardrop asterisk"]] },
  { row: "Nature", items: [["✿", "Flower"], ["❀", "White flower"], ["❁", "Eight-petal flower"], ["⚘", "Flower"], ["☘", "Shamrock"], ["☀", "Sun"], ["☼", "Sun with rays"], ["☾", "Moon"], ["☁", "Cloud"], ["☂", "Umbrella"], ["☃", "Snowman"]] },
  { row: "Music", items: [["♪", "Note"], ["♫", "Two notes"], ["♬", "Sixteenth notes"], ["♩", "Quarter note"]] },
  { row: "Marks", items: [["✓", "Check"], ["✔", "Heavy check"], ["✗", "Cross"], ["✖", "Heavy cross"], ["⚡", "Lightning"], ["☯", "Yin yang"], ["☮", "Peace"], ["⚓", "Anchor"], ["⚠", "Warning"], ["♻", "Recycle"], ["⚙", "Gear"], ["☢", "Radioactive"]] },
  { row: "Things", items: [["✈", "Plane"], ["☎", "Phone"], ["✉", "Envelope"], ["✂", "Scissors"], ["✎", "Pencil"], ["☕", "Hot drink"], ["⚽", "Football"], ["⌛", "Hourglass"], ["⚑", "Flag"], ["✌", "Victory hand"]] },
  { row: "Cards", items: [["♠", "Spade"], ["♣", "Club"], ["♦", "Diamond"], ["♥", "Heart"], ["♤", "White spade"], ["♧", "White club"], ["♢", "White diamond"]] },
  { row: "Chess", items: [["♚", "King"], ["♛", "Queen"], ["♞", "Knight"]] },
  { row: "Arrows", items: [["➜", "Arrow"], ["➤", "Arrowhead"], ["←", "Left"], ["↑", "Up"], ["→", "Right"], ["↓", "Down"]] },
  { row: "Signs", items: [["♀", "Female"], ["♂", "Male"], ["♈", "Aries"], ["✝", "Cross"], ["✡", "Star of David"], ["☪", "Star and crescent"]] },
];

const NAMES = new Map(SYMBOLS.flatMap((r) => r.items));
const RECENT_KEY = "yddd.textSymbols.recent";
const RECENT_MAX = 8;

const recent = (): string[] => {
  try {
    const r = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(r) ? r.filter((c): c is string => typeof c === "string" && NAMES.has(c)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
};

/** The symbol fonts for the grid (the same files the text is made from: what is shown is what prints). */
let fontsAdded = false;
function addFonts(): void {
  if (fontsAdded) return;
  fontsAdded = true;
  for (const [name, url] of [["YDDD Symbols 2", symbols2], ["YDDD Symbols", symbols1]]) {
    const f = new FontFace(name, `url(${url})`);
    document.fonts.add(f);
    void f.load().catch(() => {});
  }
}

let open: { el: HTMLElement; close: () => void } | null = null;

/** Close the symbol grid (if open). */
export function closeSymbols(): void {
  open?.close();
}

/**
 * Open the symbol grid under `button`: a click (or Enter on one) puts the symbol into `text` at its cursor
 * (replacing a selection) and calls `changed`; the grid stays open for more. Esc / a click outside closes it.
 */
export function openSymbols(button: HTMLElement, text: HTMLTextAreaElement, changed: () => void): void {
  if (open) return closeSymbols();
  addFonts();
  const el = document.createElement("div");
  el.id = "symbol-pop";
  const btn = (c: string) => `<button type="button" data-c="${c}" title="${NAMES.get(c)}">${c}</button>`;
  const rows = [...SYMBOLS];
  const rc = recent();
  if (rc.length) rows.push({ row: "Recent", items: rc.map((c) => [c, NAMES.get(c)!]) });
  el.innerHTML = rows.map((r) => `<div class="sym-row"><span>${r.row}</span><div>${r.items.map(([c]) => btn(c)).join("")}</div></div>`).join("");
  document.body.appendChild(el);
  // (beside the panel the button is in, its top level with the button: the panel's fields and Create stay in view)
  const r = button.getBoundingClientRect(), side = (button.closest("#tool-panel") ?? button).getBoundingClientRect();
  el.style.left = `${Math.max(8, Math.min(side.right + 6, window.innerWidth - el.offsetWidth - 8))}px`;
  el.style.top = `${Math.max(8, Math.min(r.top, window.innerHeight - el.offsetHeight - 8))}px`;
  button.classList.add("on");

  const insert = (c: string) => {
    const a = text.selectionStart ?? text.value.length, b = text.selectionEnd ?? a;
    text.setRangeText(c, a, b, "end");
    localStorage.setItem(RECENT_KEY, JSON.stringify([c, ...recent().filter((x) => x !== c)].slice(0, RECENT_MAX)));
    changed();
  };
  // (a press doesn't take the focus from the text: its cursor stays where the symbol goes)
  el.addEventListener("pointerdown", (e) => e.preventDefault());
  el.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("button[data-c]");
    if (b) insert(b.dataset.c!);
  });
  const all = () => [...el.querySelectorAll<HTMLButtonElement>("button[data-c]")];
  el.addEventListener("keydown", (e) => {
    const list = all(), i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") return void (e.preventDefault(), e.stopPropagation(), close(), text.focus());
    if (e.key === "Enter" || e.key === " ") return void (e.preventDefault(), e.stopPropagation(), i >= 0 && insert(list[i].dataset.c!));
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    const vert = { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (step === undefined && vert === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    if (step !== undefined) return list[Math.max(0, Math.min(list.length - 1, i + step))]?.focus();
    // up / down: the nearest button in the row above / below
    const rowEls = [...el.querySelectorAll(".sym-row")], cur = list[i], ri = rowEls.findIndex((x) => x.contains(cur));
    const next = rowEls[Math.max(0, Math.min(rowEls.length - 1, ri + vert!))];
    const x = cur.getBoundingClientRect().left;
    const pick = [...next.querySelectorAll<HTMLButtonElement>("button")].reduce((best, b) => (Math.abs(b.getBoundingClientRect().left - x) < Math.abs(best.getBoundingClientRect().left - x) ? b : best));
    pick.focus();
  });
  // Esc / arrows from the text box while the grid is open: Esc closes it, Down goes into it
  const onTextKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" && e.altKey) {
      e.preventDefault();
      all()[0]?.focus();
    }
  };
  text.addEventListener("keydown", onTextKey);
  const onDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node) && !button.contains(e.target as Node)) close();
  };
  window.addEventListener("pointerdown", onDown, true);
  const close = () => {
    el.remove();
    button.classList.remove("on");
    text.removeEventListener("keydown", onTextKey);
    window.removeEventListener("pointerdown", onDown, true);
    open = null;
  };
  open = { el, close };
}
