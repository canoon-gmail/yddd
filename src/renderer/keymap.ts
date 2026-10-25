/**
 * Shortcuts: every command YDDD can run, its default keys, the user's own (localStorage), and the "/" panel to
 * search them all and change their keys.
 *
 * A shortcut's name: "B", "Shift+F", "Ctrl+Shift+S", "Num5", "Delete", "?", "Space", a two-key chord "B C" (the
 * first key's own command, if any, runs at once — the second switches to the chord's), or a mouse side button
 * "Mouse4" / "Ctrl+Mouse5". (No other spaces: a space parts a chord's keys. Shown with one: "Num 5", "Mouse 4".)
 *
 * The view's mouse gestures (nav.orbit / nav.pan / nav.zoom) are kept the same way: "MiddleDrag", "Alt+LeftDrag",
 * "Shift+RightDrag", "Wheel" (the wheel with or without keys held — a two-finger slide or a pinch on a touchpad too)
 * or "Ctrl+Wheel" (only with Ctrl held).
 */

export interface Command {
  cmd: string;
  label: string;
  group: string;
}

/** Everything the "/" panel lists, in its groups' order. */
export const COMMANDS: Command[] = [
  ...grp("File", [
    ["file.new", "New"],
    ["file.open", "Open…"],
    ["file.save", "Save"],
    ["file.saveAs", "Save As…"],
    ["file.importStep", "Import STEP…"],
    ["file.importStl", "Import STL…"],
    ["file.exportStep", "Export STEP…"],
    ["file.exportStl", "Export STL…"],
    ["file.export3mf", "Export 3MF… (Bambu Studio, PrusaSlicer, Cura)"],
    ["file.settings", "Settings…"],
  ]),
  ...grp("Edit", [
    ["edit.undo", "Undo"],
    ["edit.redo", "Redo"],
    ["edit.delete", "Delete"],
    ["edit.duplicate", "Duplicate"],
    ["edit.copy", "Copy"],
    ["edit.paste", "Paste (a copy, as Duplicate)"],
    ["edit.selectAll", "Select all"],
    ["edit.group", "Group"],
    ["edit.ungroup", "Ungroup"],
    ["edit.clearGuides", "Clear all guides"],
  ]),
  ...grp("Select", [
    ["mode.body", "Solid mode"],
    ["mode.face", "Face mode"],
    ["mode.edge", "Edge mode"],
  ]),
  ...grp("Solid", [
    ["tool.box", "Box"],
    ["tool.cylinder", "Cylinder"],
    ["tool.sphere", "Sphere"],
    ["tool.cone", "Cone"],
  ]),
  ...grp("Face", [
    ["tool.rectangle", "Rectangle"],
    ["tool.circle", "Circle"],
    ["tool.polygon", "Polygon"],
    ["tool.text", "Text"],
    ["tool.sketch", "Sketch"],
  ]),
  ...grp("Modify", [
    ["op.pushpull", "Push/Pull"],
    ["op.fillet", "Fillet"],
    ["op.chamfer", "Chamfer"],
    ["op.shell", "Shell"],
    ["op.offset", "Offset"],
    ["op.revolve", "Revolve"],
    ["op.sweep", "Sweep"],
    ["op.cut", "Cut by guide or axis"],
    ["op.splitFace", "Split face by guide"],
    ["tool.divideFace", "Draw line on face"],
    ["tool.guide", "Guide line"],
  ]),
  ...grp("Boolean", [
    ["bool.union", "Union"],
    ["bool.subtract", "Subtract"],
    ["bool.intersect", "Intersect"],
  ]),
  ...grp("Transform", [
    ["xf.move", "Move"],
    ["xf.moveFrom", "Move from point"],
    ["xf.rotate", "Rotate"],
    ["xf.scale", "Scale"],
    ["xf.repeat", "Repeat last move / rotate"],
    ["edit.mirror", "Mirror"],
    ["edit.array", "Array copy"],
    ["edit.circular", "Circular copy"],
  ]),
  ...grp("Measure", [["tool.measure", "Measure"]]),
  ...grp("Mouse: move the view", [
    ["nav.orbit", "Orbit (turn the view round)"],
    ["nav.pan", "Pan (slide the view)"],
    ["nav.zoom", "Zoom to the cursor"],
  ]),
  ...grp("View", [
    ["view.fit", "Fit all"],
    ["view.fitSelection", "Fit selection"],
    ["view.menu", "View menu (pick a view)"],
    ["view.iso", "Iso view"],
    ["view.top", "Top view"],
    ["view.front", "Front view"],
    ["view.right", "Right view"],
    ["view.flip", "Opposite side view"],
    ["view.xray", "X-ray on / off"],
    ["view.pro", "Pro layout (less text) on / off"],
    ["view.clearRecent", "Clear recent tools"],
  ]),
  ...grp("Macro", [
    ["macro.box", "Box from Face…"],
    ["macro.lidIn", "Box Lid: Inside Lip…"],
    ["macro.lidOver", "Box Lid: Over the Box…"],
    ["macro.dividers", "Dividers…"],
    ["macro.battery", "Battery case…"],
    ["macro.gridfinity", "Gridfinity bin…"],
    ["macro.baseplate", "Gridfinity baseplate…"],
  ]),
  ...grp("Help", [
    ["help.keys", "Shortcuts: search, change keys"],
    ["help.shortcuts", "Keyboard shortcuts (help)"],
    ["help.birdhouse", "Walkthrough: Bird House"],
    ["help.cablebox", "Walkthrough: Cable Storage Box"],
    ["help.house", "Walkthrough: House"],
    ["help.planter", "Walkthrough: Planter"],
    ["help.propeller", "Walkthrough: Propeller"],
  ]),
];

function grp(group: string, items: [string, string][]): Command[] {
  return items.map(([cmd, label]) => ({ cmd, label, group }));
}

/** The keys YDDD comes with (a command missing here has none). */
export const DEFAULT_KEYS: Record<string, string[]> = {
  "file.new": ["Ctrl+N"],
  "file.open": ["Ctrl+O"],
  "file.save": ["Ctrl+S"],
  "file.saveAs": ["Ctrl+Shift+S"],
  "file.exportStl": ["Ctrl+Shift+E"],
  "edit.undo": ["Ctrl+Z"],
  "edit.redo": ["Ctrl+R", "Ctrl+Shift+Z"],
  "edit.delete": ["X", "Delete"],
  "edit.duplicate": ["Shift+D", "Ctrl+D"],
  "edit.copy": ["Ctrl+C"],
  "edit.paste": ["Ctrl+V"],
  "edit.selectAll": ["Ctrl+A"],
  "edit.group": ["Ctrl+G"],
  "edit.ungroup": ["Ctrl+Shift+G"],
  "mode.body": ["1"],
  "mode.face": ["2"],
  "mode.edge": ["3"],
  "tool.box": ["B", "B B"],
  "tool.cylinder": ["B C"],
  "tool.sphere": ["B S"],
  "tool.cone": ["B O"],
  "tool.rectangle": ["A", "A A", "A R"],
  "tool.circle": ["A C"],
  "tool.polygon": ["A P"],
  "tool.text": ["T", "A T"],
  "tool.sketch": ["K"],
  "op.pushpull": ["P", "Space"],
  "op.fillet": ["F"],
  "op.chamfer": ["Shift+F"],
  "op.shell": ["H"],
  "op.offset": ["O"],
  "op.revolve": ["R E"],
  "op.sweep": ["S W"],
  "op.cut": ["C"],
  "op.splitFace": ["Shift+C"],
  "tool.divideFace": ["D"],
  "tool.guide": ["Shift+G"],
  "bool.union": ["Shift+U", "+", "Num+"],
  "bool.subtract": ["Shift+S", "-", "Num-"],
  "bool.intersect": ["Shift+I"],
  "xf.move": ["G"],
  "xf.moveFrom": ["G G"],
  "xf.rotate": ["R"],
  "xf.scale": ["S"],
  "xf.repeat": ["Shift+R"],
  "edit.mirror": ["M"],
  "tool.measure": ["="],
  "view.fit": ["Home"],
  "view.fitSelection": ["."],
  "view.menu": ["V"],
  "view.iso": ["5", "Num5"],
  "view.top": ["7", "Num7"],
  "view.front": ["Num1"], // top-row "1" stays Solid mode
  "view.right": ["Num3"], // top-row "3" stays Edge mode
  "view.xray": ["Shift+X"],
  "view.pro": ["Ctrl+Shift+D"], // (hidden: see HIDDEN)
  "help.keys": ["/"],
  "help.shortcuts": ["F1", "?"],
  "nav.orbit": ["MiddleDrag", "Alt+LeftDrag"],
  "nav.pan": ["Shift+LeftDrag", "Shift+MiddleDrag", "Ctrl+MiddleDrag"],
  "nav.zoom": ["Wheel"],
};

/** The view's mouse gestures (not keys: they can't be run, only changed). */
export const isNav = (cmd: string): boolean => cmd.startsWith("nav.");
export type NavAction = "orbit" | "pan" | "zoom";
export type NavGestures = Record<NavAction, string[]>;
export const navGestures = (keys: Keys): NavGestures => ({ orbit: keys["nav.orbit"] ?? [], pan: keys["nav.pan"] ?? [], zoom: keys["nav.zoom"] ?? [] });

const mouseMods = (e: MouseEvent) => `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}`;
/** A mouse press's gesture name ("Shift+MiddleDrag"; null: not the left / middle / right button), or the wheel's ("Ctrl+Wheel"). */
export function dragGesture(e: MouseEvent): string | null {
  const b = ["LeftDrag", "MiddleDrag", "RightDrag"][e.button];
  return b ? mouseMods(e) + b : null;
}
export const wheelGesture = (e: WheelEvent): string => mouseMods(e) + "Wheel";
/** What a drag does to the view (null: nothing — e.g. a plain left drag, which selects and draws). */
export function navAction(nav: NavGestures, gesture: string): NavAction | null {
  return (["orbit", "pan", "zoom"] as const).find((a) => nav[a].includes(gesture)) ?? null;
}
/** Whether the wheel (with these keys held) zooms: "Wheel" — with any keys —, or exactly this one. */
export const wheelZooms = (nav: NavGestures, gesture: string): boolean => nav.zoom.includes("Wheel") || nav.zoom.includes(gesture);

/** Why a gesture can't move the view this way, or null. */
export function checkGesture(g: string, cmd: string): string | null {
  if (!/^((Ctrl|Alt|Shift)\+)*(LeftDrag|MiddleDrag|RightDrag|Wheel)$/.test(g)) return "Drag with the left (with Alt / Shift), middle or right button, or turn the wheel";
  if (g.endsWith("Wheel") && cmd !== "nav.zoom") return "The wheel only zooms";
  if (g === "LeftDrag") return "A plain left drag selects and draws — hold Alt or Shift with it";
  if (g.endsWith("LeftDrag") && g.includes("Ctrl+") && !g.includes("Alt+")) return "Ctrl + left drag turns snapping off while drawing — hold Alt with it too";
  return null;
}

/** Not listed in the keys panel (still work): the Pro layout is a secret switch. */
export const HIDDEN = new Set(["view.pro"]);

/** Pro layout only: S W sweep (S starts Scale, W switches) · R E revolve (R starts Rotate, E switches). */
export const PRO_ONLY = new Set(["S W", "R E"]);

export type Keys = Record<string, string[]>;

const STORE = "yddd.keys";

/** Every command's keys: the defaults, with the user's own in place of a changed command's. */
export function loadKeys(): Keys {
  const keys: Keys = {};
  for (const c of COMMANDS) keys[c.cmd] = [...(DEFAULT_KEYS[c.cmd] ?? [])];
  try {
    const own = JSON.parse(localStorage.getItem(STORE) ?? "{}") as Keys;
    for (const [cmd, ks] of Object.entries(own)) if (cmd in keys && Array.isArray(ks)) keys[cmd] = ks.filter((k) => typeof k === "string");
  } catch {
    // (unreadable: the defaults)
  }
  return keys;
}

/** Saves only the commands whose keys differ from the defaults. */
export function saveKeys(keys: Keys): void {
  const own: Keys = {};
  for (const [cmd, ks] of Object.entries(keys)) if (!isDefault(keys, cmd)) own[cmd] = ks;
  if (Object.keys(own).length) localStorage.setItem(STORE, JSON.stringify(own));
  else localStorage.removeItem(STORE);
}

export const isDefault = (keys: Keys, cmd: string): boolean => {
  const a = keys[cmd] ?? [], b = DEFAULT_KEYS[cmd] ?? [];
  return a.length === b.length && a.every((k, i) => k === b[i]);
};

/** The keys as the app looks them up: a key → its command; a chord's first key → its second keys → their commands. */
export function keyTable(keys: Keys, pro: boolean): { single: Map<string, string>; chords: Map<string, Record<string, string>> } {
  const single = new Map<string, string>(), chords = new Map<string, Record<string, string>>();
  for (const [cmd, ks] of Object.entries(keys))
    for (const k of ks) {
      if ((PRO_ONLY.has(k) && !pro) || isNav(cmd)) continue;
      const [a, b] = k.split(" ");
      if (b === undefined) single.set(k, cmd);
      else (chords.get(a) ?? chords.set(a, {}).get(a)!)[b] = cmd;
    }
  return { single, chords };
}

// ---------------------------------------------------------------- key names

const NUMPAD: Record<string, string> = { Add: "+", Subtract: "-", Multiply: "*", Divide: "/", Decimal: ".", Enter: "Enter", Equal: "=", Comma: "," };
/** Punctuation by key position (a non-Latin layout, e.g. Thai, types its own letters there): [plain, with Shift]. */
const US: Record<string, [string, string]> = {
  Slash: ["/", "?"], Equal: ["=", "+"], Minus: ["-", "_"], Period: [".", ">"], Comma: [",", "<"], Semicolon: [";", ":"],
  Quote: ["'", '"'], BracketLeft: ["[", "{"], BracketRight: ["]", "}"], Backslash: ["\\", "|"], Backquote: ["`", "~"],
};

/** A key press's shortcut name (null: a modifier key alone). Shift shows only where it isn't in the character (? not Shift+/). */
export function eventKey(e: KeyboardEvent): string | null {
  if (["Control", "Shift", "Alt", "Meta", "AltGraph", "CapsLock", "NumLock", "Dead", "Unidentified"].includes(e.key)) return null;
  const mods = (shift: boolean) => `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${shift && e.shiftKey ? "Shift+" : ""}`;
  const code = e.code ?? "";
  if (code.startsWith("Numpad")) return mods(true) + "Num" + (NUMPAD[code.slice(6)] ?? code.slice(6));
  if (/^Key[A-Z]$/.test(code)) return mods(true) + code[3];
  if (/^Digit\d$/.test(code)) return mods(true) + code[5];
  if (e.key === " " || code === "Space") return mods(true) + "Space";
  if (e.key.length === 1) {
    if (/[a-z]/i.test(e.key)) return mods(true) + e.key.toUpperCase();
    if (/\d/.test(e.key)) return mods(true) + e.key;
    const ch = e.key.charCodeAt(0) > 127 && US[code] ? US[code][e.shiftKey ? 1 : 0] : e.key;
    return mods(false) + ch;
  }
  return mods(true) + e.key; // Delete, Home, F1, ArrowUp, Backspace…
}

/** A mouse press's shortcut name: the side buttons only (left / middle / right drive the view and the tools). */
export function mouseKey(e: MouseEvent): string | null {
  if (e.button !== 3 && e.button !== 4) return null;
  return `${e.ctrlKey || e.metaKey ? "Ctrl+" : ""}${e.altKey ? "Alt+" : ""}${e.shiftKey ? "Shift+" : ""}Mouse${e.button + 1}`;
}

const hasMods = (k: string) => /^(Ctrl|Alt|Shift)\+./.test(k);
const MENU_ALT: Record<string, string> = { F: "File", E: "Edit", V: "View", M: "Macro", H: "Help" };

/** Why a key can't be a shortcut, or null. */
export function checkKey(k: string): string | null {
  const parts = k.split(" ").filter((p) => p !== "");
  if (/Mouse\d$/.test(k)) return null;
  if (parts.length > 2 || k.includes("  ")) return "A shortcut is one key, or two keys one after the other";
  if (parts.length === 2) return parts.some((p) => p.length !== 1) ? "A two-key shortcut takes two plain letter / number / sign keys (no Ctrl / Alt / Shift)" : null;
  const base = k.replace(/^((Ctrl|Alt|Shift)\+)+/, "");
  if (["Escape", "Enter", "Tab", "NumEnter"].includes(base) && !hasMods(k)) return `${base === "Escape" ? "Esc" : base} is used by every tool and panel (done, cancel, type exact values)`;
  if (k === "Ctrl+Q") return "Ctrl+Q quits YDDD";
  if (k === "F11") return "F11 is full screen";
  if (k === "Ctrl+Shift+I") return "Ctrl+Shift+I opens the developer tools";
  if (/^Ctrl\+Shift\+[1-9]$/.test(k)) return `${k} opens a recent file (File → Open Recent)`;
  const alt = /^Alt\+([A-Z])$/.exec(k);
  if (alt && MENU_ALT[alt[1]]) return `${k} opens the ${MENU_ALT[alt[1]]} menu`;
  return null;
}

/** As shown: Del, arrows, Pro-only chords marked. */
export function keyText(k: string): string {
  const shown = k.replace(/Delete$/, "Del").replace(/(Num|Mouse)(.+)$/, "$1 $2").replace(/(Left|Middle|Right)Drag$/, "$1 drag").replace(/ArrowUp$/, "↑").replace(/ArrowDown$/, "↓").replace(/ArrowLeft$/, "←").replace(/ArrowRight$/, "→");
  return PRO_ONLY.has(k) ? `Pro: ${shown}` : shown;
}

/** A command's keys for a tooltip / label ("" if none). */
export const keysText = (keys: Keys, cmd: string): string => (keys[cmd] ?? []).map(keyText).join(" · ");

/** The menu's accelerator for a shortcut (shown only — YDDD handles the key itself), or null if the menu can't show it. */
export function accelerator(k: string): string | null {
  if (k.includes(" ") || /Mouse\d$/.test(k)) return null; // (a chord, a mouse button)
  const m = /^((?:(?:Ctrl|Alt|Shift)\+)*)(.+)$/.exec(k)!;
  const mods = m[1].replace("Ctrl+", "CmdOrCtrl+");
  let key = m[2];
  if (/^Num./.test(key)) {
    const n = key.slice(3);
    key = /^\d$/.test(n) ? `num${n}` : ({ "+": "numadd", "-": "numsub", "*": "nummult", "/": "numdiv", ".": "numdec" } as Record<string, string>)[n] ?? "";
  } else if (key === "+") key = "Plus";
  else if (key.startsWith("Arrow")) key = key.slice(5);
  if (!key || !/^([A-Z0-9]|F\d{1,2}|Space|Home|End|Delete|Insert|PageUp|PageDown|Backspace|Up|Down|Left|Right|Plus|num\w+|[!-~])$/.test(key)) return null;
  return mods + key;
}

/** The menu's accelerators: each menu command's first key the menu can show ("" = none). */
export function menuAccelerators(keys: Keys): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [cmd, ks] of Object.entries(keys)) if (!isNav(cmd)) out[cmd] = ks.map(accelerator).find((a) => a) ?? "";
  return out;
}

// ---------------------------------------------------------------- the "/" panel

export interface KeysHost {
  keys(): Keys;
  setKeys(keys: Keys): void;
  run(cmd: string): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const label = (cmd: string) => COMMANDS.find((c) => c.cmd === cmd)?.label ?? cmd;
/** Capture: how long to wait for a chord's second key (ms). */
const CHORD_WAIT = 1000;

/** "/": every command in two columns — the operation (click: run it) and its keys (click: change, +: add, ×: remove, ↺: default). */
export function openKeysPanel(host: KeysHost): void {
  if (closeKeysPanel()) return;
  let keys = structuredClone(host.keys());
  /** Waiting for a new key: the command, which of its keys (-1: a new one), a chord's first key. */
  let capture: { cmd: string; i: number; first?: string; timer?: number } | null = null;
  /** A key another command has, waiting for "Use it here". */
  let pending: { cmd: string; i: number; key: string; owner: string } | null = null;
  let msg: { cmd: string; text: string; error: boolean } | null = null;

  const panel = document.createElement("div");
  panel.id = "keys-panel";
  panel.innerHTML =
    `<div class="kp-head"><h4>Shortcuts</h4><input type="search" placeholder="Search operations or keys…" spellcheck="false"><button type="button" class="kp-close" title="Close (Esc)">×</button></div>` +
    `<div class="kp-note">Click an operation to run it · click a key to change it, <b>+</b> to add one (a key, two keys one after the other, or mouse side button 4 / 5; Orbit / Pan / Zoom: a mouse drag or the wheel) · <b>↺</b> back to the default</div>` +
    `<div class="kp-list"><table><thead><tr><th>Operation</th><th>Shortcut</th></tr></thead><tbody></tbody></table></div>` +
    `<div class="kp-foot"><button type="button" class="btn" data-act="reset-all" title="Every command back to the keys YDDD comes with">Restore all defaults</button><button type="button" class="btn primary" data-act="close">Done</button></div>`;
  const search = panel.querySelector<HTMLInputElement>("input[type=search]")!;
  const body = panel.querySelector("tbody")!;

  const commit = (next: Keys) => {
    keys = next;
    host.setKeys(structuredClone(keys));
  };
  const owner = (k: string, except: string) => Object.keys(keys).find((c) => c !== except && keys[c].includes(k));

  const render = () => {
    const q = search.value.trim().toLowerCase();
    // A key typed in full (ctrl+s) finds just that key; part of one (ctrl) finds every key with it.
    const named = (k: string) => [k.toLowerCase(), keyText(k).toLowerCase()];
    const whole = !!q && Object.values(keys).some((ks) => ks.some((k) => named(k).includes(q)));
    let html = "", group = "";
    for (const c of COMMANDS) {
      if (HIDDEN.has(c.cmd)) continue;
      const ks = keys[c.cmd] ?? [];
      const hit = !q || `${c.label} ${c.group} ${c.cmd}`.toLowerCase().includes(q) || ks.some((k) => (whole ? named(k).includes(q) : named(k).some((n) => n.includes(q))));
      if (!hit) continue;
      if (c.group !== group) {
        group = c.group;
        html += `<tr class="kp-group"><th colspan="2">${esc(group)}</th></tr>`;
      }
      const chips = ks
        .map((k, i) =>
          PRO_ONLY.has(k) && !document.body.classList.contains("pro")
            ? "" // (the Pro layout's own keys: shown only there)
            : capture && capture.cmd === c.cmd && capture.i === i
            ? `<span class="kp-key wait">${capture.first ? `${esc(capture.first)} …` : isNav(c.cmd) ? "Press a button…" : "Press a key…"}</span>`
            : `<span class="kp-key"><kbd data-i="${i}" title="Click: change it">${esc(keyText(k))}</kbd><button type="button" class="kp-del" data-i="${i}" title="Remove ${esc(keyText(k))}">×</button></span>`,
        )
        .join("");
      const adding = capture && capture.cmd === c.cmd && capture.i < 0 ? `<span class="kp-key wait">${capture.first ? `${esc(capture.first)} …` : isNav(c.cmd) ? "Press a button…" : "Press a key…"}</span>` : "";
      const reset = isDefault(keys, c.cmd) ? "" : `<button type="button" class="kp-reset" title="Back to the default: ${esc((DEFAULT_KEYS[c.cmd] ?? []).map(keyText).join(" · ") || "no key")}">↺</button>`;
      let note = "";
      if (pending && pending.cmd === c.cmd)
        note = `<div class="kp-msg warn">${esc(keyText(pending.key))} is <b>${esc(label(pending.owner))}</b>'s key <button type="button" class="btn" data-act="take">Use it here</button><button type="button" class="btn" data-act="keep">Cancel</button></div>`;
      else if (msg && msg.cmd === c.cmd) note = `<div class="kp-msg${msg.error ? " error" : ""}">${esc(msg.text)}</div>`;
      else if (capture && capture.cmd === c.cmd)
        note = `<div class="kp-msg">${
          isNav(c.cmd)
            ? `Press the mouse button you'll drag with — holding Ctrl / Alt / Shift if you like${c.cmd === "nav.zoom" ? " — or turn the wheel" : ""} · Esc: cancel`
            : capture.first ? "A second key makes a two-key shortcut — or wait" : "Press the new key (with Ctrl / Alt / Shift if you like), two keys one after the other, or mouse button 4 / 5 · Esc: cancel"
        }</div>`;
      const op = isNav(c.cmd) ? `<span class="kp-label">${esc(c.label)}</span>` : `<button type="button" class="kp-run" title="Run it">${esc(c.label)}</button>`;
      html += `<tr data-cmd="${c.cmd}"><td class="kp-op">${op}</td><td><div class="kp-keys">${chips}${adding}<button type="button" class="kp-add" title="Add a key">+</button>${reset}${note}</div></td></tr>`;
    }
    body.innerHTML = html || `<tr><td colspan="2" class="kp-none">Nothing matches "${esc(search.value)}"</td></tr>`;
  };

  const stopCapture = () => {
    if (capture?.timer) clearTimeout(capture.timer);
    capture = null;
  };
  /** A new key for capture's command: checked, then in place (or waiting for "Use it here" if another command has it). */
  const place = (k: string) => {
    const { cmd, i } = capture!;
    stopCapture();
    const why = isNav(cmd) ? checkGesture(k, cmd) : checkKey(k);
    if (why) {
      msg = { cmd, text: why, error: true };
      return render();
    }
    if (keys[cmd].includes(k) && keys[cmd][i] !== k) {
      msg = { cmd, text: `${keyText(k)} is already one of its keys`, error: true };
      return render();
    }
    const other = owner(k, cmd);
    if (other) {
      pending = { cmd, i, key: k, owner: other };
      return render();
    }
    put(cmd, i, k);
  };
  const put = (cmd: string, i: number, k: string, from?: string) => {
    const next = structuredClone(keys);
    if (from) next[from] = next[from].filter((x) => x !== k);
    if (i < 0) next[cmd].push(k);
    else next[cmd][i] = k;
    const [a] = k.split(" ");
    const startsChord = k.includes(" ") && !next[cmd].includes(a) && Object.values(next).some((ks) => ks.includes(a));
    msg = { cmd, text: from ? `${keyText(k)}: taken from ${label(from)}` : isNav(cmd) ? `${keyText(k)} set` : startsChord ? `${a} runs ${label(Object.keys(next).find((c) => next[c].includes(a))!)} at once, then the 2nd key switches` : `${keyText(k)} set`, error: false };
    commit(next);
    render();
  };

  const onKey = (e: KeyboardEvent) => {
    if (capture) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (e.key === "Escape") {
        stopCapture();
        return render();
      }
      const k = eventKey(e);
      if (!k) return;
      if (isNav(capture.cmd)) {
        msg = { cmd: capture.cmd, text: "Orbit / Pan / Zoom take a mouse drag or the wheel, not a key", error: true };
        stopCapture();
        return render();
      }
      if (capture.first) return place(`${capture.first} ${k}`);
      if (k.length !== 1) return place(k); // (with Ctrl / Alt / Shift, F1, Delete, Space…)
      // A plain letter / number / sign: maybe the first of two — wait a moment for a second one.
      capture.first = k;
      capture.timer = window.setTimeout(() => place(k), CHORD_WAIT);
      return render();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (pending) {
        pending = null;
        return render();
      }
      return void closeKeysPanel();
    }
    if (e.key === "Enter" && e.target === search) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const first = body.querySelector<HTMLElement>("tr[data-cmd]")?.dataset.cmd;
      if (first) {
        closeKeysPanel();
        host.run(first);
      }
      return;
    }
    e.stopImmediatePropagation(); // (the app's shortcuts wait while the panel is open; typing in the search box still types)
  };
  // Orbit / Pan / Zoom: the button pressed (with the keys held) — a plain left click in the panel just cancels.
  const onPointer = (e: PointerEvent) => {
    if (!capture || !isNav(capture.cmd)) return;
    const plain = e.button === 0 && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
    if (plain && e.target instanceof Node && panel.contains(e.target)) {
      stopCapture();
      return;
    }
    e.preventDefault();
    e.stopImmediatePropagation();
    const g = dragGesture(e);
    if (g) return place(g);
    msg = { cmd: capture.cmd, text: "Use the left (with Alt / Shift), middle or right button", error: true };
    stopCapture();
    render();
  };
  const onWheel = (e: WheelEvent) => {
    if (!capture || !isNav(capture.cmd)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    place(wheelGesture(e));
  };
  const onMouse = (e: MouseEvent) => {
    if (capture && isNav(capture.cmd)) return; // (onPointer has it)
    const k = mouseKey(e);
    if (!k) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (capture) place(k);
  };

  panel.addEventListener("click", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>("tr[data-cmd]"), cmd = row?.dataset.cmd;
    if (t.closest("[data-act=close]") || t.closest(".kp-close")) return void closeKeysPanel();
    if (t.closest("[data-act=reset-all]")) {
      stopCapture();
      pending = null;
      msg = null;
      const next: Keys = {};
      for (const c of COMMANDS) next[c.cmd] = [...(DEFAULT_KEYS[c.cmd] ?? [])];
      commit(next);
      return render();
    }
    if (!cmd) return;
    if (t.closest(".kp-run")) {
      closeKeysPanel();
      return host.run(cmd);
    }
    if (t.closest("[data-act=take]") && pending) {
      const p = pending;
      pending = null;
      return put(p.cmd, p.i, p.key, p.owner);
    }
    if (t.closest("[data-act=keep]")) {
      pending = null;
      return render();
    }
    stopCapture();
    pending = null;
    msg = null;
    if (t.closest(".kp-reset")) {
      // Back to the default; a default key another command has taken since goes back too.
      const next = structuredClone(keys), taken: string[] = [];
      next[cmd] = [...(DEFAULT_KEYS[cmd] ?? [])];
      for (const k of next[cmd])
        for (const c of Object.keys(next))
          if (c !== cmd && next[c].includes(k)) {
            next[c] = next[c].filter((x) => x !== k);
            taken.push(`${keyText(k)} from ${label(c)}`);
          }
      msg = { cmd, text: taken.length ? `Default keys back (taken back: ${taken.join(", ")})` : "Default keys back", error: false };
      commit(next);
      return render();
    }
    const del = t.closest<HTMLElement>(".kp-del");
    if (del) {
      const next = structuredClone(keys);
      next[cmd].splice(Number(del.dataset.i), 1);
      commit(next);
      return render();
    }
    const kbd = t.closest<HTMLElement>("kbd[data-i]");
    if (kbd || t.closest(".kp-add")) {
      capture = { cmd, i: kbd ? Number(kbd.dataset.i) : -1 };
      render();
      panel.focus();
    }
  });
  search.addEventListener("input", render);

  panel.tabIndex = -1;
  document.body.appendChild(panel);
  window.addEventListener("keydown", onKey, true);
  window.addEventListener("mousedown", onMouse, true);
  window.addEventListener("pointerdown", onPointer, true);
  window.addEventListener("wheel", onWheel, { capture: true, passive: false });
  closers.push(() => {
    stopCapture();
    window.removeEventListener("keydown", onKey, true);
    window.removeEventListener("mousedown", onMouse, true);
    window.removeEventListener("pointerdown", onPointer, true);
    window.removeEventListener("wheel", onWheel, true);
    panel.remove();
  });
  render();
  search.focus();
}

const closers: (() => void)[] = [];
/** Closes the "/" panel; false if it wasn't open. */
export function closeKeysPanel(): boolean {
  if (!closers.length) return false;
  for (const c of closers.splice(0)) c();
  return true;
}
export const keysPanelOpen = (): boolean => closers.length > 0;
