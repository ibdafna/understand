import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Symbols come from one generic engine: each language is data in languages/<id>/ (lang.json and an
 * outline.scm tree-sitter query), and nothing here knows any language by name.
 */
export type Lang = string;

interface LangDef {
  id: string;
  extensions: string[];
  /** Exact file names (Makefile) and #! interpreters (ruby) for files an extension doesn't name. */
  filenames?: string[];
  interpreters?: string[];
  /** The tree-sitter grammar; without one (and an outline), a file is one whole-file change. */
  grammar?: string;
  /** The Shiki grammar the review page highlights it with. */
  highlight?: string;
  /** Another language whose outline.scm this one uses (tsx uses typescript's). */
  outline?: string;
  /** Node types that wrap a declaration and belong to it (`export …`, decorators). */
  wrappers?: string[];
  /** Node types that lead a declaration like doc comments do (attributes). */
  leading?: string[];
  /** Node types that don't count as nesting (`#ifdef` blocks): what's inside is at their level. */
  transparent?: string[];
  /** What joins a container's name to its members' (`::` in C++ and Rust); "." by default. */
  separator?: string;
}

const langDir = fileURLToPath(new URL("./languages/", import.meta.url));
let defs: LangDef[] | null = null;

function languages(): LangDef[] {
  return (defs ??= readdirSync(langDir).map((id) => ({ id, ...JSON.parse(readFileSync(`${langDir}${id}/lang.json`, "utf8")) })));
}

/** The language of a file: by exact name, extension, or (with its text) a #! line. */
function defOf(path: string, text?: string | null): LangDef | null {
  const name = path.split("/").pop()!;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const bang = /^#!\s*(?:\S*\/)?(?:env\s+(?:-\S+\s+)*)?([\w.+-]+)/.exec(text ?? "")?.[1];
  return languages().find((d) => d.filenames?.includes(name))
    ?? (ext ? languages().find((d) => d.extensions.includes(ext)) : undefined)
    ?? (bang ? languages().find((d) => d.interpreters?.includes(bang)) : undefined)
    ?? null;
}

/** The language whose symbols this file is split into, or null (a whole-file change). */
export function langOf(path: string, text?: string | null): Lang | null {
  const d = defOf(path, text);
  return d?.grammar ? d.id : null;
}

/** The syntax grammar the review page highlights this file with ("plain" when there's none). */
export function hlLang(path: string, text?: string | null): string {
  return defOf(path, text)?.highlight ?? "plain";
}

export interface Sym {
  key: string;
  kind: string;
  name: string;
  sig: string;
  /** 1-based line numbers this symbol owns. Containers exclude their members' lines. */
  own: number[];
  /** Where the declaration itself starts, after its doc comments. */
  line: number;
  /** Exact source (doc comments + node text, members removed for containers). Equality means unchanged. */
  cmp: string;
  /** Position within a Go const group whose implicit specs repeat an iota expression. */
  iota?: number;
}

/** Wrapper lines of a declaration group (`import (`, `const (`, `)`), and the symbols inside it. */
export interface Group {
  lines: number[];
  members: string[];
}

export interface FileSymbols {
  syms: Sym[];
  groups: Group[];
}

// Minimal view of web-tree-sitter's Node; the runtime is loaded dynamically from dist/wasm.
interface TSNode {
  id: number;
  type: string;
  text: string;
  startIndex: number;
  endIndex: number;
  startPosition: { row: number };
  endPosition: { row: number };
  parent: TSNode | null;
  previousNamedSibling: TSNode | null;
  descendantsOfType(types: string[], start?: { row: number }, end?: { row: number }): (TSNode | null)[];
}

const wasmDir = fileURLToPath(new URL("./wasm/", import.meta.url));
let runtime: any;
const loaded = new Map<Lang, { parser: any; query: any; def: LangDef }>();

async function load(lang: Lang) {
  if (!runtime) {
    runtime = createRequire(import.meta.url)(wasmDir + "tree-sitter.cjs");
    await runtime.Parser.init({ locateFile: (f: string) => wasmDir + f });
  }
  if (!loaded.has(lang)) {
    const def = languages().find((d) => d.id === lang)!;
    const language = await runtime.Language.load(wasmDir + basename(def.grammar!));
    const parser = new runtime.Parser();
    parser.setLanguage(language);
    const query = new runtime.Query(language, readFileSync(`${langDir}${def.outline ?? def.id}/outline.scm`, "utf8"));
    loaded.set(lang, { parser, query, def });
  }
  return loaded.get(lang)!;
}

/**
 * One candidate symbol from a query match. Captures: @item (the declaration), @name (repeatable,
 * joined with ", "), @key (its identity when not the name), @key.prefix / @name.prefix (prepended
 * with a space: accessors, import aliases), @scope (qualifier instead of the container: a Go
 * receiver), @body (the signature is the text before the first), @group (a declaration block the item's
 * lines share), @value, @kind (the kind from source text). Properties (#set!): kind, kind.member
 * (the kind inside a container), container, sig ("full"), sig.prefix, key, key.prefix, name
 * ("text": the item's flattened text), collapse ("single": a group of one is that one), ordinal
 * (a word that makes position within the group part of identity: Go's iota), fold ("next":
 * merges into the next item of the same name: TypeScript overloads), qualify ("no": not named after
 * its container: an import inside a module block), qualify.members ("no": a container whose members
 * keep their own names).
 */
interface Item {
  node: TSNode;
  pattern: number;
  cap: Record<string, TSNode[]>;
  props: Record<string, string>;
  parent: Item | null;
  kids: Item[];
  ok: boolean;
  qn: string;
  sep: string;
}

export async function symbolsOf(lang: Lang, src: string): Promise<FileSymbols> {
  const { parser, query, def } = await load(lang);
  const tree = parser.parse(src);
  const root = tree.rootNode as TSNode;
  const b = new Builder(src, def.leading ?? []);
  const wrappers = new Set(def.wrappers ?? []);
  const transparent = new Set(def.transparent ?? []);
  const up = (n: TSNode) => { let p = n.parent; while (p && transparent.has(p.type)) p = p.parent; return p; };

  // Candidates, one per declaration: wrappers belong to it, and the first pattern to find it wins.
  const byNode = new Map<number, Item>();
  for (const m of query.matches(root)) {
    const cap: Record<string, TSNode[]> = {};
    for (const c of m.captures) (cap[c.name] ??= []).push(c.node);
    let node = cap.item?.[0];
    if (!node) continue;
    while (node.parent && wrappers.has(node.parent.type)) node = node.parent;
    const prev = byNode.get(node.id);
    const names = [...(prev?.cap.name ?? []), ...(cap.name ?? [])];
    if (!prev || m.patternIndex < prev.pattern) byNode.set(node.id, { node, pattern: m.patternIndex, cap, props: { ...(m.setProperties ?? {}) }, parent: null, kids: [], ok: false, qn: "", sep: def.separator ?? "." });
    // A declaration of several names (`var a, b`) matches once per name: they belong together.
    const it = byNode.get(node.id)!;
    if (names.length) it.cap.name = [...new Map(names.map((n) => [n.id, n])).values()].sort((x, y) => x.startIndex - y.startIndex);
  }

  // Nesting by containment. A container's members sit directly in its body; items anywhere else
  // (a function body, an if block) aren't symbols; at the top they must sit directly in the file.
  const items = [...byNode.values()].sort((x, y) => x.node.startIndex - y.node.startIndex || y.node.endIndex - x.node.endIndex);
  const stack: Item[] = [];
  const top: Item[] = [];
  for (const it of items) {
    while (stack.length && !(stack.at(-1)!.node.startIndex <= it.node.startIndex && it.node.endIndex <= stack.at(-1)!.node.endIndex)) stack.pop();
    const parent = stack.at(-1) ?? null;
    const home = up(it.cap.group?.[0] ?? it.node)?.id;
    it.ok = parent ? parent.ok && !!parent.props.container && home === (parent.cap.body?.[0] ?? parent.node).id : home === root.id;
    if (it.ok) {
      it.parent = parent;
      (parent ? parent.kids : top).push(it);
      const name = nameOf(it);
      it.qn = [qualifier(it), it.cap.scope && text(it.cap.scope[0]), name].filter(Boolean).join(it.sep);
    }
    stack.push(it);
  }
  emit(top, b);
  tree.delete();
  return { syms: b.syms, groups: b.groups };
}

const text = (n: TSNode) => flat(unquote(n.text));

/** The container name an item's name starts with, if any. */
const qualifier = (it: Item) => (it.parent && it.props.qualify !== "no" && it.parent.props["qualify.members"] !== "no" ? it.parent.qn : "");

function nameOf(it: Item): string {
  if (it.props.name === "text") {
    const t = flat(it.node.text).replace(/;$/, "");
    return t.length > 60 ? t.slice(0, 57) + "…" : t;
  }
  const names = (it.cap.name ?? []).map(text).join(", ");
  const own = names || (it.cap.key ? text(it.cap.key[0]) : "?");
  return it.cap["name.prefix"] ? `${text(it.cap["name.prefix"][0])} ${own}` : own;
}

function keyOf(it: Item): string {
  const own = it.props.key ?? (it.cap.key ? text(it.cap.key[0]).replace(/;$/, "") : (it.cap.name ?? []).map(text).join(", ") || nameOf(it));
  const prefix = (it.props["key.prefix"] ?? "") + (it.cap["key.prefix"] ? text(it.cap["key.prefix"][0]) + " " : "");
  const scope = [qualifier(it), it.cap.scope && text(it.cap.scope[0])].filter(Boolean).join(it.sep);
  return (scope ? scope + it.sep : "") + prefix + own;
}

/** The declaration up to its body (or all of it with sig "full"); tidySig flattens it and drops a trailing `{ : ;`. */
function sigOf(it: Item): string {
  const node = it.node;
  const body = it.cap.body?.reduce((a, b) => (b.startIndex < a.startIndex ? b : a)) ?? null;
  let sig = it.props.sig === "full" ? node.text : header(node, body);
  // A comment inside the signature (`#define N 10 /* … */`) isn't part of it.
  for (const c of node.descendantsOfType(["comment", "line_comment", "block_comment"], node.startPosition, body?.startPosition ?? node.endPosition)) if (c) sig = sig.replace(c.text, "");
  if (it.props["sig.prefix"]) sig = `${it.props["sig.prefix"]} ${sig}`;
  // A name that comes after the body (C's `typedef struct { … } name;`) belongs in the signature too.
  const name = it.cap.name?.length === 1 ? text(it.cap.name[0]) : "";
  return name && !sig.includes(name) ? `${tidySig(sig)}${/\{\s*$/.test(sig) ? " { … }" : ""} ${name}` : sig;
}

const kindOf = (it: Item) => (it.parent && it.props["kind.member"]) || (it.cap.kind ? it.cap.kind[0].text : it.props.kind ?? "var");

/** Add items to the builder in document order, each followed by its members. */
function emit(list: Item[], b: Builder) {
  // Folding: items marked fold merge into the next item with their name (overloads into the implementation).
  const from = new Map<Item, number>();
  const folded = new Set<Item>();
  for (let i = 0; i < list.length; i++) {
    if (!list[i].props.fold) continue;
    let j = i;
    while (j < list.length && list[j].props.fold) j++;
    const impl = list[j];
    if (impl && nameOf(impl) === nameOf(list[i]) && kindOf(impl) === kindOf(list[i])) {
      for (let k = i; k < j; k++) folded.add(list[k]);
      from.set(impl, Math.min(from.get(impl) ?? Infinity, b.leadStart(list[i].node)));
    }
    i = j - 1;
  }

  for (let i = 0; i < list.length; i++) {
    const it = list[i];
    if (folded.has(it)) continue;
    const group = it.cap.group?.[0];
    if (group) {
      let j = i;
      while (j < list.length && list[j].cap.group?.[0].id === group.id) j++;
      const members = list.slice(i, j);
      i = j - 1;
      if (it.props.collapse === "single" && members.length === 1) {
        b.add({ kind: kindOf(it), key: keyOf(it), name: it.qn, sig: sigOf(it), from: b.leadStart(group), outer: group });
        continue;
      }
      const ordinal = it.props.ordinal && members.some((m) => m.cap.value && new RegExp(`\\b${it.props.ordinal}\\b`).test(m.cap.value[0].text));
      const syms = members.map((m, k) => {
        const sym = b.add({ kind: kindOf(m), key: keyOf(m), name: m.qn, sig: sigOf(m), from: b.leadStart(m.node), outer: m.node, ...(ordinal ? { iota: k } : {}) });
        if (ordinal && !m.cap.value) sym.cmp += `\u0000iota@${k}`;
        return sym;
      });
      b.group(b.leadStart(group), endRow(group), syms);
      continue;
    }
    b.add({ kind: kindOf(it), key: keyOf(it), name: it.qn, sig: sigOf(it), from: from.get(it) ?? b.leadStart(it.node), outer: it.node, members: it.kids.map((k) => k.node) });
    emit(it.kids, b);
  }
}

class Builder {
  syms: Sym[] = [];
  groups: Group[] = [];
  private lines: string[];
  private seen = new Map<string, number>();
  constructor(src: string, private leading: string[]) {
    this.lines = src.split("\n");
  }

  /** Where a declaration starts once the doc comments (and attributes) directly above it are included. */
  leadStart(n: TSNode): number {
    let start = row(n);
    let p = n.previousNamedSibling;
    while (p && (/comment/.test(p.type) || this.leading.includes(p.type)) && endRow(p) === start - 1) {
      start = row(p);
      p = p.previousNamedSibling;
    }
    return start;
  }

  add(o: { kind: string; key: string; name: string; sig: string; from: number; outer: TSNode; members?: TSNode[]; iota?: number }): Sym {
    let key = `${o.kind === "import" ? "import" : o.kind === "export" ? "export" : kindKey(o.kind)}:${o.key}`;
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    if (n > 1) key += `#${n}`;
    const outer = o.outer;
    const to = endRow(outer);
    const excl = (o.members ?? []).map((m) => [this.leadStart(m), endRow(m)] as const);
    const own: number[] = [];
    for (let l = o.from; l <= to; l++) if (!excl.some(([a, z]) => l >= a && l <= z)) own.push(l);
    const lead = o.from < row(outer) ? this.lines.slice(o.from - 1, row(outer) - 1).join("\n") + "\n" : "";
    let body = outer.text;
    for (const m of o.members ?? []) body = body.replace(m.text, "\u0000");
    const sym: Sym = { key, kind: o.kind, name: o.name, sig: tidySig(o.sig), own, line: row(outer), cmp: lead + body, ...(o.iota != null ? { iota: o.iota } : {}) };
    this.syms.push(sym);
    return sym;
  }

  group(from: number, to: number, members: Sym[]) {
    const inside = new Set(members.flatMap((m) => m.own));
    const lines: number[] = [];
    for (let l = from; l <= to; l++) if (!inside.has(l)) lines.push(l);
    this.groups.push({ lines, members: members.map((m) => m.key) });
  }
}

/** Keys stay stable when a declaration changes flavor (const → let, struct → interface). */
function kindKey(kind: string) {
  if (kind === "method" || kind === "field") return kind;
  if (kind === "function" || kind === "func") return "func";
  if (kind === "class") return "class";
  if (kind === "namespace") return "namespace";
  if (["struct", "interface", "type", "enum"].includes(kind)) return "type";
  return "var";
}

function tidySig(s: string) {
  const t = s.replace(/\s+/g, " ").trim().replace(/\s*[{:;]$/, "");
  return t.length > 220 ? t.slice(0, 217) + "…" : t;
}

const row = (n: TSNode) => n.startPosition.row + 1;
const endRow = (n: TSNode) => n.endPosition.row + 1 - (n.endPosition.row > n.startPosition.row && n.text.endsWith("\n") ? 1 : 0);

function header(n: TSNode, body: TSNode | null): string {
  if (!body) return n.text.split("\n")[0];
  const i = n.text.lastIndexOf(body.text);
  return i > 0 ? n.text.slice(0, i) : n.text.split("\n")[0];
}

const unquote = (s: string) => s.replace(/^["'`]|["'`]$/g, "");
const flat = (s: string) => s.replace(/\s+/g, " ").trim();
