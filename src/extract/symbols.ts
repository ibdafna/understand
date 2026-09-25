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
  grammar: string;
  /** Another language whose outline.scm this one uses (tsx uses typescript's). */
  outline?: string;
  /** Node types that wrap a declaration and belong to it (`export …`, decorators). */
  wrappers?: string[];
  /** Node types that lead a declaration like doc comments do (attributes). */
  leading?: string[];
}

const langDir = fileURLToPath(new URL("./languages/", import.meta.url));
let defs: Map<string, LangDef> | null = null;

function languages(): Map<string, LangDef> {
  if (!defs) {
    defs = new Map();
    for (const id of readdirSync(langDir)) {
      const def: LangDef = { id, ...JSON.parse(readFileSync(`${langDir}${id}/lang.json`, "utf8")) };
      for (const ext of def.extensions) defs.set(ext, def);
    }
  }
  return defs;
}

export function langOf(path: string): Lang | null {
  return languages().get(path.split(".").pop()!.toLowerCase())?.id ?? null;
}

/** Display language for highlighting ("plain" when we have none). */
export function hlLang(path: string): string {
  return langOf(path) ?? "plain";
}

export interface Sym {
  key: string;
  kind: string;
  name: string;
  sig: string;
  /** 1-based line numbers this symbol owns. Containers exclude their members' lines. */
  own: number[];
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
    const def = [...languages().values()].find((d) => d.id === lang)!;
    const language = await runtime.Language.load(wasmDir + basename(def.grammar));
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
 * receiver), @body (the signature is the text before it), @group (a declaration block the item's
 * lines share), @value, @kind (the kind from source text). Properties (#set!): kind, kind.member
 * (the kind inside a container), container, sig ("full"), sig.prefix, key, key.prefix, name
 * ("text": the item's flattened text), collapse ("single": a group of one is that one), ordinal
 * (a word that makes position within the group part of identity: Go's iota), fold ("next":
 * merges into the next item of the same name: TypeScript overloads), qualify ("no": not named after
 * its container: an import inside a module block).
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
}

export async function symbolsOf(lang: Lang, src: string): Promise<FileSymbols> {
  const { parser, query, def } = await load(lang);
  const tree = parser.parse(src);
  const root = tree.rootNode as TSNode;
  const b = new Builder(src, def.leading ?? []);
  const wrappers = new Set(def.wrappers ?? []);

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
    if (!prev || m.patternIndex < prev.pattern) byNode.set(node.id, { node, pattern: m.patternIndex, cap, props: { ...(m.setProperties ?? {}) }, parent: null, kids: [], ok: false, qn: "" });
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
    const home = (it.cap.group?.[0] ?? it.node).parent?.id;
    it.ok = parent ? parent.ok && !!parent.props.container && home === (parent.cap.body?.[0] ?? parent.node).id : home === root.id;
    if (it.ok) {
      it.parent = parent;
      (parent ? parent.kids : top).push(it);
      const name = nameOf(it);
      it.qn = it.cap.scope ? `${text(it.cap.scope[0])}.${name}` : parent && it.props.qualify !== "no" ? `${parent.qn}.${name}` : name;
    }
    stack.push(it);
  }
  emit(top, b);
  tree.delete();
  return { syms: b.syms, groups: b.groups };
}

const text = (n: TSNode) => flat(unquote(n.text));

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
  const own = it.props.key ?? (it.cap.key ? text(it.cap.key[0]).replace(it.props.name === "text" ? /;$/ : /$^/, "") : (it.cap.name ?? []).map(text).join(", ") || nameOf(it));
  const prefix = (it.props["key.prefix"] ?? "") + (it.cap["key.prefix"] ? text(it.cap["key.prefix"][0]) + " " : "");
  const scope = it.cap.scope ? text(it.cap.scope[0]) : it.props.qualify === "no" ? "" : it.parent?.qn;
  return (scope ? scope + "." : "") + prefix + own;
}

function sigOf(it: Item, node = it.node): string {
  const body = it.cap.body?.[0] ?? null;
  const sig = it.props.sig === "full" ? (it.props.name === "text" ? flat(node.text).replace(/;$/, "") : node.text) : header(node, body);
  return it.props["sig.prefix"] ? `${it.props["sig.prefix"]} ${sig}` : sig;
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
    const sym: Sym = { key, kind: o.kind, name: o.name, sig: tidySig(o.sig), own, cmp: lead + body, ...(o.iota != null ? { iota: o.iota } : {}) };
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
  const t = s.replace(/\s+/g, " ").trim().replace(/\s*[{:]$/, "");
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
