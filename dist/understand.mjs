// src/cli.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import { randomBytes as randomBytes2 } from "node:crypto";
import { copyFileSync as copyFileSync2, existsSync as existsSync4, mkdirSync as mkdirSync2, renameSync as renameSync2, rmSync as rmSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2, join as join4, resolve as resolve2 } from "node:path";

// src/git.ts
import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
var EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
function git(root, args, env) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}
function repoRoot(cwd) {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}
function currentBranch(root) {
  try {
    return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return "(no commits)";
  }
}
function gitPath(root, name) {
  const p = git(root, ["rev-parse", "--git-path", name]).trim();
  return isAbsolute(p) ? p : join(root, p);
}
function excludeLogDir(root) {
  const file = gitPath(root, "info/exclude");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!cur.split("\n").includes(".understand/")) appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + ".understand/\n");
}
function snapshot(store2) {
  return store2.withLock(() => {
    const index = store2.path("index");
    const real2 = gitPath(store2.root, "index");
    if (existsSync(index) && lstatSync(index).isSymbolicLink()) throw new Error(".understand/index is a symlink; refusing to snapshot through it");
    if (existsSync(real2) && existsSync(index) && realpathSync(index) === realpathSync(real2)) throw new Error("private index resolves to the repository's own index");
    if (!existsSync(index) && existsSync(real2)) copyFileSync(real2, index);
    const env = { GIT_INDEX_FILE: index };
    git(store2.root, ["add", "-A", "--", "."], env);
    return git(store2.root, ["write-tree"], env).trim();
  });
}
function pinTree(root, tree, ref) {
  const commit = git(root, ["commit-tree", tree, "-m", "understand baseline"]).trim();
  git(root, ["update-ref", ref, commit]);
  return commit;
}
function treeOf(root, rev) {
  return git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`]).trim();
}
function readAt(root, treeish, path) {
  try {
    return execFileSync("git", ["-C", root, "cat-file", "blob", `${treeish}:${path}`], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}
function changedFiles(root, from, to) {
  const out = git(root, ["diff-tree", "-r", "--no-renames", "--raw", "-z", from || EMPTY_TREE, to]);
  const parts = out.split("\0");
  const res = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta2 = parts[i];
    if (!meta2.startsWith(":")) break;
    const [oldMode, newMode, oldSha, newSha, st] = meta2.slice(1).split(" ");
    const s = st[0];
    res.push({ status: s === "A" || s === "D" ? s : "M", path: parts[i + 1], oldMode, newMode, oldSha, newSha });
  }
  return res;
}
function isIgnored(root, path) {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// src/capture.ts
function capture(s, o) {
  return s.withLock(() => {
    const st = s.state();
    const tree = snapshot(s);
    if (tree === st.lastTree) return null;
    const files = changedFiles(s.root, st.lastTree, tree).map((c) => c.path);
    const mine = o.only ? files.filter((f) => f === o.only) : files;
    const others = o.only ? files.filter((f) => f !== o.only) : [];
    const rec = (fs, unverified) => s.addEdit({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      session: o.session,
      turn: s.session(st, o.session).turn,
      tool: unverified && !o.unverified ? "side effect" : o.tool,
      from: st.lastTree,
      to: tree,
      files: fs,
      ...o.command ? { command: o.command.slice(0, 2e3) } : {},
      ...unverified ? { unverified: true } : {}
    });
    const edit = mine.length ? rec(mine, !!o.unverified) : null;
    if (others.length) rec(others, true);
    st.lastTree = tree;
    s.writeState(st);
    return edit;
  });
}

// node_modules/diff/libesm/diff/base.js
var Diff = class {
  diff(oldStr, newStr, options = {}) {
    let callback;
    if (typeof options === "function") {
      callback = options;
      options = {};
    } else if ("callback" in options) {
      callback = options.callback;
    }
    const oldString = this.castInput(oldStr, options);
    const newString = this.castInput(newStr, options);
    const oldTokens = this.removeEmpty(this.tokenize(oldString, options));
    const newTokens = this.removeEmpty(this.tokenize(newString, options));
    return this.diffWithOptionsObj(oldTokens, newTokens, options, callback);
  }
  diffWithOptionsObj(oldTokens, newTokens, options, callback) {
    var _a;
    const done = (value) => {
      value = this.postProcess(value, options);
      if (callback) {
        setTimeout(function() {
          callback(value);
        }, 0);
        return void 0;
      } else {
        return value;
      }
    };
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let editLength = 1;
    let maxEditLength = newLen + oldLen;
    if (options.maxEditLength != null) {
      maxEditLength = Math.min(maxEditLength, options.maxEditLength);
    }
    const maxExecutionTime = (_a = options.timeout) !== null && _a !== void 0 ? _a : Infinity;
    const abortAfterTimestamp = Date.now() + maxExecutionTime;
    const bestPath = [{ oldPos: -1, lastComponent: void 0 }];
    let newPos = this.extractCommon(bestPath[0], newTokens, oldTokens, 0, options);
    if (bestPath[0].oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
      return done(this.buildValues(bestPath[0].lastComponent, newTokens, oldTokens));
    }
    let minDiagonalToConsider = -Infinity, maxDiagonalToConsider = Infinity;
    const execEditLength = () => {
      for (let diagonalPath = Math.max(minDiagonalToConsider, -editLength); diagonalPath <= Math.min(maxDiagonalToConsider, editLength); diagonalPath += 2) {
        let basePath;
        const removePath = bestPath[diagonalPath - 1], addPath = bestPath[diagonalPath + 1];
        if (removePath) {
          bestPath[diagonalPath - 1] = void 0;
        }
        let canAdd = false;
        if (addPath) {
          const addPathNewPos = addPath.oldPos - diagonalPath;
          canAdd = addPath && 0 <= addPathNewPos && addPathNewPos < newLen;
        }
        const canRemove = removePath && removePath.oldPos + 1 < oldLen;
        if (!canAdd && !canRemove) {
          bestPath[diagonalPath] = void 0;
          continue;
        }
        if (!canRemove || canAdd && removePath.oldPos < addPath.oldPos) {
          basePath = this.addToPath(addPath, true, false, 0, options);
        } else {
          basePath = this.addToPath(removePath, false, true, 1, options);
        }
        newPos = this.extractCommon(basePath, newTokens, oldTokens, diagonalPath, options);
        if (basePath.oldPos + 1 >= oldLen && newPos + 1 >= newLen) {
          return done(this.buildValues(basePath.lastComponent, newTokens, oldTokens)) || true;
        } else {
          bestPath[diagonalPath] = basePath;
          if (basePath.oldPos + 1 >= oldLen) {
            maxDiagonalToConsider = Math.min(maxDiagonalToConsider, diagonalPath - 1);
          }
          if (newPos + 1 >= newLen) {
            minDiagonalToConsider = Math.max(minDiagonalToConsider, diagonalPath + 1);
          }
        }
      }
      editLength++;
    };
    if (callback) {
      (function exec() {
        setTimeout(function() {
          if (editLength > maxEditLength || Date.now() > abortAfterTimestamp) {
            return callback(void 0);
          }
          if (!execEditLength()) {
            exec();
          }
        }, 0);
      })();
    } else {
      while (editLength <= maxEditLength && Date.now() <= abortAfterTimestamp) {
        const ret = execEditLength();
        if (ret) {
          return ret;
        }
      }
    }
  }
  addToPath(path, added, removed, oldPosInc, options) {
    const last = path.lastComponent;
    if (last && !options.oneChangePerToken && last.added === added && last.removed === removed) {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: last.count + 1, added, removed, previousComponent: last.previousComponent }
      };
    } else {
      return {
        oldPos: path.oldPos + oldPosInc,
        lastComponent: { count: 1, added, removed, previousComponent: last }
      };
    }
  }
  extractCommon(basePath, newTokens, oldTokens, diagonalPath, options) {
    const newLen = newTokens.length, oldLen = oldTokens.length;
    let oldPos = basePath.oldPos, newPos = oldPos - diagonalPath, commonCount = 0;
    while (newPos + 1 < newLen && oldPos + 1 < oldLen && this.equals(oldTokens[oldPos + 1], newTokens[newPos + 1], options)) {
      newPos++;
      oldPos++;
      commonCount++;
      if (options.oneChangePerToken) {
        basePath.lastComponent = { count: 1, previousComponent: basePath.lastComponent, added: false, removed: false };
      }
    }
    if (commonCount && !options.oneChangePerToken) {
      basePath.lastComponent = { count: commonCount, previousComponent: basePath.lastComponent, added: false, removed: false };
    }
    basePath.oldPos = oldPos;
    return newPos;
  }
  equals(left, right, options) {
    if (options.comparator) {
      return options.comparator(left, right);
    } else {
      return left === right || !!options.ignoreCase && left.toLowerCase() === right.toLowerCase();
    }
  }
  removeEmpty(array) {
    const ret = [];
    for (let i = 0; i < array.length; i++) {
      if (array[i]) {
        ret.push(array[i]);
      }
    }
    return ret;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  castInput(value, options) {
    return value;
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  tokenize(value, options) {
    return Array.from(value);
  }
  join(chars) {
    return chars.join("");
  }
  postProcess(changeObjects, options) {
    return changeObjects;
  }
  get useLongestToken() {
    return false;
  }
  buildValues(lastComponent, newTokens, oldTokens) {
    const components = [];
    let nextComponent;
    while (lastComponent) {
      components.push(lastComponent);
      nextComponent = lastComponent.previousComponent;
      delete lastComponent.previousComponent;
      lastComponent = nextComponent;
    }
    components.reverse();
    const componentLen = components.length;
    let componentPos = 0, newPos = 0, oldPos = 0;
    for (; componentPos < componentLen; componentPos++) {
      const component = components[componentPos];
      if (!component.removed) {
        if (!component.added && this.useLongestToken) {
          let value = newTokens.slice(newPos, newPos + component.count);
          value = value.map(function(value2, i) {
            const oldValue = oldTokens[oldPos + i];
            return oldValue.length > value2.length ? oldValue : value2;
          });
          component.value = this.join(value);
        } else {
          component.value = this.join(newTokens.slice(newPos, newPos + component.count));
        }
        newPos += component.count;
        if (!component.added) {
          oldPos += component.count;
        }
      } else {
        component.value = this.join(oldTokens.slice(oldPos, oldPos + component.count));
        oldPos += component.count;
      }
    }
    return components;
  }
};

// node_modules/diff/libesm/diff/line.js
var LineDiff = class extends Diff {
  constructor() {
    super(...arguments);
    this.tokenize = tokenize;
  }
  equals(left, right, options) {
    if (options.ignoreWhitespace) {
      if (!options.newlineIsToken || !left.includes("\n")) {
        left = left.trim();
      }
      if (!options.newlineIsToken || !right.includes("\n")) {
        right = right.trim();
      }
    } else if (options.ignoreNewlineAtEof && !options.newlineIsToken) {
      if (left.endsWith("\n")) {
        left = left.slice(0, -1);
      }
      if (right.endsWith("\n")) {
        right = right.slice(0, -1);
      }
    }
    return super.equals(left, right, options);
  }
};
var lineDiff = new LineDiff();
function diffLines(oldStr, newStr, options) {
  return lineDiff.diff(oldStr, newStr, options);
}
function tokenize(value, options) {
  if (options.stripTrailingCr) {
    value = value.replace(/\r\n/g, "\n");
  }
  const retLines = [], linesAndNewlines = value.split(/(\n|\r\n)/);
  if (!linesAndNewlines[linesAndNewlines.length - 1]) {
    linesAndNewlines.pop();
  }
  for (let i = 0; i < linesAndNewlines.length; i++) {
    const line = linesAndNewlines[i];
    if (i % 2 && !options.newlineIsToken) {
      retLines[retLines.length - 1] += line;
    } else {
      retLines.push(line);
    }
  }
  return retLines;
}

// src/extract/index.ts
import { execFileSync as execFileSync2 } from "node:child_process";

// src/extract/diff.ts
var CONTEXT = 3;
var FULL_UNDER = 40;
function align(oldText, newText) {
  const rows = [];
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
function compress(rows, context = CONTEXT) {
  if (rows.length <= FULL_UNDER) return rows;
  const keep = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.t === " " || r.t === "gap") return;
    for (let j = Math.max(0, i - context); j <= Math.min(rows.length - 1, i + context); j++) keep[j] = true;
  });
  keep[0] = true;
  const out = [];
  let skipped = 0;
  const flush = () => {
    if (skipped) out.push({ t: "gap", s: `${skipped} unchanged line${skipped > 1 ? "s" : ""}` });
    skipped = 0;
  };
  rows.forEach((r, i) => {
    if (keep[i] || r.t === "gap") {
      flush();
      out.push(r);
    } else skipped++;
  });
  flush();
  return out;
}
var baseKey = (k) => k.replace(/#\d+$/, "");
function diffFile(oldText, newText, oldSyms, newSyms, rows = align(oldText ?? "", newText ?? "")) {
  if (!oldSyms && !newSyms) {
    if (!rows.some((r) => r.t !== " ")) return [];
    const status2 = oldText == null ? "added" : newText == null ? "removed" : "modified";
    return [{ key: "file", kind: "file", name: "(whole file)", sig: "", status: status2, rows: status2 === "modified" ? compress(rows) : rows, body: "" }];
  }
  const byOld = /* @__PURE__ */ new Map(), byNew = /* @__PURE__ */ new Map();
  const at = /* @__PURE__ */ new Map();
  rows.forEach((r, i2) => {
    at.set(r, i2);
    if (r.o != null) byOld.set(r.o, r);
    if (r.n != null) byNew.set(r.n, r);
  });
  const pending = [];
  const owner = /* @__PURE__ */ new Map();
  const claim = (p) => {
    p.raw.forEach((r) => {
      if (!owner.has(r)) owner.set(r, p);
    });
    pending.push(p);
  };
  const status = /* @__PURE__ */ new Map();
  const group = (syms) => {
    const m = /* @__PURE__ */ new Map();
    for (const s of syms) m.set(baseKey(s.key), [...m.get(baseKey(s.key)) ?? [], s]);
    return m;
  };
  const olds = group(oldSyms?.syms ?? []), news = group(newSyms?.syms ?? []);
  for (const k of /* @__PURE__ */ new Set([...olds.keys(), ...news.keys()])) {
    const oList = [...olds.get(k) ?? []], nList = [...news.get(k) ?? []];
    for (const n of [...nList]) {
      const i2 = oList.findIndex((o) => o.cmp === n.cmp);
      if (i2 >= 0) {
        status.set(n.key, "same");
        status.set(oList[i2].key, "same");
        oList.splice(i2, 1);
        nList.splice(nList.indexOf(n), 1);
      }
    }
    while (oList.length && nList.length) {
      const a = oList.shift(), b = nList.shift();
      status.set(a.key, "modified");
      status.set(b.key, "modified");
      const ownO = new Set(a.own), ownN = new Set(b.own);
      const raw = rows.filter((r) => r.t === "-" && ownO.has(r.o) || r.t === "+" && ownN.has(r.n) || r.t === " " && (ownO.has(r.o) || ownN.has(r.n)));
      const note = a.iota != null && b.iota != null && a.iota !== b.iota ? `implicit iota value moved from position ${a.iota} to ${b.iota}` : void 0;
      claim({ ...meta(b), status: "modified", raw, full: false, body: b.cmp, ...note ? { note } : {} });
    }
    for (const b of nList) {
      status.set(b.key, "added");
      claim({ ...meta(b), status: "added", raw: b.own.map((n) => byNew.get(n)).filter((x) => !!x && x.t !== "-"), full: true, body: b.cmp });
    }
    for (const a of oList) {
      status.set(a.key, "removed");
      claim({ ...meta(a), status: "removed", raw: a.own.map((o) => byOld.get(o)).filter((x) => !!x && x.t !== "+"), full: true, body: a.cmp });
    }
  }
  const covered = new Set(owner.keys());
  for (const g of newSyms?.groups ?? []) {
    if (g.members.length && g.members.every((k) => status.get(k) === "added")) for (const l of g.lines) {
      const r = byNew.get(l);
      if (r?.t === "+") covered.add(r);
    }
  }
  for (const g of oldSyms?.groups ?? []) {
    if (g.members.length && g.members.every((k) => status.get(k) === "removed")) for (const l of g.lines) {
      const r = byOld.get(l);
      if (r?.t === "-") covered.add(r);
    }
  }
  const changedLoose = (i2) => rows[i2] && rows[i2].t !== " " && !covered.has(rows[i2]);
  for (let pass = 0; pass < 2; pass++) {
    const order = pass === 0 ? rows.map((_, i2) => i2) : rows.map((_, i2) => rows.length - 1 - i2);
    for (const i2 of order) {
      if (!changedLoose(i2) || rows[i2].s.trim() !== "") continue;
      const nb = owner.get(rows[pass === 0 ? i2 - 1 : i2 + 1]);
      if (!nb) continue;
      nb.raw.push(rows[i2]);
      nb.raw.sort((x, y) => at.get(x) - at.get(y));
      owner.set(rows[i2], nb);
      covered.add(rows[i2]);
    }
  }
  const out = pending.map(({ raw, full, ...c }) => ({ ...c, rows: full ? withGaps(raw) : compress(withGaps(raw)) }));
  const loose = rows.map((r) => r.t !== " " && !covered.has(r));
  let i = 0;
  while (i < rows.length) {
    if (!loose[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < rows.length && (loose[j + 1] || rows[j + 1].t === " " && j + 2 < rows.length && loose[j + 2])) j++;
    let from = i, to = j;
    for (let k = 0; k < 2 && from > 0 && rows[from - 1].t === " "; k++) from--;
    for (let k = 0; k < 2 && to + 1 < rows.length && rows[to + 1].t === " "; k++) to++;
    const hunk = rows.slice(from, to + 1);
    const changed = rows.slice(i, j + 1).filter((r) => r.t !== " ");
    const nums = hunk.map((r) => r.n ?? r.o).filter((x) => x != null);
    const first = changed[0];
    const plus = changed.filter((r) => r.t === "+").map((r) => r.s).sort();
    const minus = changed.filter((r) => r.t === "-").map((r) => r.s).sort();
    const what = changed.every((r) => r.s.trim() === "") ? "whitespace" : plus.length && plus.join("\n") === minus.join("\n") ? j === rows.length - 1 && (oldText ?? "").endsWith("\n") !== (newText ?? "").endsWith("\n") ? "end-of-file newline" : "reordered lines" : "lines";
    out.push({
      key: `other@${first.n ?? `o${first.o}`}`,
      kind: "other",
      name: `${what} ${Math.min(...nums)}\u2013${Math.max(...nums)}`,
      sig: "",
      status: newText == null ? "removed" : oldText == null ? "added" : "modified",
      rows: compress(hunk),
      body: ""
    });
    i = j + 1;
  }
  return out.sort((x, y) => firstLine(x) - firstLine(y));
}
function meta(s) {
  return { key: s.key, kind: s.kind, name: s.name, sig: s.sig };
}
function withGaps(rows) {
  const out = [];
  let prevO, prevN;
  for (const r of rows) {
    const jump = r.o != null && prevO != null && r.o > prevO + 1 || r.n != null && prevN != null && r.n > prevN + 1;
    if (jump) out.push({ t: "gap", s: "members shown separately" });
    out.push(r);
    if (r.o != null) prevO = r.o;
    if (r.n != null) prevN = r.n;
  }
  return out;
}
function firstLine(c) {
  const r = c.rows.find((r2) => r2.t !== "gap");
  return r?.n ?? r?.o ?? 0;
}

// src/extract/symbols.ts
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
var EXT = {
  go: "go",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  py: "python"
};
function langOf(path) {
  return EXT[path.split(".").pop().toLowerCase()] ?? null;
}
function hlLang(path) {
  const l = langOf(path);
  return l === "go" ? "go" : l === "python" ? "py" : l ? "ts" : "plain";
}
var wasmDir = fileURLToPath(new URL("./wasm/", import.meta.url));
var runtime;
var parsers = /* @__PURE__ */ new Map();
async function parserFor(lang) {
  if (!runtime) {
    runtime = createRequire(import.meta.url)(wasmDir + "tree-sitter.cjs");
    await runtime.Parser.init({ locateFile: (f) => wasmDir + f });
  }
  if (!parsers.has(lang)) {
    const language = await runtime.Language.load(`${wasmDir}tree-sitter-${lang}.wasm`);
    const p = new runtime.Parser();
    p.setLanguage(language);
    parsers.set(lang, p);
  }
  return parsers.get(lang);
}
async function symbolsOf(lang, src) {
  const tree = (await parserFor(lang)).parse(src);
  const b = new Builder(src);
  const root = tree.rootNode;
  if (lang === "go") goWalk(root, b);
  else if (lang === "python") pyBlock(root.namedChildren, b, "");
  else tsBlock(root.namedChildren, b, "");
  tree.delete();
  return { syms: b.syms, groups: b.groups };
}
var Builder = class {
  syms = [];
  groups = [];
  lines;
  seen = /* @__PURE__ */ new Map();
  constructor(src) {
    this.lines = src.split("\n");
  }
  add(o) {
    let key = `${o.kind === "import" ? "import" : o.kind === "export" ? "export" : kindKey(o.kind)}:${o.key}`;
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    if (n > 1) key += `#${n}`;
    const outer = o.outer ?? o.node;
    const to = endRow(outer);
    const excl = (o.members ?? []).map((m) => [startWithComments(m), endRow(m)]);
    const own = [];
    for (let l = o.from; l <= to; l++) if (!excl.some(([a, z]) => l >= a && l <= z)) own.push(l);
    const lead = o.from < row(outer) ? this.lines.slice(o.from - 1, row(outer) - 1).join("\n") + "\n" : "";
    let body = outer.text;
    for (const m of o.members ?? []) body = body.replace(m.text, "\0");
    const sym = { key, kind: o.kind, name: o.name, sig: tidySig(o.sig), own, cmp: lead + body, ...o.iota != null ? { iota: o.iota } : {} };
    this.syms.push(sym);
    return sym;
  }
  group(from, to, members) {
    const inside = new Set(members.flatMap((m) => m.own));
    const lines = [];
    for (let l = from; l <= to; l++) if (!inside.has(l)) lines.push(l);
    this.groups.push({ lines, members: members.map((m) => m.key) });
  }
};
function kindKey(kind) {
  if (kind === "method" || kind === "field") return kind;
  if (kind === "function" || kind === "func") return "func";
  if (kind === "class") return "class";
  if (kind === "namespace") return "namespace";
  if (["struct", "interface", "type", "enum"].includes(kind)) return "type";
  return "var";
}
function tidySig(s) {
  const t = s.replace(/\s+/g, " ").trim().replace(/\s*[{:]$/, "");
  return t.length > 220 ? t.slice(0, 217) + "\u2026" : t;
}
var row = (n) => n.startPosition.row + 1;
var endRow = (n) => n.endPosition.row + 1 - (n.endPosition.row > n.startPosition.row && n.text.endsWith("\n") ? 1 : 0);
function startWithComments(n) {
  let start = row(n);
  let p = n.previousNamedSibling;
  while (p && p.type === "comment" && endRow(p) === start - 1) {
    start = row(p);
    p = p.previousNamedSibling;
  }
  return start;
}
function header(n, body) {
  if (!body) return n.text.split("\n")[0];
  const i = n.text.lastIndexOf(body.text);
  return i > 0 ? n.text.slice(0, i) : n.text.split("\n")[0];
}
var unquote = (s) => s.replace(/^["'`]|["'`]$/g, "");
var flat = (s) => s.replace(/\s+/g, " ").trim();
function goWalk(root, b) {
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
          const sym = b.add({ kind: specKind(s, kw), key: name, name, sig: `${kw} ${s.text.split("\n")[0]}`, from: startWithComments(s), node: s, ...usesIota ? { iota: i } : {} });
          if (implicit) sym.cmp += `\0iota@${i}`;
          return sym;
        });
        b.group(startWithComments(n), endRow(n), members);
        break;
      }
    }
  }
}
function sameGroup(spec, decl) {
  return spec.startPosition.row >= decl.startPosition.row && spec.endPosition.row <= decl.endPosition.row;
}
function specName(s) {
  return s.childrenForFieldName("name").map((x) => x.text).join(", ") || s.childForFieldName("name")?.text || "?";
}
function specKind(s, kw) {
  if (kw !== "type") return kw;
  const t = s.childForFieldName("type")?.type;
  return t === "struct_type" ? "struct" : t === "interface_type" ? "interface" : "type";
}
var TS_DECL = /* @__PURE__ */ new Set([
  "function_declaration",
  "generator_function_declaration",
  "class_declaration",
  "abstract_class_declaration",
  "interface_declaration",
  "type_alias_declaration",
  "enum_declaration",
  "lexical_declaration",
  "variable_declaration",
  "function_signature",
  "internal_module",
  "module",
  "ambient_declaration"
]);
var MEMBER_TYPES = /* @__PURE__ */ new Set(["method_definition", "abstract_method_signature", "method_signature", "public_field_definition", "field_definition"]);
function unwrap(outer) {
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
var nameOf = (n) => n.childForFieldName("name")?.text ?? "";
function tsBlock(nodes, b, prefix) {
  const foldInto = /* @__PURE__ */ new Map();
  for (let i = 0; i < nodes.length; i++) {
    if (unwrap(nodes[i]).n.type !== "function_signature") continue;
    let j = i;
    while (j < nodes.length && unwrap(nodes[j]).n.type === "function_signature") j++;
    const impl = nodes[j] && unwrap(nodes[j]).n;
    if (impl?.type === "function_declaration" && nameOf(impl) === nameOf(unwrap(nodes[i]).n)) foldInto.set(i, j);
  }
  const foldStart = /* @__PURE__ */ new Map();
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
      b.add({ kind: "export", key, name: text.length > 60 ? text.slice(0, 57) + "\u2026" : text, sig: text, from, node: outer });
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
function pyBlock(nodes, b, cls) {
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

// src/extract/index.ts
var LFS = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;
var isBinary = (s) => s != null && s.slice(0, 8e3).includes("\0");
async function extract(store2) {
  const { cfg, tree, edits, decisions, links, claims, ignored } = store2.withLock(() => ({
    cfg: store2.config(),
    tree: snapshot(store2),
    edits: store2.edits(),
    decisions: store2.decisions(),
    links: store2.links(),
    claims: store2.claims(),
    ignored: store2.ignoredWrites()
  }));
  const warnings = [];
  const baseTree = treeOf(store2.root, cfg.base);
  const reader = cachedReader(store2.root);
  const files = {};
  const changes = [];
  for (const ch of changedFiles(store2.root, cfg.base, tree)) {
    const status = ch.status === "A" ? "added" : ch.status === "D" ? "deleted" : "modified";
    files[ch.path] = { lang: hlLang(ch.path), status };
    const fileLevel = (name, rows2, note) => {
      files[ch.path].note = note;
      changes.push({ key: `file:${name}`, kind: "file", name, sig: "", status: status === "deleted" ? "removed" : status, rows: rows2, body: "", file: ch.path, extra: fileLabels(store2.root, cfg, baseTree, tree, edits, ch.path) });
    };
    if (ch.oldMode === "160000" || ch.newMode === "160000") {
      fileLevel("(submodule)", modeRows(ch, (sha) => `Subproject commit ${sha}`), "submodule pointer");
      continue;
    }
    const oldText = ch.status === "A" ? null : reader(cfg.base, ch.path);
    const newText = ch.status === "D" ? null : reader(tree, ch.path);
    if (ch.status === "M" && ch.oldMode !== ch.newMode) fileLevel("(file mode)", [{ t: "-", s: `mode ${ch.oldMode}` }, { t: "+", s: `mode ${ch.newMode}` }], `mode ${ch.oldMode} \u2192 ${ch.newMode}`);
    if (isBinary(oldText) || isBinary(newText)) {
      fileLevel("(binary file)", [], "binary");
      continue;
    }
    if (oldText === newText && ch.status === "M") continue;
    const special = ch.oldMode === "120000" || ch.newMode === "120000" ? "symlink" : LFS.test(oldText ?? "") || LFS.test(newText ?? "") ? "Git LFS pointer; content not shown" : null;
    const lang = special ? null : langOf(ch.path);
    let oldSyms = null, newSyms = null;
    if (lang) {
      try {
        oldSyms = oldText != null ? await symbolsOf(lang, oldText) : { syms: [], groups: [] };
        newSyms = newText != null ? await symbolsOf(lang, newText) : { syms: [], groups: [] };
      } catch (err) {
        warnings.push(`could not parse ${ch.path} (${err.message}); showing it as a whole-file change`);
        oldSyms = newSyms = null;
      }
    }
    if (special) files[ch.path].note = special;
    const rows = align(oldText ?? "", newText ?? "");
    const prov = track(cfg, baseTree, edits, ch.path, oldText, newText, reader);
    for (const r of rows) {
      if (r.t === "+") r.p = prov.added(r.n, r.s);
      else if (r.t === "-") r.p = prov.removed(r.o);
    }
    const found = diffFile(oldText, newText, oldSyms, newSyms, rows);
    if (!found.length) {
      fileLevel(oldText === "" || newText === "" || oldText == null || newText == null ? "(empty file)" : "(whole file)", rows, files[ch.path].note ?? "no line changes");
      continue;
    }
    const allLabels = new Set(rows.filter((r) => r.p).map((r) => r.p));
    for (const c of found) {
      const hasChange = c.rows.some((r) => r.t === "+" || r.t === "-");
      changes.push({ ...c, file: ch.path, extra: hasChange ? /* @__PURE__ */ new Set() : new Set(allLabels) });
    }
  }
  detectMoves(changes);
  const ignoredWrites = [...new Set(ignored.map((w) => w.file))].filter((f) => !files[f]);
  const byId = new Map(edits.map((e) => [e.id, e]));
  const paths = Object.keys(files);
  const symbols = changes.map((c) => attribute(c, byId, links, claims, paths));
  const stamps = [...edits.map((e) => e.ts), ...decisions.map((d) => d.ts)].sort();
  return {
    base: cfg.base,
    tree,
    branch: currentBranch(store2.root),
    startedOn: cfg.branch,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    sessions: [...new Set([...edits.filter((e) => !e.unverified), ...decisions].map((x) => x.session).filter((s) => !!s))],
    span: stamps.length ? [stamps[0], stamps[stamps.length - 1]] : null,
    files,
    decisions,
    symbols,
    ignoredWrites,
    warnings
  };
}
function cachedReader(root) {
  const cache = /* @__PURE__ */ new Map();
  return (tree, path) => {
    const k = `${tree}:${path}`;
    if (!cache.has(k)) cache.set(k, readAt(root, tree, path));
    return cache.get(k);
  };
}
function modeRows(ch, fmt) {
  const rows = [];
  if (ch.status !== "A") rows.push({ t: "-", s: fmt(ch.oldSha) });
  if (ch.status !== "D") rows.push({ t: "+", s: fmt(ch.newSha) });
  return rows;
}
function splitLines(text) {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function track(cfg, baseTree, edits, path, baseText, finalText, read) {
  let text = baseText ?? "";
  const baseLines = splitLines(text);
  let lines = baseLines.map((_, i) => ({ base: i + 1 }));
  const removedBy = /* @__PURE__ */ new Map();
  const step = (next, label) => {
    const nt = next ?? "";
    if (nt === text) return;
    const cur = splitLines(text);
    const parts = diffLines(text, nt).map((p) => ({ ...p, lines: splitLines(p.value) }));
    const pool = /* @__PURE__ */ new Map();
    let i = 0;
    for (const p of parts) {
      if (p.added) continue;
      for (let k = 0; k < p.lines.length; k++, i++) {
        const b = lines[i]?.base;
        if (p.removed && b != null) pool.set(cur[i], [...pool.get(cur[i]) ?? [], b]);
      }
    }
    const carried = /* @__PURE__ */ new Set();
    const out = [];
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
    added(n, s) {
      const o = lines[n - 1];
      if (o?.label) return o.label;
      const k = finalLines.findIndex((x, j) => x === s && lines[j]?.label);
      return k >= 0 ? lines[k].label : "outside";
    },
    removed(o) {
      const by = removedBy.get(o);
      if (by) return by;
      const moved = lines.find((x) => x.base === o && x.label);
      return moved?.label ?? "outside";
    }
  };
}
function fileLabels(root, cfg, baseTree, finalTree, edits, path) {
  const sha = (tree) => {
    try {
      return execFileSync2("git", ["-C", root, "ls-tree", "-z", tree, "--", `:(literal)${path}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).split("	")[0];
    } catch {
      return "";
    }
  };
  const labels = /* @__PURE__ */ new Set();
  let cur = sha(baseTree);
  const step = (tree, label) => {
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
function detectMoves(changes) {
  const movable = (c) => c.body && c.kind !== "import" && c.kind !== "other" && c.kind !== "file";
  const removed = changes.filter((c) => c.status === "removed" && movable(c));
  const added = changes.filter((c) => c.status === "added" && movable(c));
  for (const add of added) {
    const short = add.name.split(".").pop();
    const same = (c) => c.body === add.body && c.name.split(".").pop() === short;
    const cands = removed.filter(same);
    if (cands.length !== 1 || added.filter(same).length !== 1) continue;
    const r = cands[0];
    removed.splice(removed.indexOf(r), 1);
    add.status = "moved";
    add.movedFrom = r.file;
    for (const row2 of [...add.rows, ...r.rows]) if (row2.p) add.extra.add(row2.p);
    add.rows = add.rows.map((row2) => row2.t === "+" ? { ...row2, t: " " } : row2);
    changes.splice(changes.indexOf(r), 1);
  }
}
function parseClaim(spec, paths) {
  const clean = spec.trim().replace(/^\.\//, "");
  const i = clean.lastIndexOf(":");
  if (i > 0) return { file: clean.slice(0, i), symbol: clean.slice(i + 1) };
  if (paths.includes(clean) || /\/|\.\w+$/.test(clean)) return { file: clean };
  return { symbol: clean };
}
function claimKind(c, s, paths) {
  const { file, symbol } = parseClaim(c.spec, paths);
  if (file && file !== s.file && file !== s.movedFrom) return null;
  if (!symbol) return "file";
  return symbol === s.name || symbol === s.name.split(".").pop() ? "symbol" : null;
}
function attribute(c, byId, links, claims, paths) {
  const labels = new Set(c.extra);
  for (const r of c.rows) if ((r.t === "+" || r.t === "-") && r.p) labels.add(r.p);
  const editIds = [...labels].filter((l) => byId.has(l));
  const decisions = /* @__PURE__ */ new Set();
  const unlinked = [];
  const relevant = claims.map((cl) => ({ cl, kind: claimKind(cl, c, paths) })).filter((x) => x.kind);
  const used = /* @__PURE__ */ new Set();
  for (const id of editIds) {
    const e = byId.get(id);
    const same = relevant.filter(({ cl }) => cl.edits.has(id));
    const bySym = same.filter((x) => x.kind === "symbol").map((x) => x.cl);
    const chosen = bySym.length ? bySym : same.filter((x) => x.kind === "file").map((x) => x.cl);
    chosen.forEach((cl) => used.add(cl));
    const link = links.get(id);
    const ds = [...new Set(chosen.length ? chosen.map((cl) => cl.decision) : link ? [link] : [])];
    if (!ds.length) unlinked.push(id);
    ds.forEach((d) => decisions.add(d));
  }
  const later = [...new Set(relevant.filter(({ cl }) => !used.has(cl) && !decisions.has(cl.decision)).map(({ cl }) => cl.decision))];
  const gaps = { outside: labels.has("outside"), before: labels.has("before"), unlinked };
  return {
    id: `${c.file}#${c.key}`,
    file: c.file,
    kind: c.kind,
    name: c.name,
    sig: c.sig,
    status: c.status,
    ...c.movedFrom ? { movedFrom: c.movedFrom } : {},
    ...c.note ? { note: c.note } : {},
    rows: c.rows,
    edits: editIds,
    decisions: [...decisions],
    later,
    gaps,
    explained: editIds.length > 0 && !gaps.outside && !gaps.before && unlinked.length === 0
  };
}

// src/hook.ts
import { appendFileSync as appendFileSync3, readFileSync as readFileSync3, realpathSync as realpathSync3 } from "node:fs";
import { basename, dirname, isAbsolute as isAbsolute2, join as join3, relative as relative2, resolve, sep } from "node:path";

// src/store.ts
import { randomBytes } from "node:crypto";
import { appendFileSync as appendFileSync2, existsSync as existsSync2, lstatSync as lstatSync2, mkdirSync, readFileSync as readFileSync2, realpathSync as realpathSync2, renameSync, rmSync, writeFileSync } from "node:fs";
import { join as join2, relative } from "node:path";
var Store = class {
  constructor(root) {
    this.root = root;
  }
  root;
  depth = 0;
  get dir() {
    return join2(this.root, ".understand");
  }
  path(...parts) {
    return join2(this.dir, ...parts);
  }
  /** .understand must be a real directory inside the repo; anything else could redirect writes. */
  assertSafe() {
    if (!existsSync2(this.dir)) return;
    if (lstatSync2(this.dir).isSymbolicLink()) throw new Error(".understand is a symlink; refusing to record through it");
    const rel = relative(realpathSync2(this.root), realpathSync2(this.dir));
    if (rel !== ".understand") throw new Error(".understand resolves outside the repository");
  }
  exists() {
    this.assertSafe();
    return existsSync2(this.path("config.json"));
  }
  /**
   * Serialize every read-modify-write across hooks and CLI calls (reentrant within a process).
   * The lock records its owner; it is only reclaimed when that process is gone, never by age.
   */
  withLock(fn) {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    this.assertSafe();
    mkdirSync(this.dir, { recursive: true });
    const lock = this.path("lock");
    const owner = join2(lock, "owner");
    const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
    const start = Date.now();
    for (; ; ) {
      try {
        mkdirSync(lock);
        writeFileSync(owner, token);
        break;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
        if (ownerGone(owner)) {
          const stale = `${lock}.stale.${process.pid}.${Date.now()}`;
          try {
            renameSync(lock, stale);
            if (ownerGone(join2(stale, "owner"))) rmSync(stale, { recursive: true, force: true });
            else renameSync(stale, lock);
          } catch {
          }
          continue;
        }
        if (Date.now() - start > 6e4) throw new Error("timed out waiting for .understand/lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    this.depth = 1;
    try {
      return fn();
    } finally {
      this.depth = 0;
      try {
        if (readFileSync2(owner, "utf8") === token) rmSync(lock, { recursive: true, force: true });
      } catch {
      }
    }
  }
  config() {
    const c = JSON.parse(readFileSync2(this.path("config.json"), "utf8"));
    if (c.version !== 2) throw new Error("this recording was made by an older understand; run `understand init --force` to start a new one");
    return c;
  }
  writeConfig(c) {
    writeAtomic(this.path("config.json"), JSON.stringify(c, null, 2) + "\n");
  }
  state() {
    let raw;
    try {
      raw = readFileSync2(this.path("state.json"), "utf8");
    } catch (e) {
      if (e.code === "ENOENT") throw new Error("recording state is missing; run `understand init --force`");
      throw e;
    }
    return JSON.parse(raw);
  }
  writeState(s) {
    writeAtomic(this.path("state.json"), JSON.stringify(s, null, 2) + "\n");
  }
  updateState(fn) {
    this.withLock(() => {
      const s = this.state();
      fn(s);
      this.writeState(s);
    });
  }
  session(s, id) {
    return id && s.sessions[id] || { turn: 0, hooked: false };
  }
  decisions() {
    return readJsonl(this.path("decisions.jsonl")).filter((d) => /^D\d+$/.test(d.id));
  }
  edits() {
    return readJsonl(this.path("edits.jsonl")).filter((e) => /^E\d+$/.test(e.id));
  }
  linkRecords() {
    return readJsonl(this.path("links.jsonl")).filter((l) => /^D\d+$/.test(l.decision));
  }
  ignoredWrites() {
    return readJsonl(this.path("ignored.jsonl"));
  }
  addDecision(d) {
    return this.withLock(() => {
      const rec = { id: `D${nextNumber(this.decisions().map((x) => x.id))}`, ...d };
      append(this.path("decisions.jsonl"), rec);
      return rec;
    });
  }
  addEdit(e) {
    return this.withLock(() => {
      const rec = { id: `E${nextNumber(this.edits().map((x) => x.id))}`, ...e };
      append(this.path("edits.jsonl"), rec);
      return rec;
    });
  }
  addLink(l) {
    this.withLock(() => append(this.path("links.jsonl"), l));
  }
  addIgnoredWrite(file) {
    this.withLock(() => append(this.path("ignored.jsonl"), { file, ts: (/* @__PURE__ */ new Date()).toISOString() }));
  }
  /** Edit id → decision id, from adoption by `decide` or `link`. First claim wins. */
  links() {
    const m = /* @__PURE__ */ new Map();
    const all = [...this.decisions().map((d) => ({ decision: d.id, adopts: d.adopts, ts: d.ts })), ...this.linkRecords()];
    all.sort((a, b) => a.ts.localeCompare(b.ts));
    for (const r of all) for (const id of r.adopts) if (!m.has(id)) m.set(id, r.decision);
    return m;
  }
  claims() {
    const out = [];
    for (const r of [...this.decisions().map((d) => ({ ...d, decision: d.id })), ...this.linkRecords()]) {
      const edits = new Set(r.claimable ?? []);
      for (const spec of r.for ?? []) out.push({ decision: r.decision, spec, edits });
    }
    return out;
  }
  /** Agent edits from this session's current turn, explained or not. */
  turnEdits(session) {
    const turn = this.session(this.state(), session).turn;
    return this.edits().filter((e) => !e.unverified && e.session === session && e.turn === turn);
  }
  /**
   * Agent edits from this session's current turn that no decision explains yet. Earlier turns are
   * closed: whatever they left unexplained stays unexplained rather than being explained later.
   */
  unlinkedEdits(session) {
    const links = this.links();
    const turn = this.session(this.state(), session).turn;
    return this.edits().filter((e) => !e.unverified && !links.has(e.id) && e.session === session && e.turn === turn);
  }
};
function ownerGone(owner) {
  let pid;
  try {
    pid = Number(readFileSync2(owner, "utf8").split(" ")[0]);
  } catch {
    return false;
  }
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return e.code === "ESRCH";
  }
}
var nextNumber = (ids) => Math.max(0, ...ids.map((id) => Number(id.slice(1)) || 0)) + 1;
function append(file, rec) {
  let prefix = "";
  try {
    const cur = readFileSync2(file, "utf8");
    if (cur && !cur.endsWith("\n")) prefix = "\n";
  } catch {
  }
  appendFileSync2(file, prefix + JSON.stringify(rec) + "\n");
}
function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}
function readJsonl(file) {
  if (!existsSync2(file)) return [];
  const out = [];
  for (const line of readFileSync2(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      process.stderr.write(`warning: skipping a corrupt line in ${file}
`);
    }
  }
  return out;
}

// src/hook.ts
var FILE_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
function runHook(event) {
  let store2 = null;
  try {
    const p = JSON.parse(readFileSync3(0, "utf8") || "{}");
    const root = repoRoot(p.cwd || process.cwd());
    if (!root) return;
    store2 = new Store(root);
    if (!store2.exists()) return;
    if (process.env.UNDERSTAND_DEBUG) appendFileSync3(store2.path("hook-payloads.jsonl"), JSON.stringify({ event, ...p }) + "\n");
    const out = handlers[event]?.(store2, p);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    const msg = `${(/* @__PURE__ */ new Date()).toISOString()} ${event} ${err.stack}`;
    try {
      if (store2) appendFileSync3(store2.path("hook-errors.log"), msg + "\n");
    } catch {
    }
    process.stderr.write(`understand: recording failed during ${event}: ${err.message}
`);
    if (event === "stop") process.stdout.write(JSON.stringify({ systemMessage: `Understand could not check this turn: ${err.message}` }));
  }
}
function touchSession(s, session) {
  s.updateState((st) => {
    if (!session) return;
    st.sessions[session] = { turn: st.sessions[session]?.turn ?? 0, hooked: true };
    st.lastHookSession = session;
  });
}
var handlers = {
  "session-start"(s, p) {
    const session = p.session_id ?? null;
    touchSession(s, session);
    capture(s, { session, tool: "checkpoint", unverified: true });
    const recent = s.decisions().slice(-15).map((d) => `  ${d.id} [${d.by}] ${d.title}`).join("\n");
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "Understand is recording decisions in this repo (.understand/). Follow the understand:record skill: after the edits for each design choice (yours or the user's), run `understand decide` naming what it shaped with --for. Paraphrase, never quote the user." + (recent ? `
Decisions recorded so far:
${recent}` : "")
      }
    };
  },
  "pre-tool-use"(s, p) {
    const session = p.session_id ?? null;
    touchSession(s, session);
    capture(s, { session, tool: "checkpoint", unverified: true });
  },
  "post-tool-use"(s, p) {
    const session = p.session_id ?? null;
    const tool = p.tool_name ?? "";
    const input = p.tool_input ?? {};
    const file = FILE_TOOLS.has(tool) ? relFile(s.root, input.file_path ?? input.notebook_path) : null;
    capture(s, { session, tool, command: tool === "Bash" ? String(input.command ?? "") : void 0, ...FILE_TOOLS.has(tool) ? { only: file ?? "\0" } : {} });
    if (file && isIgnored(s.root, file)) s.addIgnoredWrite(file);
  },
  stop(s, p) {
    const session = p.session_id ?? null;
    let captureError = "";
    try {
      capture(s, { session, tool: "checkpoint", unverified: true });
    } catch (err) {
      captureError = ` (Understand also couldn't snapshot the worktree: ${err.message})`;
    }
    const pending = s.unlinkedEdits(session);
    if (pending.length && !p.stop_hook_active) {
      const files = [...new Set(pending.flatMap((e) => e.files))];
      return {
        decision: "block",
        reason: `Understand: ${pending.length} edit${pending.length > 1 ? "s" : ""} this session ha${pending.length > 1 ? "ve" : "s"} no recorded decision (${files.slice(0, 6).join(", ")}${files.length > 6 ? ", \u2026" : ""}). If they came from a decision you already recorded, run \`understand link D<n> --for <file>:<Symbol>\`. Otherwise record why with \`understand decide --title \u2026 --why \u2026 --by agent|human --for <file>:<Symbol>\`, or \`understand decide --mechanical --title \u2026\` if they were mechanical. Then finish your reply.` + captureError
      };
    }
    s.updateState((st) => {
      if (session) st.sessions[session] = { hooked: true, turn: (st.sessions[session]?.turn ?? 0) + 1 };
    });
  }
};
function real(p) {
  try {
    return realpathSync3(p);
  } catch {
    try {
      return join3(realpathSync3(dirname(p)), basename(p));
    } catch {
      return p;
    }
  }
}
function relFile(root, p) {
  if (typeof p !== "string" || !p) return null;
  const rel = relative2(real(root), real(isAbsolute2(p) ? p : resolve(root, p)));
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute2(rel)) return null;
  if (rel === ".understand" || rel.startsWith(".understand" + sep)) return null;
  return rel;
}

// src/narration.ts
import { existsSync as existsSync3, readFileSync as readFileSync4 } from "node:fs";
function readNarration(path) {
  if (!existsSync3(path)) return null;
  return JSON.parse(readFileSync4(path, "utf8"));
}
var ATTN = /* @__PURE__ */ new Set(["careful", "skim", "mechanical"]);
function check(x, n) {
  const errors = [];
  const ids = new Set(x.symbols.map((s) => s.id));
  const decs = new Set(x.decisions.map((d) => d.id));
  const placed = /* @__PURE__ */ new Map();
  if (!n.title?.trim()) errors.push("title is empty");
  if (!n.intent?.trim()) errors.push("intent is empty");
  (n.chapters ?? []).forEach((c, i) => {
    if (!c.title?.trim()) errors.push(`chapter ${i + 1} has no title`);
    for (const id of c.symbols ?? []) {
      if (!ids.has(id)) errors.push(`chapter ${i + 1} lists unknown symbol ${id}`);
      else if (placed.has(id)) errors.push(`${id} is in chapters ${placed.get(id) + 1} and ${i + 1}`);
      else placed.set(id, i);
    }
  });
  for (const [id, note] of Object.entries(n.symbols ?? {})) {
    if (!ids.has(id)) {
      errors.push(`notes for unknown symbol ${id}`);
      continue;
    }
    if (!note.summary?.trim()) errors.push(`${id}: summary is empty`);
    if (!ATTN.has(note.attention)) errors.push(`${id}: attention must be careful, skim or mechanical`);
    for (const d of note.decisions ?? []) if (!decs.has(d)) errors.push(`${id}: unknown decision ${d}`);
    for (const r of note.related ?? []) if (!ids.has(r)) errors.push(`${id}: related symbol ${r} does not exist`);
  }
  const missing = x.symbols.filter((s) => !placed.has(s.id) || !n.symbols?.[s.id]).map((s) => s.id);
  return { errors, missing };
}

// src/render.ts
import { createHash } from "node:crypto";
import { readFileSync as readFileSync5 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var ATTN2 = /* @__PURE__ */ new Set(["careful", "skim", "mechanical"]);
var STATUS = /* @__PURE__ */ new Set(["added", "removed", "modified", "moved"]);
function viewerData(x, n) {
  const sessionNo = new Map(x.sessions.map((s, i) => [s, i + 1]));
  const domId = new Map(x.symbols.map((s, i) => [s.id, `s${i}`]));
  const decIds = new Set(x.decisions.map((d) => d.id));
  const supersededBy = new Map(x.decisions.filter((d) => d.supersedes).map((d) => [d.supersedes, d.id]));
  const placed = /* @__PURE__ */ new Set();
  const chapters = (n?.chapters ?? []).map((c, i) => {
    const syms = c.symbols.filter((id) => domId.has(id) && !placed.has(id));
    syms.forEach((id) => placed.add(id));
    return { id: `c${i}`, title: String(c.title), sum: String(c.summary ?? ""), syms: syms.map((id) => domId.get(id)) };
  });
  const rest = x.symbols.filter((s) => !placed.has(s.id));
  if (rest.length) {
    chapters.push({
      id: "c-rest",
      title: n ? "Not placed in the story" : "Changes",
      sum: n ? "The narration didn't cover these symbols. They're listed so nothing is hidden." : "No narration yet. Run the narrate skill to explain these changes.",
      syms: rest.map((s) => domId.get(s.id))
    });
  }
  const symbols = x.symbols.map((s) => {
    const note = n?.symbols?.[s.id];
    const later = [.../* @__PURE__ */ new Set([...s.later, ...note?.decisions ?? []])].filter((d) => decIds.has(d) && !s.decisions.includes(d));
    const unlinked = new Set(s.gaps.unlinked);
    const rows = s.rows.map((r) => {
      const flag = r.t === "+" || r.t === "-" ? r.p === "outside" ? "o" : r.p === "before" ? "b" : r.p && unlinked.has(r.p) ? "u" : void 0 : void 0;
      return { t: r.t, o: r.o, n: r.n, s: r.s, ...flag ? { x: flag } : {} };
    });
    const mechanicalOnly = s.decisions.length > 0 && s.decisions.every((d) => x.decisions.find((z) => z.id === d)?.mechanical);
    const attn = note?.attention && ATTN2.has(note.attention) ? note.attention : mechanicalOnly ? "mechanical" : "skim";
    const shown = [...s.decisions, ...later].map((d) => x.decisions.find((z) => z.id === d)).map((d) => d && [d.id, d.title, d.why, d.alternatives]);
    const fp = createHash("sha1").update(JSON.stringify([s.rows, s.gaps, later, shown, note ?? null])).digest("hex").slice(0, 10);
    return {
      id: domId.get(s.id),
      key: `${s.id}@${fp}`,
      file: s.file,
      kind: s.kind,
      name: s.name,
      sig: s.sig,
      status: STATUS.has(s.status) ? s.status : "modified",
      moved: s.movedFrom,
      note: s.note,
      rows,
      dec: s.decisions,
      later,
      gaps: { outside: s.gaps.outside, before: s.gaps.before, unlinked: s.gaps.unlinked.length },
      explained: s.explained,
      attn,
      sum: note?.summary ?? null,
      why: note?.why,
      how: note?.how,
      risk: note?.risk,
      rel: (note?.related ?? []).map((r) => domId.get(r)).filter(Boolean)
    };
  });
  return {
    title: n?.title ?? "Unnarrated changes",
    intent: n?.intent ?? "",
    branch: x.branch,
    startedOn: x.startedOn,
    base: x.base.slice(0, 8),
    generatedAt: x.generatedAt,
    sessions: x.sessions.length,
    span: x.span,
    files: x.files,
    ignoredWrites: x.ignoredWrites,
    warnings: x.warnings,
    decisions: x.decisions.map((d) => ({
      id: d.id,
      who: d.by === "human" ? "human" : "agent",
      title: d.title,
      ctx: d.why,
      alts: d.alternatives,
      supersedes: d.supersedes,
      supersededBy: supersededBy.get(d.id),
      mechanical: !!d.mechanical,
      session: d.session ? sessionNo.get(d.session) ?? null : null
    })),
    chapters,
    symbols
  };
}
function renderHtml(x, n) {
  const tpl = readFileSync5(fileURLToPath2(new URL("./viewer.html", import.meta.url)), "utf8");
  const json = JSON.stringify(viewerData(x, n)).replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const title = (n?.title ?? "Changes").replace(/[<>&`"]/g, "");
  return tpl.replace("/*__UNDERSTAND_DATA__*/null", () => json).replace("<title>Understand</title>", () => `<title>Understand \xB7 ${title}</title>`);
}

// src/cli.ts
var HELP = `understand: record why code changed, then render a reviewable explanation.

Usage:
  understand init [--base <ref>] [--force]   Start recording (baseline = current worktree, or <ref> to widen the diff)
  understand decide --title <t> --why <w> [--by agent|human] [--for <file>[:<Symbol>]]... [--alt <a>]...
                   [--supersedes <Dn>] [--mechanical]
                                             Record a decision; it explains every edit not yet linked to one
  understand link <Dn> [--for <file>[:<Symbol>]]...
                                             Attach unlinked edits to a decision recorded earlier
  understand status                          Decisions, edits, and edits still missing a decision
  understand decisions                       List every recorded decision
  understand extract                         Symbol-level diff vs. baseline \u2192 .understand/extract.json
  understand check                           Validate .understand/narration.json against the diff
  understand render [--out <file>] [--open]  Write the HTML review page (refuses invalid narration)
  understand hook <event>                    (internal) Claude Code hook entry point

Examples:
  understand decide --by human --title "Never retry POST requests" \\
    --why "User said a duplicate charge is worse than a failed request" \\
    --for client/retry.go:isIdempotent --for client/client.go:Client.Do \\
    --alt "Idempotency keys: upstream doesn't support them"
  understand decide --mechanical --title "Rename fetchData to loadUser across callers"
  understand link D3 --for store/store.go:Store.Due
`;
var BOOL = /* @__PURE__ */ new Set(["force", "mechanical", "open", "help"]);
var VALUE = /* @__PURE__ */ new Set(["title", "why", "by", "alt", "for", "supersedes", "base", "out"]);
function parse(argv) {
  const [cmd = "help", ...rest] = argv;
  const flags = {}, args = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--") || a === "--") {
      args.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (BOOL.has(k)) {
      if (eq > 0) fail(`--${k} takes no value`);
      (flags[k] ??= []).push("true");
    } else if (VALUE.has(k)) {
      const v = eq > 0 ? a.slice(eq + 1) : rest[++i];
      if (v === void 0) fail(`--${k} needs a value`);
      (flags[k] ??= []).push(v);
    } else fail(`unknown option --${k}. Run \`understand help\`.`);
  }
  return { cmd, args, flags };
}
var one = (f, k) => f[k]?.[f[k].length - 1];
function fail(msg) {
  process.stderr.write(`understand: ${msg}
`);
  process.exit(1);
}
function store() {
  const root = repoRoot(process.cwd());
  if (!root) fail("not inside a git repository");
  return new Store(root);
}
function ready() {
  const s = store();
  if (!s.exists()) fail("not recording here yet. Run `understand init` first.");
  s.config();
  return s;
}
function sessionOf(s) {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || s.state().lastHookSession || null;
}
function newId() {
  return (/* @__PURE__ */ new Date()).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + randomBytes2(3).toString("hex");
}
async function main() {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  switch (cmd) {
    case "init": {
      const s = store();
      s.assertSafe();
      if (s.exists() && !flags.force) {
        const c = s.config();
        console.log(`Already recording since ${c.createdAt} (baseline ${c.base.slice(0, 8)}). Use --force to start over.`);
        return;
      }
      const baseRef = one(flags, "base");
      let baseTree = null;
      if (baseRef) {
        try {
          baseTree = treeOf(s.root, baseRef);
        } catch {
          fail(`--base ${baseRef}: not a commit or tree`);
        }
      }
      s.withLock(() => {
        mkdirSync2(s.dir, { recursive: true });
        excludeLogDir(s.root);
        const fresh = !existsSync4(s.path("config.json"));
        if (fresh) rmSync2(s.path("index"), { force: true });
        const tree = snapshot(s);
        const id = newId();
        const baseRefName = `refs/understand/${id}`;
        const base = pinTree(s.root, baseTree ?? tree, baseRefName);
        if (!fresh) archive(s);
        s.writeState({ lastTree: tree, sessions: {} });
        s.writeConfig({ version: 2, id, base, baseRef: baseRefName, initTree: tree, branch: currentBranch(s.root), createdAt: (/* @__PURE__ */ new Date()).toISOString() });
        console.log(
          `Recording in ${s.root}. Baseline: ${baseRef ?? "current worktree"} (${base.slice(0, 8)}). Log: .understand/ (git-excluded)` + (baseRef ? `
Changes already between the baseline and now will show as "before recording": their reasons weren't captured.` : "")
        );
      });
      return;
    }
    case "decide": {
      const s = ready();
      const title = one(flags, "title")?.trim();
      if (!title) fail("--title is required");
      const mechanical = !!flags.mechanical;
      const why = (one(flags, "why") ?? "").trim();
      if (!why && !mechanical) fail("--why is required: paraphrase the reason (use --mechanical for edits with no design choice)");
      const by = one(flags, "by") ?? "agent";
      if (by !== "agent" && by !== "human") fail("--by must be agent or human");
      const supersedes = one(flags, "supersedes");
      if (supersedes && !s.decisions().some((d2) => d2.id === supersedes)) fail(`--supersedes ${supersedes}: no such decision`);
      const d = s.withLock(() => {
        const session = sessionOf(s);
        capture(s, { session, tool: s.session(s.state(), session).hooked ? "Bash" : "checkpoint", command: "(changes made in the same command as `understand decide`)" });
        const adopts = s.unlinkedEdits(session).map((e) => e.id);
        return s.addDecision({
          ts: (/* @__PURE__ */ new Date()).toISOString(),
          session,
          turn: s.session(s.state(), session).turn,
          title,
          why,
          by,
          alternatives: flags.alt ?? [],
          ...flags.for ? { for: flags.for, claimable: s.turnEdits(session).map((e) => e.id) } : {},
          ...supersedes ? { supersedes } : {},
          ...mechanical ? { mechanical } : {},
          adopts
        });
      });
      const files = [...new Set(s.edits().filter((e) => d.adopts.includes(e.id)).flatMap((e) => e.files))];
      console.log(`${d.id} recorded${d.adopts.length ? `; explains ${d.adopts.length} edit${d.adopts.length > 1 ? "s" : ""} (${files.join(", ")})` : "; no unlinked edits to explain yet"}.`);
      return;
    }
    case "link": {
      const s = ready();
      const id = args[0];
      if (!id || !s.decisions().some((d) => d.id === id)) fail(`usage: understand link <Dn> [--for <file>[:<Symbol>]]... (${id ?? "no id"} is not a recorded decision)`);
      const adopts = s.withLock(() => {
        const session = sessionOf(s);
        capture(s, { session, tool: s.session(s.state(), session).hooked ? "Bash" : "checkpoint", command: "(changes made in the same command as `understand link`)" });
        const adopts2 = s.unlinkedEdits(session).map((e) => e.id);
        s.addLink({ decision: id, ts: (/* @__PURE__ */ new Date()).toISOString(), session, turn: s.session(s.state(), session).turn, adopts: adopts2, ...flags.for ? { for: flags.for, claimable: s.turnEdits(session).map((e) => e.id) } : {} });
        return adopts2;
      });
      console.log(`${id} now also explains ${adopts.length} edit${adopts.length === 1 ? "" : "s"}${flags.for ? ` and names ${flags.for.join(", ")}` : ""}.`);
      return;
    }
    case "status": {
      const s = ready();
      const c = s.config();
      const pending = s.unlinkedEdits(sessionOf(s));
      console.log(`Recording since ${c.createdAt} (started on ${c.branch}), baseline ${c.base.slice(0, 8)}`);
      console.log(`${s.decisions().length} decisions, ${s.edits().length} captured changes`);
      if (pending.length) console.log(`${pending.length} edits without a decision: ${[...new Set(pending.flatMap((e) => e.files))].join(", ")}`);
      return;
    }
    case "decisions": {
      const s = ready();
      for (const d of s.decisions()) {
        console.log(`${d.id} [${d.by}${d.mechanical ? ", mechanical" : ""}]${d.supersedes ? ` (revises ${d.supersedes})` : ""} ${d.title}`);
        if (d.why) console.log(`    why: ${d.why}`);
        if (d.for?.length) console.log(`    for: ${d.for.join(", ")}`);
        for (const a of d.alternatives) console.log(`    rejected: ${a}`);
      }
      return;
    }
    case "extract": {
      const s = ready();
      const x = await extract(s);
      writeFileSync2(s.path("extract.json"), JSON.stringify(x, null, 2));
      printExtract(x);
      console.log(`
Full detail (with code and per-line provenance): .understand/extract.json`);
      return;
    }
    case "check": {
      const s = ready();
      const n = readNarration(s.path("narration.json"));
      if (!n) fail("no .understand/narration.json yet");
      const x = await extract(s);
      const r = check(x, n);
      for (const e of r.errors) console.log(`error: ${e}`);
      if (r.missing.length) console.log(`not narrated or not in a chapter (${r.missing.length}):
  ${r.missing.join("\n  ")}`);
      if (r.errors.length || r.missing.length) process.exit(1);
      console.log(`OK: ${x.symbols.length} symbols narrated across ${n.chapters.length} chapters.`);
      return;
    }
    case "render": {
      const s = ready();
      const x = await extract(s);
      const n = readNarration(s.path("narration.json"));
      if (n) {
        const r = check(x, n);
        if (r.errors.length) fail(`narration is invalid (${r.errors.length} errors); fix them first:
  ${r.errors.join("\n  ")}`);
        if (r.missing.length) process.stderr.write(`warning: ${r.missing.length} symbols aren't narrated; they'll be listed under "Not placed in the story".
`);
      }
      const html = renderHtml(x, n);
      const outFlag = one(flags, "out");
      const out = outFlag ? resolve2(outFlag) : s.path("reports", `understand-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`);
      mkdirSync2(dirname2(out), { recursive: true });
      writeFileSync2(out, html);
      if (!outFlag) copyFileSync2(out, s.path("reports", "latest.html"));
      console.log(out);
      if (flags.open) {
        try {
          execFileSync3(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [out]);
        } catch {
        }
      }
      return;
    }
    case "hook":
      runHook(args[0] ?? "");
      return;
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    default:
      fail(`unknown command "${cmd}". Run \`understand help\`.`);
  }
}
function archive(s) {
  let id = "unknown";
  try {
    id = s.config().id ?? id;
  } catch {
  }
  const dest = s.path("archive", `${id}-${randomBytes2(2).toString("hex")}`);
  mkdirSync2(dest, { recursive: true });
  for (const f of ["decisions.jsonl", "edits.jsonl", "links.jsonl", "ignored.jsonl", "state.json", "narration.json", "config.json"]) {
    if (existsSync4(s.path(f))) renameSync2(s.path(f), join4(dest, f));
  }
}
function printExtract(x) {
  const byFile = /* @__PURE__ */ new Map();
  for (const s of x.symbols) byFile.set(s.file, [...byFile.get(s.file) ?? [], s]);
  console.log(`${x.symbols.length} changed symbols in ${byFile.size} files; ${x.decisions.length} decisions.`);
  for (const [file, syms] of byFile) {
    const f = x.files[file];
    console.log(`
${file} (${f.status}${f.note ? `, ${f.note}` : ""})`);
    for (const s of syms) {
      const plus = s.rows.filter((r) => r.t === "+").length, minus = s.rows.filter((r) => r.t === "-").length;
      const tags = [
        s.decisions.length ? s.decisions.join(",") : "",
        s.gaps.outside ? "OUTSIDE" : "",
        s.gaps.before ? "BEFORE-RECORDING" : "",
        s.gaps.unlinked.length ? "UNEXPLAINED" : ""
      ].filter(Boolean).join(" ");
      console.log(`  ${s.id}
      ${s.status}${s.movedFrom ? ` from ${s.movedFrom}` : ""} ${s.kind} +${plus}/-${minus} [${tags || "?"}]${s.note ? ` (${s.note})` : ""}`);
    }
  }
  if (x.ignoredWrites.length) console.log(`
Written by the agent but ignored by git (not in the diff): ${x.ignoredWrites.join(", ")}`);
}
main().catch((e) => fail(e.message ?? String(e)));
