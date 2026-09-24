import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

export type Lang = "go" | "typescript" | "tsx" | "javascript" | "python";

const EXT: Record<string, Lang> = {
  go: "go",
  ts: "typescript", mts: "typescript", cts: "typescript",
  tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  py: "python",
};

export function langOf(path: string): Lang | null {
  return EXT[path.split(".").pop()!.toLowerCase()] ?? null;
}

/** Display language for highlighting; the viewer only distinguishes these. */
export function hlLang(path: string): string {
  const l = langOf(path);
  return l === "go" ? "go" : l === "python" ? "py" : l ? "ts" : "plain";
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
  type: string;
  text: string;
  startPosition: { row: number };
  endPosition: { row: number };
  namedChildren: TSNode[];
  previousNamedSibling: TSNode | null;
  childForFieldName(name: string): TSNode | null;
  childrenForFieldName(name: string): TSNode[];
  descendantsOfType(type: string | string[]): TSNode[];
}

const wasmDir = fileURLToPath(new URL("./wasm/", import.meta.url));
let runtime: any;
const parsers = new Map<Lang, any>();

async function parserFor(lang: Lang) {
  if (!runtime) {
    runtime = createRequire(import.meta.url)(wasmDir + "tree-sitter.cjs");
    await runtime.Parser.init({ locateFile: (f: string) => wasmDir + f });
  }
  if (!parsers.has(lang)) {
    const language = await runtime.Language.load(`${wasmDir}tree-sitter-${lang}.wasm`);
    const p = new runtime.Parser();
    p.setLanguage(language);
    parsers.set(lang, p);
  }
  return parsers.get(lang);
}

export async function symbolsOf(lang: Lang, src: string): Promise<FileSymbols> {
  const tree = (await parserFor(lang)).parse(src);
  const b = new Builder(src);
  const root = tree.rootNode as TSNode;
  if (lang === "go") goWalk(root, b);
  else if (lang === "python") pyBlock(root.namedChildren, b, "");
  else tsBlock(root.namedChildren, b, "");
  tree.delete();
  return { syms: b.syms, groups: b.groups };
}

class Builder {
  syms: Sym[] = [];
  groups: Group[] = [];
  private lines: string[];
  private seen = new Map<string, number>();
  constructor(src: string) {
    this.lines = src.split("\n");
  }

  add(o: { kind: string; key: string; name: string; sig: string; from: number; node: TSNode; outer?: TSNode; members?: TSNode[]; iota?: number }): Sym {
    let key = `${o.kind === "import" ? "import" : o.kind === "export" ? "export" : kindKey(o.kind)}:${o.key}`;
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    if (n > 1) key += `#${n}`;
    const outer = o.outer ?? o.node;
    const to = endRow(outer);
    const excl = (o.members ?? []).map((m) => [startWithComments(m), endRow(m)] as const);
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

/** Pull contiguous doc comments directly above a declaration into its range. */
function startWithComments(n: TSNode): number {
  let start = row(n);
  let p = n.previousNamedSibling;
  while (p && p.type === "comment" && endRow(p) === start - 1) {
    start = row(p);
    p = p.previousNamedSibling;
  }
  return start;
}

function header(n: TSNode, body: TSNode | null): string {
  if (!body) return n.text.split("\n")[0];
  const i = n.text.lastIndexOf(body.text);
  return i > 0 ? n.text.slice(0, i) : n.text.split("\n")[0];
}

const unquote = (s: string) => s.replace(/^["'`]|["'`]$/g, "");
const flat = (s: string) => s.replace(/\s+/g, " ").trim();

/* ------------------------------ Go ------------------------------ */

function goWalk(root: TSNode, b: Builder) {
  for (const n of root.namedChildren) {
    switch (n.type) {
      case "import_declaration": {
        const specs = n.descendantsOfType("import_spec");
        const members = specs.map((s) => {
          const path = unquote(s.childForFieldName("path")?.text ?? s.text);
          const alias = s.childForFieldName("name")?.text;
          return b.add({ kind: "import", key: path, name: alias ? `${alias} ${path}` : path, sig: s.text, from: startWithComments(s), node: s });
        });
        b.group(startWithComments(n), endRow(n), members);
        break;
      }
      case "function_declaration": {
        const name = n.childForFieldName("name")?.text ?? "?";
        b.add({ kind: "func", key: name, name, sig: header(n, n.childForFieldName("body")), from: startWithComments(n), node: n });
        break;
      }
      case "method_declaration": {
        const name = n.childForFieldName("name")?.text ?? "?";
        const recv = n.childForFieldName("receiver")?.descendantsOfType("type_identifier")[0]?.text ?? "?";
        b.add({ kind: "method", key: `${recv}.${name}`, name: `${recv}.${name}`, sig: header(n, n.childForFieldName("body")), from: startWithComments(n), node: n });
        break;
      }
      case "type_declaration":
      case "const_declaration":
      case "var_declaration": {
        const isType = n.type === "type_declaration";
        const kw = isType ? "type" : n.type === "const_declaration" ? "const" : "var";
        const specs = n.descendantsOfType(isType ? ["type_spec", "type_alias"] : [kw + "_spec"]).filter((s) => sameGroup(s, n));
        const usesIota = kw === "const" && specs.some((s) => /\biota\b/.test(s.childForFieldName("value")?.text ?? ""));
        if (specs.length === 1) {
          const s = specs[0];
          const name = specName(s);
          b.add({ kind: specKind(s, kw), key: name, name, sig: `${kw} ${s.text.split("\n")[0]}`, from: startWithComments(n), node: n });
          break;
        }
        const members = specs.map((s, i) => {
          const name = specName(s);
          const implicit = usesIota && !s.childForFieldName("value");
          const sym = b.add({ kind: specKind(s, kw), key: name, name, sig: `${kw} ${s.text.split("\n")[0]}`, from: startWithComments(s), node: s, ...(usesIota ? { iota: i } : {}) });
          if (implicit) sym.cmp += `\u0000iota@${i}`;
          return sym;
        });
        b.group(startWithComments(n), endRow(n), members);
        break;
      }
    }
  }
}

function sameGroup(spec: TSNode, decl: TSNode) {
  return spec.startPosition.row >= decl.startPosition.row && spec.endPosition.row <= decl.endPosition.row;
}

function specName(s: TSNode) {
  return s.childrenForFieldName("name").map((x) => x.text).join(", ") || s.childForFieldName("name")?.text || "?";
}

function specKind(s: TSNode, kw: string) {
  if (kw !== "type") return kw;
  const t = s.childForFieldName("type")?.type;
  return t === "struct_type" ? "struct" : t === "interface_type" ? "interface" : "type";
}

/* ------------------------ TypeScript / JavaScript ------------------------ */

const TS_DECL = new Set([
  "function_declaration", "generator_function_declaration", "class_declaration", "abstract_class_declaration",
  "interface_declaration", "type_alias_declaration", "enum_declaration", "lexical_declaration", "variable_declaration",
  "function_signature", "internal_module", "module", "ambient_declaration",
]);
const MEMBER_TYPES = new Set(["method_definition", "abstract_method_signature", "method_signature", "public_field_definition", "field_definition"]);

/** Unwrap `export …`, `declare …`, and `namespace N {}` (which parses as an expression statement). */
function unwrap(outer: TSNode): { n: TSNode; declare: boolean } {
  let n = outer;
  let declare = false;
  if (n.type === "export_statement") n = n.childForFieldName("declaration") ?? n.namedChildren.find((c) => TS_DECL.has(c.type)) ?? n;
  if (n.type === "ambient_declaration") {
    declare = true;
    n = n.namedChildren.find((c) => TS_DECL.has(c.type) || c.type === "statement_block") ?? n;
  }
  if (n.type === "expression_statement" && n.namedChildren[0]?.type === "internal_module") n = n.namedChildren[0];
  return { n, declare };
}

const nameOf = (n: TSNode) => n.childForFieldName("name")?.text ?? "";

function tsBlock(nodes: TSNode[], b: Builder, prefix: string) {
  // Overload signatures directly before their implementation belong to it.
  const foldInto = new Map<number, number>();
  for (let i = 0; i < nodes.length; i++) {
    if (unwrap(nodes[i]).n.type !== "function_signature") continue;
    let j = i;
    while (j < nodes.length && unwrap(nodes[j]).n.type === "function_signature") j++;
    const impl = nodes[j] && unwrap(nodes[j]).n;
    if (impl?.type === "function_declaration" && nameOf(impl) === nameOf(unwrap(nodes[i]).n)) foldInto.set(i, j);
  }
  const foldStart = new Map<number, number>();
  for (const [sig, impl] of foldInto) foldStart.set(impl, Math.min(foldStart.get(impl) ?? Infinity, startWithComments(nodes[sig])));

  nodes.forEach((outer, i) => {
    if (foldInto.has(i)) return;
    const { n, declare } = unwrap(outer);
    const from = foldStart.get(i) ?? startWithComments(outer);
    const name = nameOf(n) || "?";
    const q = prefix + name;
    const sig = (declare && !outer.text.startsWith("declare") ? "declare " : "") + header(outer, n.childForFieldName("body"));

    if (outer.type === "export_statement" && n === outer) {
      const text = flat(outer.text).replace(/;$/, "");
      const clause = outer.namedChildren.find((c) => c.type === "export_clause");
      const src = outer.childForFieldName("source");
      const key = /^export default\b/.test(text) ? "default" : clause ? flat(clause.text) : src ? `*:${unquote(src.text)}` : text;
      b.add({ kind: "export", key, name: text.length > 60 ? text.slice(0, 57) + "…" : text, sig: text, from, node: outer });
      return;
    }
    switch (n.type) {
      case "import_statement": {
        const src = unquote(n.childForFieldName("source")?.text ?? n.text);
        b.add({ kind: "import", key: src, name: src, sig: n.text, from, node: n, outer });
        break;
      }
      case "function_declaration":
      case "generator_function_declaration":
      case "function_signature":
        b.add({ kind: "function", key: q, name: q, sig, from, node: n, outer });
        break;
      case "class_declaration":
      case "abstract_class_declaration": {
        const members = (n.childForFieldName("body")?.namedChildren ?? []).filter((m) => MEMBER_TYPES.has(m.type));
        b.add({ kind: "class", key: q, name: q, sig, from, node: n, outer, members });
        for (const m of members) {
          const field = m.type.endsWith("field_definition");
          const mn = (m.childForFieldName("name") ?? m.childForFieldName("property"))?.text ?? "?";
          const acc = /^(?:(?:static|async|public|private|protected|readonly|override|abstract|declare)\s+)*(get|set)\s/.exec(m.text)?.[1];
          const key = `${q}.${acc ? acc + " " : ""}${mn}`;
          b.add({ kind: field ? "field" : "method", key, name: `${q}.${mn}`, sig: field ? m.text.split("\n")[0] : header(m, m.childForFieldName("body")), from: startWithComments(m), node: m });
        }
        break;
      }
      case "internal_module":
      case "module": {
        const body = n.childForFieldName("body");
        const inner = body?.namedChildren ?? [];
        const key = unquote(name);
        b.add({ kind: "namespace", key: prefix + key, name: prefix + key, sig, from, node: n, outer, members: inner.filter((c) => c.type !== "comment") });
        tsBlock(inner, b, `${prefix}${key}.`);
        break;
      }
      case "interface_declaration":
        b.add({ kind: "interface", key: q, name: q, sig, from, node: n, outer });
        break;
      case "type_alias_declaration":
        b.add({ kind: "type", key: q, name: q, sig: outer.text.split("\n")[0], from, node: n, outer });
        break;
      case "enum_declaration":
        b.add({ kind: "enum", key: q, name: q, sig, from, node: n, outer });
        break;
      case "lexical_declaration":
      case "variable_declaration": {
        const decls = n.namedChildren.filter((c) => c.type === "variable_declarator");
        const vname = prefix + decls.map((d) => d.childForFieldName("name")?.text ?? "?").join(", ");
        const value = decls[0]?.childForFieldName("value");
        const isFn = value && ["arrow_function", "function_expression", "function", "generator_function"].includes(value.type);
        const kw = n.text.split(/\s/)[0];
        b.add({ kind: isFn ? "function" : kw, key: vname, name: vname, sig: isFn ? header(outer, value.childForFieldName("body")) : outer.text.split("\n")[0], from, node: n, outer });
        break;
      }
    }
  });
}

/* ------------------------------ Python ------------------------------ */

function pyBlock(nodes: TSNode[], b: Builder, cls: string) {
  for (const outer of nodes) {
    const n = outer.type === "decorated_definition" ? outer.childForFieldName("definition") ?? outer : outer;
    const from = startWithComments(outer);
    switch (n.type) {
      case "import_statement":
      case "import_from_statement": {
        if (cls) break;
        const t = flat(n.text);
        b.add({ kind: "import", key: t, name: t, sig: n.text, from, node: n, outer });
        break;
      }
      case "function_definition": {
        const name = cls + (n.childForFieldName("name")?.text ?? "?");
        b.add({ kind: cls ? "method" : "function", key: name, name, sig: header(outer, n.childForFieldName("body")), from, node: n, outer });
        break;
      }
      case "class_definition": {
        const name = cls + (n.childForFieldName("name")?.text ?? "?");
        const body = n.childForFieldName("body")?.namedChildren ?? [];
        const members = body.filter((m) => {
          const d = m.type === "decorated_definition" ? m.childForFieldName("definition") : m;
          return d?.type === "function_definition" || d?.type === "class_definition";
        });
        b.add({ kind: "class", key: name, name, sig: header(outer, n.childForFieldName("body")), from, node: n, outer, members });
        pyBlock(members, b, name + ".");
        break;
      }
      case "expression_statement": {
        const a = n.namedChildren[0];
        if (!cls && a?.type === "assignment") {
          const name = a.childForFieldName("left")?.text ?? "?";
          b.add({ kind: "var", key: name, name, sig: n.text.split("\n")[0], from, node: n, outer });
        }
        break;
      }
    }
  }
}
