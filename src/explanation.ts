import { existsSync, readFileSync } from "node:fs";
import type { Extract } from "./extract/index.js";

export type Attention = "careful" | "skim" | "mechanical";

/** What the explain step writes: the prose a reviewer reads beside each changed symbol. */
export interface Explanation {
  title: string;
  intent: string;
  /** Reading order. Omitted: one chapter per decision, in the order they were made. */
  chapters?: { title: string; summary?: string; symbols: string[] }[];
  symbols: Record<string, {
    summary: string;
    attention: Attention;
    why?: string;
    how?: string;
    risk?: string;
    /** Decisions linked here beyond what the log records (shown as linked afterwards). */
    decisions?: string[];
    related?: string[];
  }>;
}

export function readExplanation(path: string): Explanation | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

interface CheckResult {
  errors: string[];
  /** Symbols without a summary, or missing from explicit chapters. */
  missing: string[];
}

const ATTN = new Set(["careful", "skim", "mechanical"]);

/** Every changed symbol gets a summary and an attention level; every reference must resolve. */
export function check(x: Extract, n: Explanation): CheckResult {
  const errors: string[] = [];
  const ids = new Set(x.symbols.map((s) => s.id));
  const decs = new Set(x.decisions.map((d) => d.id));
  const placed = new Map<string, number>();

  if (!n.title?.trim()) errors.push("title is empty");
  if (!n.intent?.trim()) errors.push("intent is empty");
  (n.chapters ?? []).forEach((c, i) => {
    if (!c.title?.trim()) errors.push(`chapter ${i + 1} has no title`);
    if (!Array.isArray(c.symbols)) { errors.push(`chapter ${i + 1}: symbols must be a list`); return; }
    for (const id of c.symbols) {
      if (!ids.has(id)) errors.push(`chapter ${i + 1} lists unknown symbol ${id}`);
      else if (placed.has(id)) errors.push(`${id} is in chapters ${placed.get(id)! + 1} and ${i + 1}`);
      else placed.set(id, i);
    }
  });
  for (const [id, note] of Object.entries(n.symbols ?? {})) {
    if (!ids.has(id)) { errors.push(`entry for unknown symbol ${id}`); continue; }
    if (!ATTN.has(note.attention)) errors.push(`${id}: attention must be careful, skim or mechanical`);
    for (const d of note.decisions ?? []) if (!decs.has(d)) errors.push(`${id}: unknown decision ${d}`);
    for (const r of note.related ?? []) if (!ids.has(r)) errors.push(`${id}: related symbol ${r} does not exist`);
  }
  const missing = x.symbols
    .filter((s) => !n.symbols?.[s.id]?.summary?.trim() || (n.chapters?.length && !placed.has(s.id)))
    .map((s) => s.id);
  return { errors, missing };
}
