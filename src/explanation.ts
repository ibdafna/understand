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
    /** Why this deserves that attention; required for careful and mechanical. */
    attentionReason?: string;
    /** why/how/risk: only what no recorded decision says (the page marks them as written afterwards). */
    why?: string;
    how?: string;
    risk?: string;
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
    else if (note.attention !== "skim" && !note.attentionReason?.trim()) errors.push(`${id}: say why it is ${note.attention} (attentionReason)`);
  }
  const missing = x.symbols
    .filter((s) => !n.symbols?.[s.id]?.summary?.trim() || (n.chapters?.length && !placed.has(s.id)))
    .map((s) => s.id);
  return { errors, missing };
}
