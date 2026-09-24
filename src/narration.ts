import { existsSync, readFileSync } from "node:fs";
import type { Extract } from "./extract/index.js";

export type Attention = "careful" | "skim" | "mechanical";

export interface SymbolNote {
  summary: string;
  attention: Attention;
  why?: string;
  how?: string;
  risk?: string;
  /** Decisions the narrator links beyond what was recorded at edit time. Shown as "linked later". */
  decisions?: string[];
  related?: string[];
}

export interface Narration {
  title: string;
  intent: string;
  chapters: { title: string; summary: string; symbols: string[] }[];
  symbols: Record<string, SymbolNote>;
}

export function readNarration(path: string): Narration | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

export interface CheckResult {
  errors: string[];
  missing: string[];
}

const ATTN = new Set(["careful", "skim", "mechanical"]);

/** Every changed symbol must be narrated and placed in exactly one chapter; every reference must resolve. */
export function check(x: Extract, n: Narration): CheckResult {
  const errors: string[] = [];
  const ids = new Set(x.symbols.map((s) => s.id));
  const decs = new Set(x.decisions.map((d) => d.id));
  const placed = new Map<string, number>();

  if (!n.title?.trim()) errors.push("title is empty");
  if (!n.intent?.trim()) errors.push("intent is empty");
  (n.chapters ?? []).forEach((c, i) => {
    if (!c.title?.trim()) errors.push(`chapter ${i + 1} has no title`);
    for (const id of c.symbols ?? []) {
      if (!ids.has(id)) errors.push(`chapter ${i + 1} lists unknown symbol ${id}`);
      else if (placed.has(id)) errors.push(`${id} is in chapters ${placed.get(id)! + 1} and ${i + 1}`);
      else placed.set(id, i);
    }
  });
  for (const [id, note] of Object.entries(n.symbols ?? {})) {
    if (!ids.has(id)) { errors.push(`notes for unknown symbol ${id}`); continue; }
    if (!note.summary?.trim()) errors.push(`${id}: summary is empty`);
    if (!ATTN.has(note.attention)) errors.push(`${id}: attention must be careful, skim or mechanical`);
    for (const d of note.decisions ?? []) if (!decs.has(d)) errors.push(`${id}: unknown decision ${d}`);
    for (const r of note.related ?? []) if (!ids.has(r)) errors.push(`${id}: related symbol ${r} does not exist`);
  }
  const missing = x.symbols.filter((s) => !placed.has(s.id) || !n.symbols?.[s.id]).map((s) => s.id);
  return { errors, missing };
}
