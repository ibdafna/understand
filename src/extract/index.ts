import { diffLines } from "diff";
import { execFileSync } from "node:child_process";
import { currentBranch, changedFiles, readAt, snapshot, treeOf, type FileChange } from "../git.js";
import type { Claim, Config, Decision, Edit, Store } from "../store.js";
import { align, diffFile, type Row, type Status, type SymChange } from "./diff.js";
import { hlLang, langOf, symbolsOf } from "./symbols.js";

export interface Gaps {
  /** Some changed lines came from outside any observed agent tool. */
  outside: boolean;
  /** Some changed lines predate recording (only with `init --base`). */
  before: boolean;
  /** Agent edits behind this symbol that no decision explains. */
  unlinked: string[];
}

export interface ExSymbol {
  id: string;
  file: string;
  kind: string;
  name: string;
  sig: string;
  status: Status;
  movedFrom?: string;
  note?: string;
  rows: Row[];
  edits: string[];
  /** Decisions recorded for these edits at the time (adoption, or --for claims from the same turn). */
  decisions: string[];
  /** Claims made in a different turn: shown, but never counted as explanation. */
  later: string[];
  gaps: Gaps;
  explained: boolean;
}

export interface ExFile {
  lang: string;
  status: "added" | "modified" | "deleted";
  note?: string;
}

export interface Extract {
  base: string;
  tree: string;
  branch: string;
  startedOn: string;
  generatedAt: string;
  sessions: string[];
  span: [string, string] | null;
  files: Record<string, ExFile>;
  decisions: Decision[];
  symbols: ExSymbol[];
  ignoredWrites: string[];
  warnings: string[];
}

type Change = SymChange & { file: string; movedFrom?: string; extra: Set<string> };

const LFS = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;
const isBinary = (s: string | null) => s != null && s.slice(0, 8000).includes("\0");

export async function extract(store: Store): Promise<Extract> {
  // One consistent instant: the worktree snapshot and every log it's explained by.
  const { cfg, tree, edits, decisions, links, claims, ignored } = store.withLock(() => ({
    cfg: store.config(),
    tree: snapshot(store),
    edits: store.edits(),
    decisions: store.decisions(),
    links: store.links(),
    claims: store.claims(),
    ignored: store.ignoredWrites(),
  }));
  const warnings: string[] = [];
  const baseTree = treeOf(store.root, cfg.base);
  const reader = cachedReader(store.root);

  const files: Record<string, ExFile> = {};
  const changes: Change[] = [];

  for (const ch of changedFiles(store.root, cfg.base, tree)) {
    const status = ch.status === "A" ? "added" : ch.status === "D" ? "deleted" : "modified";
    files[ch.path] = { lang: hlLang(ch.path), status };
    const fileLevel = (name: string, rows: Row[], note: string) => {
      files[ch.path].note = note;
      changes.push({ key: `file:${name}`, kind: "file", name, sig: "", status: status === "deleted" ? "removed" : status, rows, body: "", file: ch.path, extra: fileLabels(store.root, cfg, baseTree, tree, edits, ch.path) });
    };

    if (ch.oldMode === "160000" || ch.newMode === "160000") {
      fileLevel("(submodule)", modeRows(ch, (sha) => `Subproject commit ${sha}`), "submodule pointer");
      continue;
    }
    const oldText = ch.status === "A" ? null : reader(cfg.base, ch.path);
    const newText = ch.status === "D" ? null : reader(tree, ch.path);
    if (ch.status === "M" && ch.oldMode !== ch.newMode) fileLevel("(file mode)", [{ t: "-", s: `mode ${ch.oldMode}` }, { t: "+", s: `mode ${ch.newMode}` }], `mode ${ch.oldMode} → ${ch.newMode}`);
    if (isBinary(oldText) || isBinary(newText)) { fileLevel("(binary file)", [], "binary"); continue; }
    if (oldText === newText && ch.status === "M") continue; // mode-only change, already listed

    const special = ch.oldMode === "120000" || ch.newMode === "120000" ? "symlink" : LFS.test(oldText ?? "") || LFS.test(newText ?? "") ? "Git LFS pointer; content not shown" : null;
    const lang = special ? null : langOf(ch.path);
    let oldSyms = null, newSyms = null;
    if (lang) {
      try {
        oldSyms = oldText != null ? await symbolsOf(lang, oldText) : { syms: [], groups: [] };
        newSyms = newText != null ? await symbolsOf(lang, newText) : { syms: [], groups: [] };
      } catch (err) {
        warnings.push(`could not parse ${ch.path} (${(err as Error).message}); showing it as a whole-file change`);
        oldSyms = newSyms = null;
      }
    }
    if (special) files[ch.path].note = special;

    const rows = align(oldText ?? "", newText ?? "");
    const prov = track(cfg, baseTree, edits, ch.path, oldText, newText, reader);
    for (const r of rows) {
      if (r.t === "+") r.p = prov.added(r.n!, r.s);
      else if (r.t === "-") r.p = prov.removed(r.o!);
    }
    const found = diffFile(oldText, newText, oldSyms, newSyms, rows);
    if (!found.length) {
      // Bytes differ but no line shows it (an empty file added or deleted): still list it.
      fileLevel(oldText === "" || newText === "" || oldText == null || newText == null ? "(empty file)" : "(whole file)", rows, files[ch.path].note ?? "no line changes");
      continue;
    }
    const allLabels = new Set(rows.filter((r) => r.p).map((r) => r.p!));
    for (const c of found) {
      const hasChange = c.rows.some((r) => r.t === "+" || r.t === "-");
      // A symbol changed only by position (an implicit iota value) inherits the file's provenance.
      changes.push({ ...c, file: ch.path, extra: hasChange ? new Set() : new Set(allLabels) });
    }
  }

  detectMoves(changes);

  // Files the agent wrote that git ignores never reach the diff; say so.
  const ignoredWrites = [...new Set(ignored.map((w) => w.file))].filter((f) => !files[f]);

  const byId = new Map(edits.map((e) => [e.id, e]));
  const paths = Object.keys(files);
  const symbols: ExSymbol[] = changes.map((c) => attribute(c, byId, links, claims, paths));

  const stamps = [...edits.map((e) => e.ts), ...decisions.map((d) => d.ts)].sort();
  return {
    base: cfg.base,
    tree,
    branch: currentBranch(store.root),
    startedOn: cfg.branch,
    generatedAt: new Date().toISOString(),
    sessions: [...new Set([...edits.filter((e) => !e.unverified), ...decisions].map((x) => x.session).filter((s): s is string => !!s))],
    span: stamps.length ? [stamps[0], stamps[stamps.length - 1]] : null,
    files,
    decisions,
    symbols,
    ignoredWrites,
    warnings,
  };
}

function cachedReader(root: string) {
  const cache = new Map<string, string | null>();
  return (tree: string, path: string) => {
    const k = `${tree}:${path}`;
    if (!cache.has(k)) cache.set(k, readAt(root, tree, path));
    return cache.get(k)!;
  };
}

function modeRows(ch: FileChange, fmt: (sha: string) => string): Row[] {
  const rows: Row[] = [];
  if (ch.status !== "A") rows.push({ t: "-", s: fmt(ch.oldSha) });
  if (ch.status !== "D") rows.push({ t: "+", s: fmt(ch.newSha) });
  return rows;
}

/* ----------------------------- provenance ----------------------------- */

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Where a line came from: an unchanged baseline line, or the transition that wrote it (keeping baseline ancestry through moves). */
type Origin = { base?: number; label?: string };

/**
 * Replay the file through every captured transition, tagging each line with the transition
 * that wrote it and each baseline line with the transition that deleted it. Transitions are:
 * baseline → recording start ("before"), gaps between captures ("outside"), each captured edit
 * (its id, or "outside" if unverified), and last capture → now ("outside").
 * A line one transition removes and re-adds (a reorder) keeps its baseline ancestry, so whoever
 * deletes it later is the one credited with the deletion.
 */
function track(cfg: Config, baseTree: string, edits: Edit[], path: string, baseText: string | null, finalText: string | null, read: (t: string, p: string) => string | null) {
  let text = baseText ?? "";
  const baseLines = splitLines(text);
  let lines: Origin[] = baseLines.map((_, i) => ({ base: i + 1 }));
  const removedBy = new Map<number, string>();

  const step = (next: string | null, label: string) => {
    const nt = next ?? "";
    if (nt === text) return;
    const cur = splitLines(text);
    const parts = diffLines(text, nt).map((p) => ({ ...p, lines: splitLines(p.value) }));
    // Removed lines with baseline ancestry, by text: candidates for "moved within this transition".
    const pool = new Map<string, number[]>();
    let i = 0;
    for (const p of parts) {
      if (p.added) continue;
      for (let k = 0; k < p.lines.length; k++, i++) {
        const b = lines[i]?.base;
        if (p.removed && b != null) pool.set(cur[i], [...(pool.get(cur[i]) ?? []), b]);
      }
    }
    const carried = new Set<number>();
    const out: Origin[] = [];
    i = 0;
    for (const p of parts) {
      if (p.added) {
        for (const t of p.lines) {
          const b = pool.get(t)?.shift();
          if (b != null) carried.add(b);
          out.push(b != null ? { label, base: b } : { label });
        }
      } else if (p.removed) {
        for (let k = 0; k < p.lines.length; k++) i++;
      } else for (let k = 0; k < p.lines.length; k++) out.push(lines[i++]);
    }
    // Baseline lines removed and not re-added anywhere in this transition are deleted by it.
    i = 0;
    for (const p of parts) {
      if (p.added) continue;
      for (let k = 0; k < p.lines.length; k++, i++) {
        const b = lines[i]?.base;
        if (p.removed && b != null && !carried.has(b) && !removedBy.has(b)) removedBy.set(b, label);
      }
    }
    lines = out;
    text = nt;
  };

  if (baseTree !== cfg.initTree) step(read(cfg.initTree, path), "before");
  for (const e of edits) {
    if (!e.files.includes(path)) continue;
    step(read(e.from, path), "outside");
    step(read(e.to, path), e.unverified ? "outside" : e.id);
  }
  step(finalText, "outside");

  const finalLines = splitLines(text);
  return {
    added(n: number, s: string): string {
      const o = lines[n - 1];
      if (o?.label) return o.label;
      // Line alignment disagreed with the replay (duplicate lines): fall back to a same-text line.
      const k = finalLines.findIndex((x, j) => x === s && lines[j]?.label);
      return k >= 0 ? lines[k].label! : "outside";
    },
    removed(o: number): string {
      const by = removedBy.get(o);
      if (by) return by;
      // Still present but moved: whoever moved it is why it no longer sits at its old position.
      const moved = lines.find((x) => x.base === o && x.label);
      return moved?.label ?? "outside";
    },
  };
}

/** Provenance for changes with no line text (binary, mode, submodule): which transitions touched the file. */
function fileLabels(root: string, cfg: Config, baseTree: string, finalTree: string, edits: Edit[], path: string): Set<string> {
  // The full tree entry (mode + object id), so a chmod counts as a change.
  const sha = (tree: string) => {
    try {
      return execFileSync("git", ["-C", root, "ls-tree", "-z", tree, "--", `:(literal)${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("\t")[0];
    } catch {
      return "";
    }
  };
  const labels = new Set<string>();
  let cur = sha(baseTree);
  const step = (tree: string, label: string) => {
    const next = sha(tree);
    if (next !== cur) labels.add(label);
    cur = next;
  };
  if (baseTree !== cfg.initTree) step(cfg.initTree, "before");
  for (const e of edits) {
    if (!e.files.includes(path)) continue;
    step(e.from, "outside");
    step(e.to, e.unverified ? "outside" : e.id);
  }
  step(finalTree, "outside");
  return labels;
}

/* ----------------------------- moves ----------------------------- */

/**
 * A symbol removed in one place and added with byte-identical source elsewhere is one move.
 * Only unambiguous pairs count: if several bodies match, nothing is paired.
 */
function detectMoves(changes: Change[]) {
  const movable = (c: Change) => c.body && c.kind !== "import" && c.kind !== "other" && c.kind !== "file";
  const removed = changes.filter((c) => c.status === "removed" && movable(c));
  const added = changes.filter((c) => c.status === "added" && movable(c));
  for (const add of added) {
    const short = add.name.split(".").pop();
    const same = (c: Change) => c.body === add.body && c.name.split(".").pop() === short;
    const cands = removed.filter(same);
    if (cands.length !== 1 || added.filter(same).length !== 1) continue;
    const r = cands[0];
    removed.splice(removed.indexOf(r), 1);
    add.status = "moved";
    add.movedFrom = r.file;
    for (const row of [...add.rows, ...r.rows]) if (row.p) add.extra.add(row.p);
    add.rows = add.rows.map((row) => (row.t === "+" ? { ...row, t: " " as const } : row));
    changes.splice(changes.indexOf(r), 1);
  }
}

/* ----------------------------- attribution ----------------------------- */

function parseClaim(spec: string, paths: string[]): { file?: string; symbol?: string } {
  const clean = spec.trim().replace(/^\.\//, "");
  const i = clean.lastIndexOf(":");
  if (i > 0) return { file: clean.slice(0, i), symbol: clean.slice(i + 1) };
  if (paths.includes(clean) || /\/|\.\w+$/.test(clean)) return { file: clean };
  return { symbol: clean };
}

function claimKind(c: Claim, s: Change, paths: string[]): "symbol" | "file" | null {
  const { file, symbol } = parseClaim(c.spec, paths);
  if (file && file !== s.file && file !== s.movedFrom) return null;
  if (!symbol) return "file";
  return symbol === s.name || symbol === s.name.split(".").pop() ? "symbol" : null;
}

/**
 * Decisions come from the edits that produced a symbol's lines. For each edit, a claim recorded
 * while the edit existed wins (symbol claims over file claims); otherwise the edit's own link.
 * A symbol is explained only if every changed line comes from an agent edit with a decision.
 */
function attribute(c: Change, byId: Map<string, Edit>, links: Map<string, string>, claims: Claim[], paths: string[]): ExSymbol {
  const labels = new Set<string>(c.extra);
  for (const r of c.rows) if ((r.t === "+" || r.t === "-") && r.p) labels.add(r.p);
  const editIds = [...labels].filter((l) => byId.has(l));
  const decisions = new Set<string>();
  const unlinked: string[] = [];
  const relevant = claims.map((cl) => ({ cl, kind: claimKind(cl, c, paths) })).filter((x) => x.kind);
  const used = new Set<Claim>();

  for (const id of editIds) {
    const e = byId.get(id)!;
    const same = relevant.filter(({ cl }) => cl.edits.has(id));
    const bySym = same.filter((x) => x.kind === "symbol").map((x) => x.cl);
    const chosen = bySym.length ? bySym : same.filter((x) => x.kind === "file").map((x) => x.cl);
    chosen.forEach((cl) => used.add(cl));
    // An explicit claim (symbol, else file) made when the edit existed beats the timing-based link.
    const link = links.get(id);
    const ds = [...new Set(chosen.length ? chosen.map((cl) => cl.decision) : link ? [link] : [])];
    if (!ds.length) unlinked.push(id);
    ds.forEach((d) => decisions.add(d));
  }
  const later = [...new Set(relevant.filter(({ cl }) => !used.has(cl) && !decisions.has(cl.decision)).map(({ cl }) => cl.decision))];
  const gaps: Gaps = { outside: labels.has("outside"), before: labels.has("before"), unlinked };

  return {
    id: `${c.file}#${c.key}`,
    file: c.file,
    kind: c.kind,
    name: c.name,
    sig: c.sig,
    status: c.status,
    ...(c.movedFrom ? { movedFrom: c.movedFrom } : {}),
    ...(c.note ? { note: c.note } : {}),
    rows: c.rows,
    edits: editIds,
    decisions: [...decisions],
    later,
    gaps,
    explained: editIds.length > 0 && !gaps.outside && !gaps.before && unlinked.length === 0,
  };
}
