/** The undo history saved in a .yddd file. */
import type { PictureRecord } from "./picture";
import type { ArrayRecord, Body, Dimension, GearRecord, GroupLooks, Guide, Look, TextRecord } from "./document";

/** Undo steps a saved file keeps (and redo steps): reopened, Undo goes back that far. */
export const SAVED_HISTORY = 50;
/** ...unless the history's own shapes reach this much text first (e.g. a big STL moved many times). */
export const HISTORY_BYTES = 30e6;

/** One undo / redo step in a file: its bodies as references (see modelText). */
export interface SavedStep {
  label: string;
  bodies: number[];
  guides?: Guide[];
  dims?: Dimension[];
  arrays?: ArrayRecord[];
  looks?: GroupLooks;
}

/** The undo history part of a .yddd file. */
export interface SavedHistory {
  ids: number[];
  dims?: Dimension[];
  arrays?: ArrayRecord[];
  bodies: { id: number; name: string; kind: Body["kind"]; group?: string; text?: TextRecord; look?: Look; locked?: true; picture?: PictureRecord; gear?: GearRecord; s: number }[];
  shapes: string[];
  undo: SavedStep[];
  redo: SavedStep[];
  counters?: [string, number][];
  nextId?: number;
}
