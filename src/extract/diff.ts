import { diffArrays, diffLines } from "diff";
import type { FileSymbols, Sym } from "./symbols.js";

/**
 * One diff line. `gap` stands for elided unchanged lines.
 * `p` is provenance for changed lines: an edit id, "outside", or "before" (filled in by extract);
 * `pa` is an added line's number in the version that edit wrote.
 */
export interface Row {
  t: " " | "+" | "-" | "gap";
  o?: number;
  n?: number;
  s: string;
  p?: string;
  pa?: number;
}

export type Status = "added" | "removed" | "modified" | "moved";

export interface SymChange {
  key: string;
  kind: string;
  name: string;
  sig: string;
  /** The declaration's line: in the new file, or the old one for a removed symbol. */
  line?: number;
  status: Status;
  rows: Row[];
  /** Exact source, used to detect cross-file moves. */
  body: string;
  note?: string;
}

const CONTEXT = 3;
const FULL_UNDER = 40;

/** Align two versions of a file line by line. */
export function align(oldText: string, newText: string): Row[] {
  const rows: Row[] = [];
  let o = 1, n = 1;
  for (const part of diffLines(oldText, newText)) {
    const lines = part.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    for (const s of lines) {
      if (part.added) rows.push({ t: "+", n: n++, s });
      else if (part.removed) rows.push({ t: "-", o: o++, s });
      else rows.push({ t: " ", o: o++, n: n++, s });
    }
  }
  return rows;
}

/** Keep changed rows plus a little context; long unchanged runs become a gap row. */
export function compress(rows: Row[], context = CONTEXT): Row[] {
  if (rows.length <= FULL_UNDER) return rows;
  const keep = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.t === " " || r.t === "gap") return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  keep[0] = true;
  // Hiding a few lines saves nothing and loses the thread; only longer runs become a gap.
  for (let i = 0; i < rows.length; ) {
    let j = i;
    while (j < rows.length && !keep[j] && rows[j].t !== "gap") j++;
    if (j - i < 4) for (let k = i; k < j; k++) keep[k] = true;
    i = Math.max(j, i + 1);
  }
  const out: Row[] = [];
  let skipped = 0;
  const flush = () => {
    if (skipped) out.push({ t: "gap", s: `${skipped} unchanged line${skipped > 1 ? "s" : ""}` });
    skipped = 0;
  };
  rows.forEach((r, i) => {
    if (keep[i] || r.t === "gap") { flush(); out.push(r); } else skipped++;
  });
  flush();
  return out;
}

const baseKey = (k: string) => k.replace(/#\d+$/, "");

/**
 * Symbol-level changes for one file. Every changed line ends up in exactly one change:
 * symbols first, then "other" hunks for whatever no symbol claims (reorders, wrappers,
 * whitespace, end-of-file newlines). Nothing that differs is ever dropped.
 */
export function diffFile(oldText: string | null, newText: string | null, oldSyms: FileSymbols | null, newSyms: FileSymbols | null, rows = align(oldText ?? "", newText ?? "")): SymChange[] {
  if (!oldSyms && !newSyms) {
    if (!rows.some((r) => r.t !== " ")) return [];
    const status: Status = oldText == null ? "added" : newText == null ? "removed" : "modified";
    return [{ key: "file", kind: "file", name: "(whole file)", sig: "", status, rows: status === "modified" ? compress(rows) : rows, body: "" }];
  }

  const byOld = new Map<number, Row>(), byNew = new Map<number, Row>();
  const at = new Map<Row, number>();
  rows.forEach((r, i) => {
    at.set(r, i);
    if (r.o != null) byOld.set(r.o, r);
    if (r.n != null) byNew.set(r.n, r);
  });

  // Phase 1: symbol changes, holding their raw rows until blank-line neighbours are attached.
  type Pending = Omit<SymChange, "rows"> & { raw: Row[] };
  const pending: Pending[] = [];
  const owner = new Map<Row, Pending>();
  const claim = (p: Pending) => { p.raw.forEach((r) => { if (!owner.has(r)) owner.set(r, p); }); pending.push(p); };
  // An unchanged line shown as one side of a symbol's change; it keeps its place in the file's order.
  const side = (r: Row, t: "+" | "-"): Row => {
    const copy: Row = t === "+" ? { t, n: r.n, s: r.s } : { t, o: r.o, s: r.s };
    at.set(copy, at.get(r)!);
    return copy;
  };
  // Lines moved between symbols: align this symbol's own old and new lines afresh, so a line that stayed
  // (the closing brace of a constructor whose body went to a new overload) reads as context, not removed and re-added.
  const realign = (raw: Row[]): Row[] => {
    const o = raw.filter((r) => r.t !== "+"), n = raw.filter((r) => r.t !== "-");
    const out: Row[] = [];
    let i = 0, j = 0;
    for (const part of diffArrays(o.map((r) => r.s), n.map((r) => r.s))) {
      for (let k = 0; k < part.value.length; k++) {
        if (part.removed) { const r = o[i++]; out.push(r.t === "-" ? r : side(r, "-")); continue; }
        if (part.added) { const r = n[j++]; out.push(r.t === "+" ? r : side(r, "+")); continue; }
        const a = o[i++], b = n[j++];
        if (a === b) { out.push(a); continue; }
        const r: Row = { t: " ", o: a.o, n: b.n, s: b.s };
        at.set(r, at.get(b)!);
        out.push(r);
      }
    }
    return out;
  };
  // Which symbols appeared or disappeared whole (the group-wrapper rule below needs to know).
  const status = new Map<string, "added" | "removed">();

  // Pair symbols by key; duplicates (overloads, several init()) pair by exact content first, then by order.
  const group = (syms: Sym[]) => {
    const m = new Map<string, Sym[]>();
    for (const s of syms) m.set(baseKey(s.key), [...(m.get(baseKey(s.key)) ?? []), s]);
    return m;
  };
  const olds = group(oldSyms?.syms ?? []), news = group(newSyms?.syms ?? []);
  for (const k of new Set([...olds.keys(), ...news.keys()])) {
    const oList = [...(olds.get(k) ?? [])], nList = [...(news.get(k) ?? [])];
    for (const n of [...nList]) {
      const i = oList.findIndex((o) => o.cmp === n.cmp);
      if (i >= 0) { oList.splice(i, 1); nList.splice(nList.indexOf(n), 1); }
    }
    while (oList.length && nList.length) {
      const a = oList.shift()!, b = nList.shift()!;
      const ownO = new Set(a.own), ownN = new Set(b.own);
      // An unchanged line that left this symbol (or joined it) is, for this symbol, removed (or added):
      // an old constructor's body now in a new overload isn't this constructor's context.
      let moved = false;
      const raw = rows.flatMap((r) => {
        if (r.t === "-") return ownO.has(r.o!) ? [r] : [];
        if (r.t === "+") return ownN.has(r.n!) ? [r] : [];
        if (r.t !== " ") return [];
        const o = ownO.has(r.o!), n = ownN.has(r.n!);
        if (o !== n) moved = true;
        return o && n ? [r] : o ? [side(r, "-")] : n ? [side(r, "+")] : [];
      });
      const note = a.iota != null && b.iota != null && a.iota !== b.iota ? `implicit iota value moved from position ${a.iota} to ${b.iota}` : undefined;
      const p: Pending = { ...meta(b), status: "modified", raw, body: b.cmp, ...(note ? { note } : {}) };
      claim(p);
      if (moved) p.raw = realign(raw);
    }
    for (const b of nList) {
      status.set(b.key, "added");
      claim({ ...meta(b), status: "added", raw: b.own.map((n) => byNew.get(n)).filter((x): x is Row => !!x && x.t !== "-").map((r) => (r.t === " " ? side(r, "+") : r)), body: b.cmp });
    }
    for (const a of oList) {
      status.set(a.key, "removed");
      claim({ ...meta(a), status: "removed", raw: a.own.map((o) => byOld.get(o)).filter((x): x is Row => !!x && x.t !== "+").map((r) => (r.t === " " ? side(r, "-") : r)), body: a.cmp });
    }
  }
  const attach = (r: Row, to: Pending) => {
    to.raw.push(r);
    to.raw.sort((x, y) => at.get(x)! - at.get(y)!);
    owner.set(r, to);
  };

  // A group that appeared or disappeared whole (`import (` … `)`): its wrapper lines travel with its first member.
  for (const [groups, want, line, t] of [[newSyms?.groups, "added", byNew, "+"], [oldSyms?.groups, "removed", byOld, "-"]] as const) {
    for (const g of groups ?? []) {
      if (!g.members.length || !g.members.every((k) => status.get(k) === want)) continue;
      const first = pending.find((p) => p.key === g.members[0] && p.status === want);
      const last = pending.find((p) => p.key === g.members[g.members.length - 1] && p.status === want);
      if (!first || !last) continue;
      const start = at.get(first.raw[0]) ?? 0;
      for (const l of g.lines) {
        const r = line.get(l);
        if (r?.t === t && !owner.has(r)) attach(r, at.get(r)! < start ? first : last);
      }
    }
  }

  // Phase 2: changed blank lines touching a symbol change travel with it (spacing around a new function).
  const changedLoose = (i: number) => rows[i] && rows[i].t !== " " && !owner.has(rows[i]);
  for (let pass = 0; pass < 2; pass++) {
    const order = pass === 0 ? rows.map((_, i) => i) : rows.map((_, i) => rows.length - 1 - i);
    for (const i of order) {
      if (!changedLoose(i) || rows[i].s.trim() !== "") continue;
      const nb = owner.get(rows[pass === 0 ? i - 1 : i + 1]);
      if (nb) attach(rows[i], nb);
    }
  }

  const out: SymChange[] = pending.map(({ raw, ...c }) => ({ ...c, rows: c.status === "modified" ? compress(withGaps(raw)) : withGaps(raw) }));

  // Phase 3: everything else that changed becomes an "other" hunk. Nothing is dropped.
  const loose = rows.map((r) => r.t !== " " && !owner.has(r));
  let i = 0;
  while (i < rows.length) {
    if (!loose[i]) { i++; continue; }
    // Changes whose context would touch are one hunk; context never repeats lines a symbol shows.
    let j = i;
    for (;;) {
      let k = j + 1;
      while (k < rows.length && !loose[k] && rows[k].t === " " && k - j <= 5) k++;
      if (k < rows.length && loose[k] && k - j <= 5) j = k;
      else break;
    }
    const free = (x: number) => rows[x].t === " " && !owner.has(rows[x]);
    let from = i, to = j;
    for (let k = 0; k < 2 && from > 0 && free(from - 1); k++) from--;
    for (let k = 0; k < 2 && to + 1 < rows.length && free(to + 1); k++) to++;
    const hunk = rows.slice(from, to + 1);
    const changed = rows.slice(i, j + 1).filter((r) => r.t !== " ");
    // Named by the new file's lines when it has any, else the old file's; never a mix.
    const inNew = changed.some((r) => r.n != null);
    const nums = changed.map((r) => (inNew ? r.n : r.o)).filter((x): x is number => x != null);
    const first = changed[0];
    const plus = changed.filter((r) => r.t === "+").map((r) => r.s).sort();
    const minus = changed.filter((r) => r.t === "-").map((r) => r.s).sort();
    const what = changed.every((r) => r.s.trim() === "")
      ? "whitespace"
      : plus.length && plus.join("\n") === minus.join("\n")
        ? j === rows.length - 1 && (oldText ?? "").endsWith("\n") !== (newText ?? "").endsWith("\n") ? "end-of-file newline" : "reordered lines"
        : "lines";
    out.push({
      key: `other@${first.n ?? `o${first.o}`}`,
      kind: "other",
      name: Math.min(...nums) === Math.max(...nums) ? `${what.replace(/^lines$/, "line")} ${nums[0]}` : `${what} ${Math.min(...nums)}–${Math.max(...nums)}`,
      sig: "",
      status: newText == null ? "removed" : oldText == null ? "added" : "modified",
      rows: compress(hunk),
      body: "",
    });
    i = j + 1;
  }

  return out.sort((x, y) => firstLine(x) - firstLine(y));
}

function meta(s: Sym) {
  return { key: s.key, kind: s.kind, name: s.name, sig: s.sig, line: s.line };
}

/** Insert a gap marker where line numbers jump (e.g. a class shell with its members lifted out). */
function withGaps(rows: Row[]): Row[] {
  const out: Row[] = [];
  let prevO: number | undefined, prevN: number | undefined;
  for (const r of rows) {
    const jump = (r.o != null && prevO != null && r.o > prevO + 1) || (r.n != null && prevN != null && r.n > prevN + 1);
    if (jump) { out.push({ t: "gap", s: "members shown separately" }); prevO = prevN = undefined; } // the gap covers both sides' skip
    out.push(r);
    if (r.o != null) prevO = r.o;
    if (r.n != null) prevN = r.n;
  }
  return out;
}

export function firstLine(c: SymChange): number {
  return c.rows.find((r) => r.n != null)?.n ?? c.rows.find((r) => r.o != null)?.o ?? 0;
}
