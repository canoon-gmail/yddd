/**
 * The menu bar (File, Edit, View, Macro, Help) drawn by YDDD itself — not the system's: its text follows Settings →
 * UI Scale, it's in YDDD's colours, and it shows the shortcuts as they are now ("/" changes them). Mouse: click a
 * title, move along the titles while one is open, click an item. Keys: Alt (tapped) or F10 lights the titles, Alt+letter
 * opens one (the underlined letter), arrows move, Enter picks, Esc steps back.
 */

import { keysPanelOpen } from "./keymap";

/** A menu item: a command for the app, a system action (quit, reload…), a submenu, or the recent files. */
export type MenuItem =
  | { label: string; cmd: string; key?: string }
  | { label: string; act: AppAction; key?: string }
  | { label: string; sub: MenuItem[] }
  | { label: string; recent: true }
  | "-";

/** What only the app's main process can do. */
export type AppAction = "quit" | "reload" | "devtools" | "fullscreen" | "clear-recoveries";

/** The menus. "&" marks the letter Alt opens it with (the titles) — items have none. */
export const MENUS: { label: string; items: MenuItem[] }[] = [
  {
    label: "&File",
    items: [
      { label: "New", cmd: "file.new" },
      { label: "Open…", cmd: "file.open" },
      { label: "Open Picture…", cmd: "file.openPicture" },
      { label: "Open Recent", recent: true },
      { label: "Save", cmd: "file.save" },
      { label: "Save As…", cmd: "file.saveAs" },
      "-",
      { label: "Import STEP…", cmd: "file.importStep" },
      { label: "Import STL…", cmd: "file.importStl" },
      { label: "Export STEP…", cmd: "file.exportStep" },
      { label: "Export STL…", cmd: "file.exportStl" },
      { label: "Export 3MF… (Bambu Studio, PrusaSlicer, Cura)", cmd: "file.export3mf" },
      { label: "Save View as Image…", cmd: "file.exportImage" },
      "-",
      { label: "Settings…", cmd: "file.settings" },
      "-",
      { label: "Quit", act: "quit", key: "Ctrl+Q" },
    ],
  },
  {
    label: "&Edit",
    items: [
      { label: "Undo", cmd: "edit.undo" },
      { label: "Redo", cmd: "edit.redo" },
      "-",
      { label: "Duplicate", cmd: "edit.duplicate" },
      { label: "Repeat Last", cmd: "xf.repeat" },
      { label: "Delete", cmd: "edit.delete" },
      { label: "Select All", cmd: "edit.selectAll" },
      "-",
      { label: "Group", cmd: "edit.group" },
      { label: "Ungroup", cmd: "edit.ungroup" },
      { label: "Hide", cmd: "edit.hide" },
      "-",
      { label: "Clear All Guides", cmd: "edit.clearGuides" },
    ],
  },
  {
    label: "&View",
    items: [
      { label: "Fit All", cmd: "view.fit" },
      { label: "Top", cmd: "view.top" },
      { label: "Front", cmd: "view.front" },
      { label: "Right", cmd: "view.right" },
      { label: "Isometric", cmd: "view.iso" },
      "-",
      { label: "Clear Recent Tools", cmd: "view.clearRecent" },
      "-",
      { label: "Reload", act: "reload" },
      { label: "Toggle Developer Tools", act: "devtools", key: "Ctrl+Shift+I" },
      { label: "Toggle Full Screen", act: "fullscreen", key: "F11" },
    ],
  },
  {
    label: "&Macro",
    items: [
      { label: "Box from Face…", cmd: "macro.box" },
      { label: "Box Lid", sub: [{ label: "Inside Lip…", cmd: "macro.lidIn" }, { label: "Over the Box…", cmd: "macro.lidOver" }] },
      { label: "Dividers…", cmd: "macro.dividers" },
      "-",
      { label: "Battery Case…", cmd: "macro.battery" },
      { label: "Nut and Bolt…", cmd: "macro.nutBolt" },
      { label: "Gridfinity Bin…", cmd: "macro.gridfinity" },
      { label: "Gridfinity Baseplate…", cmd: "macro.baseplate" },
      { label: "Gear…", cmd: "macro.gear" },
      "-",
      { label: "Random…", cmd: "macro.random" },
    ],
  },
  {
    label: "&Help",
    items: [
      { label: "Shortcuts: Search & Change…", cmd: "help.keys" },
      { label: "Keyboard Shortcuts", cmd: "help.shortcuts" },
      { label: "Bird House", cmd: "help.birdhouse" },
      { label: "Cable Storage Box", cmd: "help.cablebox" },
      { label: "House", cmd: "help.house" },
      { label: "Planter", cmd: "help.planter" },
      { label: "Propeller", cmd: "help.propeller" },
      "-",
      { label: "Clear Old Recovery Files…", act: "clear-recoveries" },
    ],
  },
];

export interface MenuHost {
  run(cmd: string): void;
  action(act: AppAction): void;
  /** The shortcut shown by a command ("" none). */
  keyOf(cmd: string): string;
  /** Can it be used now (Undo with nothing to undo: no)? */
  enabled(cmd: string): boolean;
  recentFiles(): Promise<string[]>;
  openRecent(file: string): void;
  clearRecent(): void;
}

/** An item as drawn: what a click (or Enter) does, or the submenu it opens. */
type Shown = { el: HTMLElement; go?: () => void; sub?: () => Promise<Shown[]> | Shown[]; off: boolean };

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class MenuBar {
  /** The titles. */
  private tops: HTMLButtonElement[] = [];
  /** The menu open (index into MENUS), -1 none; its items and the one lit; a submenu open beside it. */
  private open = -1;
  private items: Shown[] = [];
  private lit = -1;
  private drop: HTMLElement | null = null;
  private sub: { el: HTMLElement; items: Shown[]; lit: number } | null = null;
  /** The titles lit for the keyboard (Alt tapped / F10), no menu open: which. */
  private focus = -1;
  /** Alt went down with nothing else since (let go: a tap). */
  private altTap = false;

  constructor(private bar: HTMLElement, private host: MenuHost) {
    MENUS.forEach((m, i) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "mb-top";
      b.dataset.i = String(i);
      b.innerHTML = esc(m.label).replace(/&amp;(.)/, "<u>$1</u>");
      b.addEventListener("pointerdown", (e) => {
        if (e.button !== 0) return;
        e.preventDefault(); // (the focus stays where it was)
        this.open === i ? this.close() : this.show(i, false);
      });
      b.addEventListener("pointerenter", () => {
        if (this.open >= 0 && this.open !== i) this.show(i, false);
      });
      bar.appendChild(b);
      this.tops.push(b);
    });
    // Outside the menus: closed (the press still goes where it was aimed)
    window.addEventListener("pointerdown", (e) => {
      if (this.open < 0 && this.focus < 0) return;
      if ((e.target as HTMLElement).closest("#menubar, .mb-drop")) return;
      this.close();
    }, true);
    window.addEventListener("blur", () => this.close());
    window.addEventListener("keydown", (e) => this.key(e), true);
    window.addEventListener("keyup", (e) => {
      if (e.key !== "Alt" || !this.altTap || keysPanelOpen()) return;
      this.altTap = false;
      if (this.open >= 0 || this.focus >= 0) this.close();
      else this.setFocus(0);
    }, true);
    // (Alt + left drag orbits: a press meanwhile — not a tap)
    window.addEventListener("pointerdown", () => (this.altTap = false), true);
  }

  /** Open or not (tests, and the app — a menu open takes the keys). */
  get active(): boolean {
    return this.open >= 0 || this.focus >= 0;
  }

  /** Test hook: a menu's items as shown now — label, shortcut, greyed (`path`: a submenu's, e.g. "Open Recent"). */
  async list(title: string, ...path: string[]): Promise<{ label: string; key: string; off: boolean }[]> {
    const i = MENUS.findIndex((m) => m.label.replace("&", "") === title);
    if (i < 0) return [];
    await this.show(i, false);
    let list = this.items;
    for (const p of path) {
      const it = list.find((x) => x.el.querySelector(".mb-label")?.textContent === p);
      if (!it?.sub) return this.close(), [];
      list = await this.openSub(it);
    }
    const out = list.map((x) => ({ label: x.el.querySelector(".mb-label")?.textContent ?? "", key: x.el.querySelector(".mb-key")?.textContent ?? "", off: x.off }));
    this.close();
    return out;
  }

  /** Test hook: pick an item ("File", "Settings…"; in a submenu: "Macro", "Box Lid", "Inside Lip…"). */
  async pick(title: string, ...path: string[]): Promise<boolean> {
    const i = MENUS.findIndex((m) => m.label.replace("&", "") === title);
    if (i < 0) return false;
    await this.show(i, false);
    let list = this.items;
    for (let k = 0; k < path.length; k++) {
      const it = list.find((x) => x.el.querySelector(".mb-label")?.textContent === path[k]);
      if (!it || it.off) return this.close(), false;
      if (k === path.length - 1) {
        if (!it.go) return this.close(), false;
        it.go();
        return true;
      }
      if (!it.sub) return this.close(), false;
      list = await this.openSub(it);
    }
    this.close();
    return false;
  }

  private setFocus(i: number): void {
    this.focus = i;
    this.bar.classList.toggle("keys", i >= 0);
    this.tops.forEach((b, k) => b.classList.toggle("focus", k === i));
  }

  close(): void {
    this.sub?.el.remove();
    this.sub = null;
    this.drop?.remove();
    this.drop = null;
    this.open = -1;
    this.items = [];
    this.lit = -1;
    this.tops.forEach((b) => b.classList.remove("open"));
    this.setFocus(-1);
  }

  /** Open menu `i` (from the keyboard: its first item lit). */
  private async show(i: number, keys: boolean): Promise<void> {
    this.close();
    this.open = i;
    if (keys) this.setFocus(i);
    this.tops[i].classList.add("open");
    const drop = document.createElement("div");
    drop.className = "mb-drop";
    this.items = this.build(MENUS[i].items, drop);
    const r = this.tops[i].getBoundingClientRect();
    drop.style.left = `${r.left}px`;
    drop.style.top = `${r.bottom}px`;
    document.body.appendChild(drop);
    this.drop = drop;
    if (keys) this.light(this.items.findIndex((x) => !x.off));
  }

  /** The items' rows in `box`. */
  private build(items: MenuItem[], box: HTMLElement): Shown[] {
    const out: Shown[] = [];
    for (const it of items) {
      if (it === "-") {
        box.appendChild(Object.assign(document.createElement("div"), { className: "mb-sep" }));
        continue;
      }
      const row = document.createElement("div");
      row.className = "mb-item";
      let shown: Shown;
      if ("cmd" in it) {
        const off = !this.host.enabled(it.cmd);
        shown = { el: row, off, go: () => (this.close(), this.host.run(it.cmd)) };
        row.innerHTML = `<span class="mb-label">${esc(it.label)}</span><span class="mb-key">${esc(this.host.keyOf(it.cmd) || it.key || "")}</span>`;
      } else if ("act" in it) {
        shown = { el: row, off: false, go: () => (this.close(), this.host.action(it.act)) };
        row.innerHTML = `<span class="mb-label">${esc(it.label)}</span><span class="mb-key">${esc(it.key ?? "")}</span>`;
      } else if ("sub" in it) {
        shown = { el: row, off: false, sub: () => this.build(it.sub, document.createElement("div")) };
        row.innerHTML = `<span class="mb-label">${esc(it.label)}</span><span class="mb-key">▸</span>`;
      } else {
        shown = { el: row, off: false, sub: () => this.recent() };
        row.innerHTML = `<span class="mb-label">${esc(it.label)}</span><span class="mb-key">▸</span>`;
      }
      row.classList.toggle("off", shown.off);
      const s = shown;
      row.addEventListener("pointerenter", () => {
        const list = this.sub?.items.includes(s) ? this.sub.items : this.items;
        if (list === this.items) {
          this.light(this.items.indexOf(s));
          if (s.sub) void this.openSub(s);
          else this.closeSub();
        } else this.lightSub(list.indexOf(s));
      });
      row.addEventListener("click", () => {
        if (s.off) return;
        if (s.go) s.go();
        else if (s.sub) void this.openSub(s);
      });
      box.appendChild(row);
      out.push(s);
    }
    return out;
  }

  /** Open Recent's rows: the files (Ctrl+Shift+1… the first nine), Clear Recent — or none yet. */
  private async recent(): Promise<Shown[]> {
    const files = await this.host.recentFiles();
    const box = document.createElement("div"), out: Shown[] = [];
    const row = (label: string, key: string, go: (() => void) | null): Shown => {
      const el = document.createElement("div");
      el.className = "mb-item" + (go ? "" : " off");
      el.innerHTML = `<span class="mb-label">${esc(label)}</span><span class="mb-key">${esc(key)}</span>`;
      const s: Shown = { el, off: !go, ...(go ? { go } : {}) };
      el.addEventListener("pointerenter", () => this.lightSub(out.indexOf(s)));
      el.addEventListener("click", () => go?.());
      box.appendChild(el);
      return s;
    };
    if (!files.length) out.push(row("No recent files", "", null));
    files.forEach((f, i) => {
      const name = f.split(/[\\/]/).pop() ?? f, dir = f.slice(0, f.length - name.length - 1);
      out.push(row(`${name}   ${dir}`, i < 9 ? `Ctrl+Shift+${i + 1}` : "", () => (this.close(), this.host.openRecent(f))));
    });
    if (files.length) {
      box.appendChild(Object.assign(document.createElement("div"), { className: "mb-sep" }));
      out.push(row("Clear Recent", "", () => (this.close(), this.host.clearRecent())));
    }
    return out;
  }

  private light(k: number): void {
    this.lit = k;
    this.items.forEach((x, n) => x.el.classList.toggle("lit", n === k));
  }

  private lightSub(k: number): void {
    if (!this.sub) return;
    this.sub.lit = k;
    this.sub.items.forEach((x, n) => x.el.classList.toggle("lit", n === k));
  }

  private closeSub(): void {
    this.sub?.el.remove();
    this.sub = null;
  }

  /** The submenu of item `s` beside it. */
  private async openSub(s: Shown): Promise<Shown[]> {
    if (this.sub && this.items[this.lit] === s) return this.sub.items;
    this.closeSub();
    const made = await s.sub!();
    const el = document.createElement("div");
    el.className = "mb-drop mb-sub";
    // (rows built in a box of their own: moved into the submenu)
    const first = made[0]?.el.parentElement;
    if (first) while (first.firstChild) el.appendChild(first.firstChild);
    const r = s.el.getBoundingClientRect();
    el.style.left = `${r.right - 2}px`;
    el.style.top = `${r.top - 4}px`;
    document.body.appendChild(el);
    this.sub = { el, items: made, lit: -1 };
    return made;
  }

  private key(e: KeyboardEvent): void {
    // (the "/" panel: a key pressed there is a shortcut being set — Ctrl+Q, F11, Alt+letter… all its own)
    if (keysPanelOpen()) return void (this.altTap = false);
    if (e.key === "Alt") {
      this.altTap = !e.repeat;
      return;
    }
    this.altTap = false;
    // Alt+letter: that menu (from anywhere but a field)
    const t = e.target as HTMLElement;
    const typing = t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT";
    if (e.altKey && !e.ctrlKey && !e.metaKey && !typing && /^Key[A-Z]$/.test(e.code)) {
      const letter = e.code.slice(3).toLowerCase();
      const i = MENUS.findIndex((m) => /&(.)/.exec(m.label)?.[1].toLowerCase() === letter);
      if (i >= 0) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void this.show(i, true);
      }
      return;
    }
    // (what the system's menu gave: Quit, Full Screen, Developer Tools)
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === "KeyQ") {
      e.preventDefault();
      e.stopImmediatePropagation();
      return this.host.action("quit");
    }
    if (e.key === "F11" && !e.ctrlKey && !e.altKey && !e.shiftKey) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return this.host.action("fullscreen");
    }
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyI") {
      e.preventDefault();
      e.stopImmediatePropagation();
      return this.host.action("devtools");
    }
    if (e.key === "F10" && !e.ctrlKey && !e.altKey && !typing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      if (this.active) this.close();
      else this.setFocus(0);
      return;
    }
    if (!this.active) return;
    // A menu open (or the titles lit): the keys are its own
    e.preventDefault();
    e.stopImmediatePropagation();
    const n = MENUS.length;
    if (this.open < 0) {
      // the titles lit
      if (e.key === "ArrowLeft") this.setFocus((this.focus + n - 1) % n);
      else if (e.key === "ArrowRight") this.setFocus((this.focus + 1) % n);
      else if (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ") void this.show(this.focus, true);
      else if (e.key === "Escape") this.close();
      else {
        const i = MENUS.findIndex((m) => /&(.)/.exec(m.label)?.[1].toLowerCase() === e.key.toLowerCase());
        if (i >= 0) void this.show(i, true);
      }
      return;
    }
    const step = (list: Shown[], from: number, d: number) => {
      for (let k = 1; k <= list.length; k++) {
        const j = (from + d * k + list.length * 2) % list.length;
        if (!list[j].off) return j;
      }
      return from;
    };
    if (this.sub && this.sub.lit >= 0) {
      const sub = this.sub;
      if (e.key === "ArrowDown") this.lightSub(step(sub.items, sub.lit, 1));
      else if (e.key === "ArrowUp") this.lightSub(step(sub.items, sub.lit, -1));
      else if (e.key === "ArrowLeft" || e.key === "Escape") this.lightSub(-1), this.closeSub();
      else if (e.key === "Enter" || e.key === " ") sub.items[sub.lit]?.go?.();
      return;
    }
    const cur = this.items[this.lit];
    if (e.key === "ArrowDown") this.light(step(this.items, this.lit, 1));
    else if (e.key === "ArrowUp") this.light(step(this.items, this.lit < 0 ? 0 : this.lit, -1));
    else if (e.key === "ArrowRight") {
      if (cur?.sub) void this.openSub(cur).then((list) => this.lightSub(list.findIndex((x) => !x.off)));
      else void this.show((this.open + 1) % n, true);
    } else if (e.key === "ArrowLeft") void this.show((this.open + n - 1) % n, true);
    else if (e.key === "Enter" || e.key === " ") {
      if (cur?.go) cur.go();
      else if (cur?.sub) void this.openSub(cur).then((list) => this.lightSub(list.findIndex((x) => !x.off)));
    } else if (e.key === "Escape") this.close();
  }
}
