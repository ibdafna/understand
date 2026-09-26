import { diffLines } from "diff";
import { currentBranch, changedFiles, entryAt, git, readAt, treeOf, trunkBranch, type FileChange, type GitEnv } from "../git.js";
import { isLogPath, readLogs } from "../decisionlog.js";
import type { Home } from "../home.js";
import { Store, type Claim, type Decision, type Edit } from "../store.js";
import { align, diffFile, type Row, type Status, type SymChange } from "./diff.js";
import { hlLang, langOf, symbolsOf } from "./symbols.js";

export interface Gaps {
  /** Some changed lines came from outside any observed agent tool. */
  outside: boolean;
  /** Some changed lines predate recording (e.g. commits made before Understand was installed). */
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
  /** The declaration's line (after doc comments), when the change is a symbol. */
  line?: number;
  status: Status;
  movedFrom?: string;
  note?: string;
  rows: Row[];
  edits: string[];
  /** Decisions recorded for these edits at the time (adoption, or --for claims from the same turn). */
  decisions: string[];
  /** Decisions naming this symbol for other edits: shown, but never counted as explanation. */
  later: string[];
  gaps: Gaps;
  explained: boolean;
}

export interface ExFile {
  lang: string;
  status: "added" | "modified" | "deleted";
  note?: string;
}

/** What to explain. Everything is replayed against the recording, so any range works. */
export type Range =
  | { kind: "recording" }                 // where recording started → working tree
  | { kind: "pr"; ref: string }           // merge-base with ref → HEAD (a pull request's diff)
  | { kind: "branch" }                    // merge-base with trunk → working tree (committed and not)
  | { kind: "staged" }                    // HEAD → index
  | { kind: "uncommitted" }               // HEAD → working tree
  | { kind: "commits"; spec: string };    // a..b, or one commit

/** Short stable name for a range: one explanation file per range. */
export function rangeKey(r: Range): string {
  const slug = (x: string) => x.replace(/[^\w.-]+/g, "-");
  return r.kind === "pr" ? `pr-${slug(r.ref)}` : r.kind === "commits" ? `commits-${slug(r.spec)}` : r.kind;
}

export interface Extract {
  /** What the diff compares: e.g. "merge-base with origin/main (1a2b3c4d)" → "HEAD (5e6f7a8b)". */
  baseLabel: string;
  headLabel: string;
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
  /** Built from the checked-in decision log alone: symbols are matched to decisions by name, with no line-level provenance. */
  byName: boolean;
}

type Change = SymChange & { file: string; movedFrom?: string; extra: Set<string> };

const LFS = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;
const isBinary = (s: string | null) => s != null && s.slice(0, 8000).includes("\0");

/**
 * A range's changes with per-line provenance. Each changed line is traced through the recording's
 * captured transitions; anything the recording didn't see is labelled "before recording" or "outside".
 */
export async function extract(src: Store | Home, range: Range = { kind: "recording" }): Promise<Extract> {
  const store = src instanceof Store ? src : null;
  const home = store ? store.home : (src as Home);
  const env = home.readEnv();
  // One consistent instant: the snapshot and every log it's explained by. Without a local recording
  // (a reviewer's checkout, CI), the checked-in decision log is all there is: attribution by name only.
  const { cfg, live, edits, decisions, claims, ignored } = home.withLock(() => {
    if (!store) {
      const decisions = readLogs(home.root);
      const claims: Claim[] = decisions.flatMap((d) => d.for.map((spec) => ({ decision: d.id, spec, edits: new Set<string>() })));
      return { cfg: null, live: home.snapshot(), edits: [] as Edit[], decisions, claims, ignored: [] as { file: string }[] };
    }
    const cfg = store.config();
    // The worktree only belongs to this recording while its branch (or session) is the current one.
    const live = home.scope(cfg.session) === cfg.scope ? home.snapshot() : store.state().lastTree;
    return { cfg, live, edits: store.edits(), decisions: store.decisions(), claims: store.claims(), ignored: store.ignoredWrites() };
  });
  if (!cfg && range.kind === "recording") throw new Error("no local recording here: pick a range (--pr, --branch, --staged, --uncommitted, --commits)");
  const byName = !cfg;
  const start = cfg?.baseTree ?? "";
  const { baseTree, tree, baseLabel, headLabel } = resolveRange(home.root, range, start, live, env);
  const warnings: string[] = [];
  const reader = cachedReader(home.root, env);

  const files: Record<string, ExFile> = {};
  const changes: Change[] = [];

  for (const ch of changedFiles(home.root, baseTree, tree, env)) {
    if (isLogPath(ch.path)) continue; // the shared decision log explains the code; it isn't code to explain
    const status = ch.status === "A" ? "added" : ch.status === "D" ? "deleted" : "modified";
    files[ch.path] = { lang: hlLang(ch.path), status };
    const fileLevel = (name: string, rows: Row[], note: string, part: "mode" | "blob" | "entry" = "entry") => {
      files[ch.path].note = note;
      changes.push({ key: `file:${name}`, kind: "file", name, sig: "", status: status === "deleted" ? "removed" : status, rows, body: "", file: ch.path, extra: byName ? new Set<string>() : fileLabels(home.root, env, baseTree, start, tree, edits, ch.path, part) });
    };

    if (ch.oldMode === "160000" || ch.newMode === "160000") {
      fileLevel("(submodule)", modeRows(ch, (sha) => `Subproject commit ${sha}`), "submodule pointer");
      continue;
    }
    const oldText = ch.status === "A" ? null : reader(baseTree, ch.path);
    const newText = ch.status === "D" ? null : reader(tree, ch.path);
    if (ch.status === "M" && ch.oldMode !== ch.newMode) fileLevel("(file mode)", [{ t: "-", s: `mode ${ch.oldMode}` }, { t: "+", s: `mode ${ch.newMode}` }], `mode ${ch.oldMode} → ${ch.newMode}`, "mode");
    if (isBinary(oldText) || isBinary(newText)) { fileLevel("(binary file)", [], "binary", "blob"); continue; }
    if (oldText === newText && ch.status === "M") continue; // mode-only change, already listed

    const special = ch.oldMode === "120000" || ch.newMode === "120000" ? "symlink" : LFS.test(oldText ?? "") || LFS.test(newText ?? "") ? "Git LFS pointer; content not shown" : null;
    files[ch.path].lang = hlLang(ch.path, newText ?? oldText);
    const lang = special ? null : langOf(ch.path, newText ?? oldText);
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
    const prov = byName ? null : track(baseTree, start, edits, ch.path, oldText, newText, reader);
    if (prov) for (const r of rows) {
      if (r.t === "+") {
        const a = prov.added(r.n!, r.s);
        r.p = a.label;
        if (a.at) r.pa = a.at;
      }
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
  const namesThen = byName ? null : await namesAtTime(changes, byId, reader);
  // Short names (`run`) only identify a symbol when no other changed symbol in the file shares them.
  const shortCount = new Map<string, number>();
  for (const c of changes) {
    const k = `${c.file}:${lastPart(c.name)}`;
    shortCount.set(k, (shortCount.get(k) ?? 0) + 1);
  }
  const unique = (c: Change) => (short: string) => (shortCount.get(`${c.file}:${short}`) ?? 0) <= 1;
  const symbols: ExSymbol[] = changes.map((c) => ({
    id: `${c.file}#${c.key}`, file: c.file, kind: c.kind, name: c.name, sig: c.sig, status: c.status,
    ...(c.line ? { line: c.line } : {}),
    ...(c.movedFrom ? { movedFrom: c.movedFrom } : {}),
    ...(c.note ? { note: c.note } : {}),
    rows: c.rows,
    ...(byName ? attributeByName(c, claims, unique(c)) : attribute(c, byId, claims, unique(c), namesThen!)),
  }));

  const stamps = [...edits.map((e) => e.ts), ...decisions.map((d) => d.ts)].sort();
  return {
    baseLabel,
    headLabel,
    branch: currentBranch(home.root) ?? "(detached)",
    startedOn: cfg ? cfg.branch ?? "(detached)" : "(from the checked-in decision log)",
    byName,
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

function resolveRange(root: string, r: Range, start: string, live: string, env: GitEnv) {
  const rev = (x: string) => git(root, ["rev-parse", "--verify", x]).trim();
  const tree = (commit: string) => treeOf(root, commit, env);
  const short = (c: string) => c.slice(0, 8);
  const mergeBase = (ref: string, head: string) => git(root, ["merge-base", ref, head]).trim();
  switch (r.kind) {
    case "recording":
      return { baseTree: start, tree: live, baseLabel: "where recording started", headLabel: "the working tree" };
    case "pr": {
      // Resolve HEAD once, so the merge-base, the diff, and the label all describe the same commit.
      const head = rev("HEAD"), mb = mergeBase(r.ref, head);
      return { baseTree: tree(mb), tree: tree(head), baseLabel: `merge-base with ${r.ref} (${short(mb)})`, headLabel: `HEAD (${short(head)})` };
    }
    case "branch": {
      const trunk = trunkBranch(root);
      if (!trunk) throw new Error("can't tell which branch is trunk here; set it with `git config understand.trunk <branch>`");
      const mb = mergeBase(trunk, rev("HEAD"));
      return { baseTree: tree(mb), tree: live, baseLabel: `merge-base with ${trunk} (${short(mb)})`, headLabel: "the working tree" };
    }
    case "staged": {
      const head = rev("HEAD");
      // The user's index, written as a tree into our private store (never into the repo).
      const index = git(root, ["write-tree"], { GIT_OBJECT_DIRECTORY: env.GIT_OBJECT_DIRECTORY, GIT_ALTERNATE_OBJECT_DIRECTORIES: env.GIT_ALTERNATE_OBJECT_DIRECTORIES }).trim();
      return { baseTree: tree(head), tree: index, baseLabel: `HEAD (${short(head)})`, headLabel: "the staged changes" };
    }
    case "uncommitted": {
      const head = rev("HEAD");
      return { baseTree: tree(head), tree: live, baseLabel: `HEAD (${short(head)})`, headLabel: "the working tree" };
    }
    case "commits": {
      const [a, b] = r.spec.includes("..") ? r.spec.split(/\.\.\.?/) : [`${r.spec}^`, r.spec];
      const from = rev(a || "HEAD"), to = rev(b || "HEAD");
      return { baseTree: tree(from), tree: tree(to), baseLabel: short(from), headLabel: short(to) };
    }
  }
}

function cachedReader(root: string, env: GitEnv) {
  const cache = new Map<string, string | null>();
  return (tree: string, path: string) => {
    const k = `${tree}:${path}`;
    if (!cache.has(k)) cache.set(k, readAt(root, tree, path, env));
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
/** `at`: the line's number in the version its label's transition wrote (to find the symbol it was in then). */
type Origin = { base?: number; label?: string; at?: number };

/**
 * Replay the file through every captured transition, tagging each line with the transition
 * that wrote it and each baseline line with the transition that deleted it. Transitions are:
 * baseline → recording start ("before"), gaps between captures ("outside"), each captured edit
 * (its id, or "outside" if unverified), and last capture → now ("outside").
 * A line one transition removes and re-adds (a reorder) keeps its baseline ancestry, so whoever
 * deletes it later is the one credited with the deletion.
 */
function track(baseTree: string, startTree: string, edits: Edit[], path: string, baseText: string | null, finalText: string | null, read: (t: string, p: string) => string | null) {
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
    // Baseline lines deleted earlier and not present now: a line re-added with their text is a restoration.
    const present = new Set(lines.map((o) => o.base).filter((b): b is number => b != null));
    const gone = new Map<string, number[]>();
    for (const b of removedBy.keys()) if (!present.has(b)) gone.set(baseLines[b - 1], [...(gone.get(baseLines[b - 1]) ?? []), b]);
    const carried = new Set<number>();
    const out: Origin[] = [];
    i = 0;
    for (const p of parts) {
      if (p.added) {
        for (const t of p.lines) {
          let b = pool.get(t)?.shift();
          if (b != null) carried.add(b);
          else if ((b = gone.get(t)?.shift()) != null) removedBy.delete(b); // restored: a later deletion is the one that counts
          out.push(b != null ? { label, base: b, at: out.length + 1 } : { label, at: out.length + 1 });
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

  if (baseTree !== startTree) step(read(startTree, path), "before");
  for (const e of edits) {
    if (!e.files.includes(path)) continue;
    step(read(e.from, path), "outside");
    step(read(e.to, path), e.unverified ? "outside" : e.id);
  }
  step(finalText, "outside");

  const finalLines = splitLines(text);
  return {
    added(n: number, s: string): { label: string; at?: number } {
      const o = lines[n - 1];
      if (o?.label) return { label: o.label, at: o.at };
      // Line alignment disagreed with the replay (duplicate lines): fall back to a same-text line.
      const k = finalLines.findIndex((x, j) => x === s && lines[j]?.label);
      return k >= 0 ? { label: lines[k].label!, at: lines[k].at } : { label: "outside" };
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

/**
 * Provenance for changes with no line text (binary, mode, submodule): whoever last changed the part
 * that differs. A mode change is judged by the mode alone, so a content edit doesn't claim it.
 */
function fileLabels(root: string, env: GitEnv, baseTree: string, startTree: string, finalTree: string, edits: Edit[], path: string, part: "mode" | "blob" | "entry"): Set<string> {
  const sha = (tree: string) => {
    const [mode, , oid] = entryAt(root, tree, path, env).split(" ");
    return part === "mode" ? mode : part === "blob" ? oid : `${mode} ${oid}`;
  };
  let last = "outside";
  let cur = sha(baseTree);
  const step = (tree: string, label: string) => {
    const next = sha(tree);
    if (next !== cur) last = label;
    cur = next;
  };
  if (baseTree !== startTree) step(startTree, "before");
  for (const e of edits) {
    if (!e.files.includes(path)) continue;
    step(e.from, "outside");
    step(e.to, e.unverified ? "outside" : e.id);
  }
  step(finalTree, "outside");
  return new Set([last]);
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
    const short = lastPart(add.name);
    const same = (c: Change) => c.body === add.body && lastPart(c.name) === short;
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

/** Names join their parts with "." or "::" (C++, Rust); decisions may name them either way. */
const lastPart = (name: string) => name.split(/\.|::/).pop()!;
const sameName = (a: string, b: string) => a.replace(/::/g, ".") === b.replace(/::/g, ".");

/**
 * Does a `--for` spec name this symbol? Files are matched as known paths first, so colons in paths
 * and in symbol names (`a.ts:node:fs`) both work. `names` are the symbol's names: now, and when the
 * edit in question wrote its lines (so a rename doesn't unexplain them).
 */
function claimKind(spec: string, c: Change, names: Set<string>, unique: (short: string) => boolean): "symbol" | "file" | null {
  const clean = spec.trim().replace(/^\.\//, "");
  for (const file of [c.file, c.movedFrom].filter((f): f is string => !!f)) {
    if (clean === file) return "file";
    if (!clean.startsWith(file + ":")) continue;
    const symbol = clean.slice(file.length + 1);
    for (const name of names) {
      const short = lastPart(name);
      // The whole name, its qualified tail (Store.due for todo::Store::due), or a short name only one symbol has.
      const tail = symbol.replace(/::/g, ".");
      if (sameName(symbol, name) || (tail.includes(".") && name.replace(/::/g, ".").endsWith("." + tail)) || (symbol === short && unique(short))) return "symbol";
    }
  }
  return null;
}

/** For each edit and file, the names of the symbols that owned each line in the version that edit wrote. */
type NamesThen = Map<string, Map<number, string[]>>;

async function namesAtTime(changes: Change[], byId: Map<string, Edit>, read: (t: string, p: string) => string | null): Promise<NamesThen> {
  const out: NamesThen = new Map();
  for (const c of changes) {
    for (const r of c.rows) {
      if (r.t !== "+" || !r.p || !r.pa || !byId.has(r.p)) continue;
      const key = `${r.p}:${c.file}`;
      if (out.has(key)) continue;
      const text = read(byId.get(r.p)!.to, c.file);
      const lang = langOf(c.file, text);
      if (!lang) continue;
      const byLine = new Map<number, string[]>();
      if (text != null) {
        try {
          for (const sym of (await symbolsOf(lang, text)).syms) for (const l of sym.own) byLine.set(l, [...(byLine.get(l) ?? []), sym.name]);
        } catch {}
      }
      out.set(key, byLine);
    }
  }
  return out;
}

/** Without a recording: a symbol is explained when some decision in the shared log names it (or its file). */
function attributeByName(c: Change, claims: Claim[], unique: (short: string) => boolean): Attribution {
  const names = new Set([c.name]);
  const hits = claims.map((cl) => ({ cl, kind: claimKind(cl.spec, c, names, unique) })).filter((x) => x.kind);
  const bySym = hits.filter((x) => x.kind === "symbol");
  const decisions = [...new Set((bySym.length ? bySym : hits).map((x) => x.cl.decision))];
  return { edits: [], decisions, later: [], gaps: { outside: false, before: false, unlinked: [] }, explained: decisions.length > 0 };
}

type Attribution = Pick<ExSymbol, "edits" | "decisions" | "later" | "gaps" | "explained">;

function attribute(c: Change, byId: Map<string, Edit>, claims: Claim[], unique: (short: string) => boolean, namesThen: NamesThen): Attribution {
  const changed = c.rows.filter((r) => (r.t === "+" || r.t === "-") && r.p);
  // Blank lines added or removed around a symbol don't need a reason of their own.
  const meaningful = changed.some((r) => r.s.trim()) ? changed.filter((r) => r.s.trim()) : changed;
  const labels = new Set<string>(c.extra);
  for (const r of meaningful) labels.add(r.p!);
  const editIds = [...labels].filter((l) => byId.has(l));
  const decisions = new Set<string>();
  const unlinked: string[] = [];
  for (const id of editIds) {
    const names = new Set([c.name]);
    for (const r of meaningful) if (r.p === id && r.pa) for (const n of namesThen.get(`${id}:${c.file}`)?.get(r.pa) ?? []) names.add(n);
    const mine = claims.map((cl) => ({ cl, kind: cl.edits.has(id) ? claimKind(cl.spec, c, names, unique) : null })).filter((x) => x.kind);
    const bySym = mine.filter((x) => x.kind === "symbol");
    const chosen = bySym.length ? bySym : mine;
    if (!chosen.length) unlinked.push(id);
    chosen.forEach(({ cl }) => decisions.add(cl.decision));
  }
  const named = claims.filter((cl) => claimKind(cl.spec, c, new Set([c.name]), unique));
  const later = [...new Set(named.map((cl) => cl.decision))].filter((d) => !decisions.has(d));
  const gaps: Gaps = { outside: labels.has("outside"), before: labels.has("before"), unlinked };
  return { edits: editIds, decisions: [...decisions], later, gaps, explained: editIds.length > 0 && !gaps.outside && !gaps.before && unlinked.length === 0 };
}
