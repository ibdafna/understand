// src/cli.ts
import { execFileSync as execFileSync4 } from "node:child_process";
import { copyFileSync, mkdirSync as mkdirSync6, rmSync as rmSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as dirname4, join as join8, resolve as resolve3 } from "node:path";

// src/decide.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync3, readFileSync as readFileSync3, renameSync as renameSync3, rmSync as rmSync2 } from "node:fs";
import { dirname, join as join4 } from "node:path";

// src/decisionlog.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
var LOG_DIR = ".decisions";
var COLUMNS = ["id", "recorded", "by", "title", "why", "shaped", "rejected", "risks", "revises", "mechanical"];
function sharing(root) {
  try {
    return execFileSync("git", ["-C", root, "config", "--get", "understand.share"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "false";
  } catch {
    return true;
  }
}
function isLogPath(path) {
  return path === LOG_DIR || path.startsWith(LOG_DIR + "/");
}
var cell = (s) => (s ?? "").replace(/[\t\r\n]+/g, " ").trim();
var list = (xs) => (xs ?? []).map(cell).filter(Boolean).join("; ");
function writeLog(rec) {
  const root = rec.home.root;
  if (!sharing(root)) return null;
  const c = rec.config();
  if (!rec.decisions().length) return null;
  const file2 = join(root, LOG_DIR, c.logFile);
  const named = /* @__PURE__ */ new Map();
  for (const l of rec.linkRecords()) named.set(l.decision, [...named.get(l.decision) ?? [], ...l.for]);
  const rows = rec.decisions().map((d) => [
    d.id,
    d.ts.slice(0, 10),
    d.by === "human" ? "user" : "agent",
    cell(d.title),
    cell(d.why),
    list([...d.for, ...named.get(d.id) ?? []]),
    list(d.alternatives),
    list(d.risks),
    cell(d.supersedes),
    d.mechanical ? "yes" : ""
  ].join("	"));
  mkdirSync(join(root, LOG_DIR), { recursive: true });
  const tmp = `${file2}.${process.pid}.tmp`;
  writeFileSync(tmp, [COLUMNS.join("	"), ...rows].join("\n") + "\n");
  renameSync(tmp, file2);
  return join(LOG_DIR, c.logFile);
}
function readLogs(root) {
  const dir = join(root, LOG_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsv")).sort();
  const out = [];
  files.forEach((f, i) => {
    const [header2, ...lines] = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim());
    const cols = header2.split("	");
    const at = (row2, name) => row2[cols.indexOf(name)] ?? "";
    const split = (s) => s.split(/;\s*/).filter(Boolean);
    const prefix = files.length > 1 ? `${String.fromCharCode(65 + i % 26)}` : "";
    for (const line of lines) {
      const row2 = line.split("	");
      const id = at(row2, "id");
      if (!/^D\d+$/.test(id)) continue;
      out.push({
        id: prefix + id,
        ts: at(row2, "recorded"),
        session: null,
        title: at(row2, "title"),
        why: at(row2, "why"),
        by: at(row2, "by") === "user" ? "human" : "agent",
        alternatives: split(at(row2, "rejected")),
        risks: split(at(row2, "risks")),
        ...at(row2, "revises") ? { supersedes: prefix + at(row2, "revises") } : {},
        ...at(row2, "mechanical") === "yes" ? { mechanical: true } : {},
        for: split(at(row2, "shaped")),
        claimable: []
      });
    }
  });
  return out;
}

// src/git.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { existsSync as existsSync2 } from "node:fs";
import { isAbsolute, join as join2 } from "node:path";
var EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
function git(root, args, env) {
  return execFileSync2("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });
}
function gitInput(root, args, input, env) {
  return execFileSync2("git", ["-C", root, ...args], { input, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
}
function repoRoot(cwd) {
  try {
    return execFileSync2("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}
function commonDir(root) {
  const p = git(root, ["rev-parse", "--git-common-dir"]).trim();
  return isAbsolute(p) ? p : join2(root, p);
}
function currentBranch(root) {
  try {
    const b = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
    return b || null;
  } catch {
    return null;
  }
}
function headCommit(root) {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}
function branchBornSince(root, branch, since) {
  let out = "";
  try {
    out = git(root, ["reflog", "show", "--date=unix", "--format=%gd%x09%gs", `refs/heads/${branch}`]);
  } catch {
    return false;
  }
  const entries = out.trim().split("\n").filter(Boolean).map((l) => {
    const [ref, subject] = l.split("	");
    return { time: Number(/@\{(\d+)\}/.exec(ref)?.[1] ?? 0), subject: subject ?? "" };
  });
  const oldest = entries[entries.length - 1];
  if (oldest && oldest.time >= since && /^branch: Created/.test(oldest.subject)) return true;
  return entries.some((e) => e.time >= since && /^Branch: renamed/i.test(e.subject));
}
function trunkBranch(root) {
  const tryGit = (args) => {
    try {
      return git(root, args).trim();
    } catch {
      return "";
    }
  };
  const exists = (b) => !!b && !!tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
  const set = tryGit(["config", "--get", "understand.trunk"]);
  if (set) return set;
  const remotes = tryGit(["remote"]).split("\n").filter(Boolean).sort((a, b) => a === "origin" ? -1 : b === "origin" ? 1 : 0);
  for (const r of remotes) {
    const head = tryGit(["symbolic-ref", "--quiet", "--short", `refs/remotes/${r}/HEAD`]);
    if (head) return head.slice(r.length + 1);
  }
  const init = tryGit(["config", "--get", "init.defaultBranch"]);
  if (exists(init)) return init;
  for (const b of ["main", "master", "trunk", "develop"]) if (exists(b)) return b;
  const branches = tryGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
  if (branches.length > 12) return null;
  let best = null, most = 0;
  for (const b of branches) {
    const n = branches.filter((o) => o !== b && isAncestor(root, b, o)).length;
    if (n > most) {
      most = n;
      best = b;
    }
  }
  return best;
}
function isAncestor(root, a, b) {
  try {
    execFileSync2("git", ["-C", root, "merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
function writeWorktreeTree(root, env) {
  git(root, ["add", "-A", "--", "."], env);
  const tracked = git(root, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]).split("\0").filter((p) => p && existsSync2(join2(root, p)));
  if (tracked.length) gitInput(root, ["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], tracked.join("\0"), env);
  return git(root, ["write-tree"], env).trim();
}
function treeOf(root, rev, env) {
  return git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], env).trim();
}
function readAt(root, treeish, path, env) {
  try {
    return execFileSync2("git", ["-C", root, "cat-file", "blob", `${treeish}:${path}`], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}
function entryAt(root, tree, path, env) {
  try {
    return git(root, ["ls-tree", "-z", tree, "--", `:(literal)${path}`], env).split("	")[0];
  } catch {
    return "";
  }
}
function changedFiles(root, from, to, env) {
  const out = git(root, ["diff-tree", "-r", "--no-renames", "--raw", "-z", from || EMPTY_TREE, to], env);
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
    execFileSync2("git", ["-C", root, "check-ignore", "-q", "--", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// src/capture.ts
function capture(s, o) {
  s.home.withLock(() => {
    const st = s.state();
    const tree = s.home.snapshot();
    if (tree === st.lastTree) return;
    const files = changedFiles(s.home.root, st.lastTree, tree, s.home.readEnv()).map((c) => c.path).filter((p) => !isLogPath(p));
    const mine = o.only ? files.filter((f) => o.only.includes(f)) : files;
    const others = o.only ? files.filter((f) => !o.only.includes(f)) : [];
    const turn = s.home.turn(o.session);
    const rec = (fs, unverified) => s.addEdit({
      ts: (/* @__PURE__ */ new Date()).toISOString(),
      session: o.session,
      turn,
      tool: unverified && !o.unverified ? "side effect" : o.tool,
      from: st.lastTree,
      to: tree,
      files: fs,
      ...o.command ? { command: o.command.slice(0, 2e3) } : {},
      ...unverified ? { unverified: true } : {},
      ...o.transcript && !unverified ? { transcript: o.transcript, toolUseId: o.toolUseId } : {}
    });
    if (mine.length) rec(mine, !!o.unverified);
    if (others.length) rec(others, true);
    s.writeState({ lastTree: tree });
  });
}

// src/fsutil.ts
import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync2, renameSync as renameSync2, rmSync, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join3 } from "node:path";
var DIR_MODE = 448;
var FILE_MODE = 384;
function withDirLock(dir, fn) {
  mkdirSync2(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE);
  const lock = join3(dir, "lock");
  const owner = join3(lock, "owner");
  const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
  const start = Date.now();
  for (; ; ) {
    const tmp = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}`;
    mkdirSync2(tmp, { mode: DIR_MODE });
    writeFileSync2(join3(tmp, "owner"), token);
    try {
      renameSync2(tmp, lock);
      break;
    } catch (e) {
      rmSync(tmp, { recursive: true, force: true });
      if (e.code !== "EEXIST" && e.code !== "ENOTEMPTY") throw e;
      if (ownerGone(owner)) {
        const stale = `${lock}.stale.${process.pid}.${Date.now()}`;
        try {
          renameSync2(lock, stale);
          if (ownerGone(join3(stale, "owner"))) rmSync(stale, { recursive: true, force: true });
          else renameSync2(stale, lock);
        } catch {
        }
        continue;
      }
      if (Date.now() - start > 6e4) throw new Error(`timed out waiting for ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync2(owner, "utf8") === token) rmSync(lock, { recursive: true, force: true });
    } catch {
    }
  }
}
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
function writeAtomic(file2, text2) {
  const tmp = `${file2}.${process.pid}.tmp`;
  writeFileSync2(tmp, text2, { mode: FILE_MODE });
  renameSync2(tmp, file2);
}
function readJson(file2, dflt) {
  if (!existsSync3(file2)) return dflt;
  return JSON.parse(readFileSync2(file2, "utf8"));
}
function writeJson(file2, value) {
  writeAtomic(file2, JSON.stringify(value, null, 2) + "\n");
}
function readJsonl(file2) {
  if (!existsSync3(file2)) return [];
  const out = [];
  for (const line of readFileSync2(file2, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      process.stderr.write(`warning: skipping a corrupt line in ${file2}
`);
    }
  }
  return out;
}
function appendJsonl(file2, rec) {
  let prefix = "";
  try {
    const cur = readFileSync2(file2, "utf8");
    if (cur && !cur.endsWith("\n")) prefix = "\n";
  } catch {
  }
  appendFileSync(file2, prefix + JSON.stringify(rec) + "\n", { mode: FILE_MODE });
}
var nextNumber = (ids) => ids.reduce((m, id) => Math.max(m, Number(id.slice(1)) || 0), 0) + 1;

// src/decide.ts
function file(h, e, pending) {
  const out = h.withLock(() => {
    const rec = h.recording(e.session);
    const known = (id) => rec.decisions().some((d2) => d2.id === id);
    if (e.kind === "decide" && e.input.supersedes && !known(e.input.supersedes)) throw new Error(`--supersedes ${e.input.supersedes}: no such decision`);
    if (e.kind === "link" && !known(e.decision)) throw new Error(`${e.decision} is not a recorded decision`);
    if (pending === "own") capture(rec, { session: e.session, tool: "Bash", command: `(changes made in the same command as \`understand ${e.kind}\`)` });
    if (pending === "unknown") capture(rec, { session: e.session, tool: "checkpoint", unverified: true });
    const claimable = rec.turnEdits(e.session).map((x) => x.id);
    if (e.kind === "link") {
      rec.addLink({ decision: e.decision, for: e.for, claimable });
      return { rec, id: e.decision };
    }
    const { input: d } = e;
    const rec2 = rec.addDecision({
      ts: e.ts,
      session: e.session,
      title: d.title,
      why: d.why,
      by: d.by,
      alternatives: d.alternatives,
      ...d.risks?.length ? { risks: d.risks } : {},
      for: d.for,
      claimable,
      ...d.supersedes ? { supersedes: d.supersedes } : {},
      ...d.mechanical ? { mechanical: true } : {}
    });
    return { rec, id: rec2.id };
  });
  return { ...out, log: writeLog(out.rec) };
}
var QUEUE = join4(LOG_DIR, ".pending.jsonl");
function enqueue(root, e) {
  const path = join4(root, QUEUE);
  mkdirSync3(dirname(path), { recursive: true });
  appendJsonl(path, e);
  return QUEUE;
}
function drain(h) {
  const path = join4(h.root, QUEUE);
  if (!existsSync4(path)) return [];
  const taken = `${path}.${process.pid}`;
  renameSync3(path, taken);
  const problems = [];
  for (const line of readFileSync3(taken, "utf8").split("\n").filter((l) => l.trim())) {
    try {
      file(h, JSON.parse(line), "captured");
    } catch (err) {
      problems.push(err.message);
    }
  }
  rmSync2(taken, { force: true });
  return problems;
}
function isWriteDenied(err) {
  const code = err?.code;
  return code === "EPERM" || code === "EACCES" || code === "EROFS" || /Operation not permitted|Read-only file system/.test(String(err?.message));
}

// src/explanation.ts
import { existsSync as existsSync5, readFileSync as readFileSync4 } from "node:fs";
function readExplanation(path) {
  if (!existsSync5(path)) return null;
  return JSON.parse(readFileSync4(path, "utf8"));
}
var ATTN = /* @__PURE__ */ new Set(["careful", "skim", "mechanical"]);
function check(x, n) {
  const errors = [];
  const ids = new Set(x.symbols.map((s) => s.id));
  const placed = /* @__PURE__ */ new Map();
  if (!n.title?.trim()) errors.push("title is empty");
  if (!n.intent?.trim()) errors.push("intent is empty");
  (n.chapters ?? []).forEach((c, i) => {
    if (!c.title?.trim()) errors.push(`chapter ${i + 1} has no title`);
    if (!Array.isArray(c.symbols)) {
      errors.push(`chapter ${i + 1}: symbols must be a list`);
      return;
    }
    for (const id of c.symbols) {
      if (!ids.has(id)) errors.push(`chapter ${i + 1} lists unknown symbol ${id}`);
      else if (placed.has(id)) errors.push(`${id} is in chapters ${placed.get(id) + 1} and ${i + 1}`);
      else placed.set(id, i);
    }
  });
  for (const [id, note] of Object.entries(n.symbols ?? {})) {
    if (!ids.has(id)) {
      errors.push(`entry for unknown symbol ${id}`);
      continue;
    }
    if (!ATTN.has(note.attention)) errors.push(`${id}: attention must be careful, skim or mechanical`);
    else if (note.attention !== "skim" && !note.attentionReason?.trim()) errors.push(`${id}: say why it is ${note.attention} (attentionReason)`);
  }
  const missing = x.symbols.filter((s) => !n.symbols?.[s.id]?.summary?.trim() || n.chapters?.length && !placed.has(s.id)).map((s) => s.id);
  return { errors, missing };
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

// src/store.ts
import { join as join5 } from "node:path";
var Store = class {
  constructor(home2, id) {
    this.home = home2;
    this.id = id;
    this.dir = home2.path("recordings", id);
  }
  home;
  id;
  dir;
  path(...parts) {
    return join5(this.dir, ...parts);
  }
  config() {
    return readJson(this.path("config.json"), null);
  }
  writeConfig(c) {
    writeJson(this.path("config.json"), c);
  }
  state() {
    return readJson(this.path("state.json"), null);
  }
  writeState(s) {
    writeJson(this.path("state.json"), s);
  }
  decisions() {
    return readJsonl(this.path("decision_log.jsonl")).filter((d) => /^D\d+$/.test(d.id));
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
    return this.home.withLock(() => {
      const rec = { id: `D${nextNumber(this.decisions().map((x) => x.id))}`, ...d };
      appendJsonl(this.path("decision_log.jsonl"), rec);
      return rec;
    });
  }
  addEdit(e) {
    return this.home.withLock(() => {
      const rec = { id: `E${nextNumber(this.edits().map((x) => x.id))}`, ...e };
      appendJsonl(this.path("edits.jsonl"), rec);
      return rec;
    });
  }
  addLink(l) {
    this.home.withLock(() => appendJsonl(this.path("links.jsonl"), l));
  }
  addIgnoredWrite(file2) {
    this.home.withLock(() => appendJsonl(this.path("ignored.jsonl"), { file: file2 }));
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
    const turn = this.home.turn(session);
    return this.edits().filter((e) => !e.unverified && e.session === session && e.turn === turn);
  }
};

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
function compress(rows, context2 = CONTEXT) {
  if (rows.length <= FULL_UNDER) return rows;
  const keep = rows.map(() => false);
  rows.forEach((r, i) => {
    if (r.t === " " || r.t === "gap") return;
    for (let j = Math.max(0, i - context2); j <= Math.min(rows.length - 1, i + context2); j++) keep[j] = true;
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
        oList.splice(i2, 1);
        nList.splice(nList.indexOf(n), 1);
      }
    }
    while (oList.length && nList.length) {
      const a = oList.shift(), b = nList.shift();
      const ownO = new Set(a.own), ownN = new Set(b.own);
      const raw = rows.filter((r) => r.t === "-" && ownO.has(r.o) || r.t === "+" && ownN.has(r.n) || r.t === " " && (ownO.has(r.o) || ownN.has(r.n)));
      const note = a.iota != null && b.iota != null && a.iota !== b.iota ? `implicit iota value moved from position ${a.iota} to ${b.iota}` : void 0;
      claim({ ...meta(b), status: "modified", raw, body: b.cmp, ...note ? { note } : {} });
    }
    for (const b of nList) {
      status.set(b.key, "added");
      claim({ ...meta(b), status: "added", raw: b.own.map((n) => byNew.get(n)).filter((x) => !!x && x.t !== "-"), body: b.cmp });
    }
    for (const a of oList) {
      status.set(a.key, "removed");
      claim({ ...meta(a), status: "removed", raw: a.own.map((o) => byOld.get(o)).filter((x) => !!x && x.t !== "+"), body: a.cmp });
    }
  }
  const attach = (r, to) => {
    to.raw.push(r);
    to.raw.sort((x, y) => at.get(x) - at.get(y));
    owner.set(r, to);
  };
  for (const [groups, want, line, t] of [[newSyms?.groups, "added", byNew, "+"], [oldSyms?.groups, "removed", byOld, "-"]]) {
    for (const g of groups ?? []) {
      if (!g.members.length || !g.members.every((k) => status.get(k) === want)) continue;
      const first = pending.find((p) => p.key === g.members[0] && p.status === want);
      const last = pending.find((p) => p.key === g.members[g.members.length - 1] && p.status === want);
      if (!first || !last) continue;
      const start = at.get(first.raw[0]) ?? 0;
      for (const l of g.lines) {
        const r = line.get(l);
        if (r?.t === t && !owner.has(r)) attach(r, at.get(r) < start ? first : last);
      }
    }
  }
  const changedLoose = (i2) => rows[i2] && rows[i2].t !== " " && !owner.has(rows[i2]);
  for (let pass = 0; pass < 2; pass++) {
    const order = pass === 0 ? rows.map((_, i2) => i2) : rows.map((_, i2) => rows.length - 1 - i2);
    for (const i2 of order) {
      if (!changedLoose(i2) || rows[i2].s.trim() !== "") continue;
      const nb = owner.get(rows[pass === 0 ? i2 - 1 : i2 + 1]);
      if (nb) attach(rows[i2], nb);
    }
  }
  const out = pending.map(({ raw, ...c }) => ({ ...c, rows: c.status === "modified" ? compress(withGaps(raw)) : withGaps(raw) }));
  const loose = rows.map((r) => r.t !== " " && !owner.has(r));
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
import { readdirSync as readdirSync2, readFileSync as readFileSync5 } from "node:fs";
import { createRequire } from "node:module";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
var langDir = fileURLToPath(new URL("./languages/", import.meta.url));
var defs = null;
function languages() {
  if (!defs) {
    defs = /* @__PURE__ */ new Map();
    for (const id of readdirSync2(langDir)) {
      const def = { id, ...JSON.parse(readFileSync5(`${langDir}${id}/lang.json`, "utf8")) };
      for (const ext of def.extensions) defs.set(ext, def);
    }
  }
  return defs;
}
function langOf(path) {
  return languages().get(path.split(".").pop().toLowerCase())?.id ?? null;
}
function hlLang(path) {
  return langOf(path) ?? "plain";
}
var wasmDir = fileURLToPath(new URL("./wasm/", import.meta.url));
var runtime;
var loaded = /* @__PURE__ */ new Map();
async function load(lang) {
  if (!runtime) {
    runtime = createRequire(import.meta.url)(wasmDir + "tree-sitter.cjs");
    await runtime.Parser.init({ locateFile: (f) => wasmDir + f });
  }
  if (!loaded.has(lang)) {
    const def = [...languages().values()].find((d) => d.id === lang);
    const language = await runtime.Language.load(wasmDir + basename(def.grammar));
    const parser = new runtime.Parser();
    parser.setLanguage(language);
    const query = new runtime.Query(language, readFileSync5(`${langDir}${def.outline ?? def.id}/outline.scm`, "utf8"));
    loaded.set(lang, { parser, query, def });
  }
  return loaded.get(lang);
}
async function symbolsOf(lang, src) {
  const { parser, query, def } = await load(lang);
  const tree = parser.parse(src);
  const root = tree.rootNode;
  const b = new Builder(src, def.leading ?? []);
  const wrappers = new Set(def.wrappers ?? []);
  const byNode = /* @__PURE__ */ new Map();
  for (const m of query.matches(root)) {
    const cap = {};
    for (const c of m.captures) (cap[c.name] ??= []).push(c.node);
    let node = cap.item?.[0];
    if (!node) continue;
    while (node.parent && wrappers.has(node.parent.type)) node = node.parent;
    const prev = byNode.get(node.id);
    const names = [...prev?.cap.name ?? [], ...cap.name ?? []];
    if (!prev || m.patternIndex < prev.pattern) byNode.set(node.id, { node, pattern: m.patternIndex, cap, props: { ...m.setProperties ?? {} }, parent: null, kids: [], ok: false, qn: "" });
    const it = byNode.get(node.id);
    if (names.length) it.cap.name = [...new Map(names.map((n) => [n.id, n])).values()].sort((x, y) => x.startIndex - y.startIndex);
  }
  const items = [...byNode.values()].sort((x, y) => x.node.startIndex - y.node.startIndex || y.node.endIndex - x.node.endIndex);
  const stack = [];
  const top = [];
  for (const it of items) {
    while (stack.length && !(stack.at(-1).node.startIndex <= it.node.startIndex && it.node.endIndex <= stack.at(-1).node.endIndex)) stack.pop();
    const parent = stack.at(-1) ?? null;
    const home2 = (it.cap.group?.[0] ?? it.node).parent?.id;
    it.ok = parent ? parent.ok && !!parent.props.container && home2 === (parent.cap.body?.[0] ?? parent.node).id : home2 === root.id;
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
var text = (n) => flat(unquote(n.text));
function nameOf(it) {
  if (it.props.name === "text") {
    const t = flat(it.node.text).replace(/;$/, "");
    return t.length > 60 ? t.slice(0, 57) + "\u2026" : t;
  }
  const names = (it.cap.name ?? []).map(text).join(", ");
  const own = names || (it.cap.key ? text(it.cap.key[0]) : "?");
  return it.cap["name.prefix"] ? `${text(it.cap["name.prefix"][0])} ${own}` : own;
}
function keyOf(it) {
  const own = it.props.key ?? (it.cap.key ? text(it.cap.key[0]).replace(it.props.name === "text" ? /;$/ : /$^/, "") : (it.cap.name ?? []).map(text).join(", ") || nameOf(it));
  const prefix = (it.props["key.prefix"] ?? "") + (it.cap["key.prefix"] ? text(it.cap["key.prefix"][0]) + " " : "");
  const scope = it.cap.scope ? text(it.cap.scope[0]) : it.props.qualify === "no" ? "" : it.parent?.qn;
  return (scope ? scope + "." : "") + prefix + own;
}
function sigOf(it, node = it.node) {
  const body = it.cap.body?.[0] ?? null;
  const sig = it.props.sig === "full" ? it.props.name === "text" ? flat(node.text).replace(/;$/, "") : node.text : header(node, body);
  return it.props["sig.prefix"] ? `${it.props["sig.prefix"]} ${sig}` : sig;
}
var kindOf = (it) => it.parent && it.props["kind.member"] || (it.cap.kind ? it.cap.kind[0].text : it.props.kind ?? "var");
function emit(list2, b) {
  const from = /* @__PURE__ */ new Map();
  const folded = /* @__PURE__ */ new Set();
  for (let i = 0; i < list2.length; i++) {
    if (!list2[i].props.fold) continue;
    let j = i;
    while (j < list2.length && list2[j].props.fold) j++;
    const impl = list2[j];
    if (impl && nameOf(impl) === nameOf(list2[i]) && kindOf(impl) === kindOf(list2[i])) {
      for (let k = i; k < j; k++) folded.add(list2[k]);
      from.set(impl, Math.min(from.get(impl) ?? Infinity, b.leadStart(list2[i].node)));
    }
    i = j - 1;
  }
  for (let i = 0; i < list2.length; i++) {
    const it = list2[i];
    if (folded.has(it)) continue;
    const group = it.cap.group?.[0];
    if (group) {
      let j = i;
      while (j < list2.length && list2[j].cap.group?.[0].id === group.id) j++;
      const members = list2.slice(i, j);
      i = j - 1;
      if (it.props.collapse === "single" && members.length === 1) {
        b.add({ kind: kindOf(it), key: keyOf(it), name: it.qn, sig: sigOf(it), from: b.leadStart(group), outer: group });
        continue;
      }
      const ordinal = it.props.ordinal && members.some((m) => m.cap.value && new RegExp(`\\b${it.props.ordinal}\\b`).test(m.cap.value[0].text));
      const syms = members.map((m, k) => {
        const sym = b.add({ kind: kindOf(m), key: keyOf(m), name: m.qn, sig: sigOf(m), from: b.leadStart(m.node), outer: m.node, ...ordinal ? { iota: k } : {} });
        if (ordinal && !m.cap.value) sym.cmp += `\0iota@${k}`;
        return sym;
      });
      b.group(b.leadStart(group), endRow(group), syms);
      continue;
    }
    b.add({ kind: kindOf(it), key: keyOf(it), name: it.qn, sig: sigOf(it), from: from.get(it) ?? b.leadStart(it.node), outer: it.node, members: it.kids.map((k) => k.node) });
    emit(it.kids, b);
  }
}
var Builder = class {
  constructor(src, leading) {
    this.leading = leading;
    this.lines = src.split("\n");
  }
  leading;
  syms = [];
  groups = [];
  lines;
  seen = /* @__PURE__ */ new Map();
  /** Where a declaration starts once the doc comments (and attributes) directly above it are included. */
  leadStart(n) {
    let start = row(n);
    let p = n.previousNamedSibling;
    while (p && (/comment/.test(p.type) || this.leading.includes(p.type)) && endRow(p) === start - 1) {
      start = row(p);
      p = p.previousNamedSibling;
    }
    return start;
  }
  add(o) {
    let key = `${o.kind === "import" ? "import" : o.kind === "export" ? "export" : kindKey(o.kind)}:${o.key}`;
    const n = (this.seen.get(key) ?? 0) + 1;
    this.seen.set(key, n);
    if (n > 1) key += `#${n}`;
    const outer = o.outer;
    const to = endRow(outer);
    const excl = (o.members ?? []).map((m) => [this.leadStart(m), endRow(m)]);
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
function header(n, body) {
  if (!body) return n.text.split("\n")[0];
  const i = n.text.lastIndexOf(body.text);
  return i > 0 ? n.text.slice(0, i) : n.text.split("\n")[0];
}
var unquote = (s) => s.replace(/^["'`]|["'`]$/g, "");
var flat = (s) => s.replace(/\s+/g, " ").trim();

// src/extract/index.ts
function rangeKey(r) {
  const slug = (x) => x.replace(/[^\w.-]+/g, "-");
  return r.kind === "pr" ? `pr-${slug(r.ref)}` : r.kind === "commits" ? `commits-${slug(r.spec)}` : r.kind;
}
var LFS = /^version https:\/\/git-lfs\.github\.com\/spec\/v1\n/;
var isBinary = (s) => s != null && s.slice(0, 8e3).includes("\0");
async function extract(src, range = { kind: "recording" }) {
  const store = src instanceof Store ? src : null;
  const home2 = store ? store.home : src;
  const env = home2.readEnv();
  const { cfg, live, edits, decisions, claims, ignored } = home2.withLock(() => {
    if (!store) {
      const decisions2 = readLogs(home2.root);
      const claims2 = decisions2.flatMap((d) => d.for.map((spec) => ({ decision: d.id, spec, edits: /* @__PURE__ */ new Set() })));
      return { cfg: null, live: home2.snapshot(), edits: [], decisions: decisions2, claims: claims2, ignored: [] };
    }
    const cfg2 = store.config();
    const live2 = home2.scope(cfg2.session) === cfg2.scope ? home2.snapshot() : store.state().lastTree;
    return { cfg: cfg2, live: live2, edits: store.edits(), decisions: store.decisions(), claims: store.claims(), ignored: store.ignoredWrites() };
  });
  if (!cfg && range.kind === "recording") throw new Error("no local recording here: pick a range (--pr, --branch, --staged, --uncommitted, --commits)");
  const byName = !cfg;
  const start = cfg?.baseTree ?? "";
  const { baseTree, tree, baseLabel, headLabel } = resolveRange(home2.root, range, start, live, env);
  const warnings = [];
  const reader = cachedReader(home2.root, env);
  const files = {};
  const changes = [];
  for (const ch of changedFiles(home2.root, baseTree, tree, env)) {
    if (isLogPath(ch.path)) continue;
    const status = ch.status === "A" ? "added" : ch.status === "D" ? "deleted" : "modified";
    files[ch.path] = { lang: hlLang(ch.path), status };
    const fileLevel = (name, rows2, note, part = "entry") => {
      files[ch.path].note = note;
      changes.push({ key: `file:${name}`, kind: "file", name, sig: "", status: status === "deleted" ? "removed" : status, rows: rows2, body: "", file: ch.path, extra: byName ? /* @__PURE__ */ new Set() : fileLabels(home2.root, env, baseTree, start, tree, edits, ch.path, part) });
    };
    if (ch.oldMode === "160000" || ch.newMode === "160000") {
      fileLevel("(submodule)", modeRows(ch, (sha) => `Subproject commit ${sha}`), "submodule pointer");
      continue;
    }
    const oldText = ch.status === "A" ? null : reader(baseTree, ch.path);
    const newText = ch.status === "D" ? null : reader(tree, ch.path);
    if (ch.status === "M" && ch.oldMode !== ch.newMode) fileLevel("(file mode)", [{ t: "-", s: `mode ${ch.oldMode}` }, { t: "+", s: `mode ${ch.newMode}` }], `mode ${ch.oldMode} \u2192 ${ch.newMode}`, "mode");
    if (isBinary(oldText) || isBinary(newText)) {
      fileLevel("(binary file)", [], "binary", "blob");
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
    const prov = byName ? null : track(baseTree, start, edits, ch.path, oldText, newText, reader);
    if (prov) for (const r of rows) {
      if (r.t === "+") {
        const a = prov.added(r.n, r.s);
        r.p = a.label;
        if (a.at) r.pa = a.at;
      } else if (r.t === "-") r.p = prov.removed(r.o);
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
  const namesThen = byName ? null : await namesAtTime(changes, byId, reader);
  const shortCount = /* @__PURE__ */ new Map();
  for (const c of changes) {
    const k = `${c.file}:${c.name.split(".").pop()}`;
    shortCount.set(k, (shortCount.get(k) ?? 0) + 1);
  }
  const unique = (c) => (short) => (shortCount.get(`${c.file}:${short}`) ?? 0) <= 1;
  const symbols = changes.map((c) => ({
    id: `${c.file}#${c.key}`,
    file: c.file,
    kind: c.kind,
    name: c.name,
    sig: c.sig,
    status: c.status,
    ...c.movedFrom ? { movedFrom: c.movedFrom } : {},
    ...c.note ? { note: c.note } : {},
    rows: c.rows,
    ...byName ? attributeByName(c, claims, unique(c)) : attribute(c, byId, claims, unique(c), namesThen)
  }));
  const stamps = [...edits.map((e) => e.ts), ...decisions.map((d) => d.ts)].sort();
  return {
    baseLabel,
    headLabel,
    branch: currentBranch(home2.root) ?? "(detached)",
    startedOn: cfg ? cfg.branch ?? "(detached)" : "(from the checked-in decision log)",
    byName,
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
function resolveRange(root, r, start, live, env) {
  const rev = (x) => git(root, ["rev-parse", "--verify", x]).trim();
  const tree = (commit) => treeOf(root, commit, env);
  const short = (c) => c.slice(0, 8);
  const mergeBase = (ref, head) => git(root, ["merge-base", ref, head]).trim();
  switch (r.kind) {
    case "recording":
      return { baseTree: start, tree: live, baseLabel: "where recording started", headLabel: "the working tree" };
    case "pr": {
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
function cachedReader(root, env) {
  const cache = /* @__PURE__ */ new Map();
  return (tree, path) => {
    const k = `${tree}:${path}`;
    if (!cache.has(k)) cache.set(k, readAt(root, tree, path, env));
    return cache.get(k);
  };
}
function modeRows(ch, fmt) {
  const rows = [];
  if (ch.status !== "A") rows.push({ t: "-", s: fmt(ch.oldSha) });
  if (ch.status !== "D") rows.push({ t: "+", s: fmt(ch.newSha) });
  return rows;
}
function splitLines(text2) {
  const lines = text2.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function track(baseTree, startTree, edits, path, baseText, finalText, read) {
  let text2 = baseText ?? "";
  const baseLines = splitLines(text2);
  let lines = baseLines.map((_, i) => ({ base: i + 1 }));
  const removedBy = /* @__PURE__ */ new Map();
  const step = (next, label) => {
    const nt = next ?? "";
    if (nt === text2) return;
    const cur = splitLines(text2);
    const parts = diffLines(text2, nt).map((p) => ({ ...p, lines: splitLines(p.value) }));
    const pool = /* @__PURE__ */ new Map();
    let i = 0;
    for (const p of parts) {
      if (p.added) continue;
      for (let k = 0; k < p.lines.length; k++, i++) {
        const b = lines[i]?.base;
        if (p.removed && b != null) pool.set(cur[i], [...pool.get(cur[i]) ?? [], b]);
      }
    }
    const present = new Set(lines.map((o) => o.base).filter((b) => b != null));
    const gone = /* @__PURE__ */ new Map();
    for (const b of removedBy.keys()) if (!present.has(b)) gone.set(baseLines[b - 1], [...gone.get(baseLines[b - 1]) ?? [], b]);
    const carried = /* @__PURE__ */ new Set();
    const out = [];
    i = 0;
    for (const p of parts) {
      if (p.added) {
        for (const t of p.lines) {
          let b = pool.get(t)?.shift();
          if (b != null) carried.add(b);
          else if ((b = gone.get(t)?.shift()) != null) removedBy.delete(b);
          out.push(b != null ? { label, base: b, at: out.length + 1 } : { label, at: out.length + 1 });
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
    text2 = nt;
  };
  if (baseTree !== startTree) step(read(startTree, path), "before");
  for (const e of edits) {
    if (!e.files.includes(path)) continue;
    step(read(e.from, path), "outside");
    step(read(e.to, path), e.unverified ? "outside" : e.id);
  }
  step(finalText, "outside");
  const finalLines = splitLines(text2);
  return {
    added(n, s) {
      const o = lines[n - 1];
      if (o?.label) return { label: o.label, at: o.at };
      const k = finalLines.findIndex((x, j) => x === s && lines[j]?.label);
      return k >= 0 ? { label: lines[k].label, at: lines[k].at } : { label: "outside" };
    },
    removed(o) {
      const by = removedBy.get(o);
      if (by) return by;
      const moved = lines.find((x) => x.base === o && x.label);
      return moved?.label ?? "outside";
    }
  };
}
function fileLabels(root, env, baseTree, startTree, finalTree, edits, path, part) {
  const sha = (tree) => {
    const [mode, , oid] = entryAt(root, tree, path, env).split(" ");
    return part === "mode" ? mode : part === "blob" ? oid : `${mode} ${oid}`;
  };
  let last = "outside";
  let cur = sha(baseTree);
  const step = (tree, label) => {
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
  return /* @__PURE__ */ new Set([last]);
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
function claimKind(spec, c, names, unique) {
  const clean = spec.trim().replace(/^\.\//, "");
  for (const file2 of [c.file, c.movedFrom].filter((f) => !!f)) {
    if (clean === file2) return "file";
    if (!clean.startsWith(file2 + ":")) continue;
    const symbol = clean.slice(file2.length + 1);
    for (const name of names) {
      const short = name.split(".").pop();
      if (symbol === name || symbol === short && unique(short)) return "symbol";
    }
  }
  return null;
}
async function namesAtTime(changes, byId, read) {
  const out = /* @__PURE__ */ new Map();
  for (const c of changes) {
    const lang = langOf(c.file);
    if (!lang) continue;
    for (const r of c.rows) {
      if (r.t !== "+" || !r.p || !r.pa || !byId.has(r.p)) continue;
      const key = `${r.p}:${c.file}`;
      if (out.has(key)) continue;
      const text2 = read(byId.get(r.p).to, c.file);
      const byLine = /* @__PURE__ */ new Map();
      if (text2 != null) {
        try {
          for (const sym of (await symbolsOf(lang, text2)).syms) for (const l of sym.own) byLine.set(l, [...byLine.get(l) ?? [], sym.name]);
        } catch {
        }
      }
      out.set(key, byLine);
    }
  }
  return out;
}
function attributeByName(c, claims, unique) {
  const names = /* @__PURE__ */ new Set([c.name]);
  const hits = claims.map((cl) => ({ cl, kind: claimKind(cl.spec, c, names, unique) })).filter((x) => x.kind);
  const bySym = hits.filter((x) => x.kind === "symbol");
  const decisions = [...new Set((bySym.length ? bySym : hits).map((x) => x.cl.decision))];
  return { edits: [], decisions, later: [], gaps: { outside: false, before: false, unlinked: [] }, explained: decisions.length > 0 };
}
function attribute(c, byId, claims, unique, namesThen) {
  const changed = c.rows.filter((r) => (r.t === "+" || r.t === "-") && r.p);
  const meaningful = changed.some((r) => r.s.trim()) ? changed.filter((r) => r.s.trim()) : changed;
  const labels = new Set(c.extra);
  for (const r of meaningful) labels.add(r.p);
  const editIds = [...labels].filter((l) => byId.has(l));
  const decisions = /* @__PURE__ */ new Set();
  const unlinked = [];
  for (const id of editIds) {
    const names = /* @__PURE__ */ new Set([c.name]);
    for (const r of meaningful) if (r.p === id && r.pa) for (const n of namesThen.get(`${id}:${c.file}`)?.get(r.pa) ?? []) names.add(n);
    const mine = claims.map((cl) => ({ cl, kind: cl.edits.has(id) ? claimKind(cl.spec, c, names, unique) : null })).filter((x) => x.kind);
    const bySym = mine.filter((x) => x.kind === "symbol");
    const chosen = bySym.length ? bySym : mine;
    if (!chosen.length) unlinked.push(id);
    chosen.forEach(({ cl }) => decisions.add(cl.decision));
  }
  const named = claims.filter((cl) => claimKind(cl.spec, c, /* @__PURE__ */ new Set([c.name]), unique));
  const later = [...new Set(named.map((cl) => cl.decision))].filter((d) => !decisions.has(d));
  const gaps = { outside: labels.has("outside"), before: labels.has("before"), unlinked };
  return { edits: editIds, decisions: [...decisions], later, gaps, explained: editIds.length > 0 && !gaps.outside && !gaps.before && unlinked.length === 0 };
}

// src/home.ts
import { createHash, randomBytes as randomBytes2 } from "node:crypto";
import { existsSync as existsSync6, mkdirSync as mkdirSync4, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename as basename2, dirname as dirname2, isAbsolute as isAbsolute2, join as join6, relative, resolve, sep } from "node:path";
function realish(p) {
  try {
    return realpathSync(p);
  } catch {
    return dirname2(p) === p ? p : join6(realish(dirname2(p)), basename2(p));
  }
}
function understandHome() {
  return process.env.UNDERSTAND_HOME || join6(homedir(), ".claude", "understand");
}
var Home = class _Home {
  constructor(root, dir, repoObjects) {
    this.root = root;
    this.dir = dir;
    this.repoObjects = repoObjects;
  }
  root;
  dir;
  repoObjects;
  depth = 0;
  static forRepo(root) {
    const common = realpathSync(commonDir(root));
    const main2 = basename2(common) === ".git" ? basename2(dirname2(common)) : basename2(common).replace(/\.git$/, "");
    const name = main2.replace(/[^\w.-]/g, "_") + "-" + createHash("sha1").update(common).digest("hex").slice(0, 10);
    const home2 = realish(resolve(understandHome()));
    for (const inside of [realpathSync(root), common]) {
      const rel = relative(inside, home2);
      if (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute2(rel)) throw new Error(`UNDERSTAND_HOME (${home2}) is inside the repository; it must live outside it`);
    }
    return new _Home(root, join6(home2, "repos", name), join6(common, "objects"));
  }
  path(...parts) {
    return join6(this.dir, ...parts);
  }
  /** Off for this repo (`understand off`), or everywhere (`understand off --everywhere`, UNDERSTAND_DISABLE=1). */
  isOff() {
    return !!process.env.UNDERSTAND_DISABLE || existsSync6(join6(understandHome(), "off")) || existsSync6(this.path("off"));
  }
  /** Serialize every read-modify-write across hooks and CLI calls (reentrant within a process). */
  withLock(fn) {
    if (this.depth > 0) {
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }
    return withDirLock(this.dir, () => {
      this.depth = 1;
      try {
        return fn();
      } finally {
        this.depth = 0;
      }
    });
  }
  state() {
    return readJson(this.path("state.json"), { turns: {}, pre: {} });
  }
  update(fn) {
    this.withLock(() => {
      const s = this.state();
      fn(s);
      writeJson(this.path("state.json"), s);
    });
  }
  turn(session) {
    return session && this.state().turns[session] || 0;
  }
  /**
   * Snapshots are written only to our own object store, so they never depend on the repo's objects
   * surviving a `git gc`. Reads may also see the repo's objects (for merge-base comparisons).
   */
  writeEnv() {
    const wt = createHash("sha1").update(realpathSync(this.root)).digest("hex").slice(0, 10);
    mkdirSync4(this.path("objects"), { recursive: true, mode: DIR_MODE });
    return { GIT_INDEX_FILE: this.path(`index-${wt}`), GIT_OBJECT_DIRECTORY: this.path("objects") };
  }
  readEnv() {
    return { ...this.writeEnv(), GIT_ALTERNATE_OBJECT_DIRECTORIES: this.repoObjects };
  }
  snapshot() {
    return this.withLock(() => writeWorktreeTree(this.root, this.writeEnv()));
  }
  /**
   * A feature branch is one recording across sessions; trunk gets one per session; a detached HEAD
   * one per session and commit (checking out another commit is not an edit).
   */
  scope(session) {
    const branch = currentBranch(this.root);
    if (branch && branch !== trunkBranch(this.root)) return `branch:${branch}`;
    return `session:${session ?? "none"}:${branch ?? `detached@${headCommit(this.root)?.slice(0, 12)}`}`;
  }
  /** Tree of the committed HEAD, written into the private store (reads it via the repo's objects). */
  headTree() {
    const head = headCommit(this.root);
    if (!head) return null;
    return git(this.root, ["rev-parse", `${head}^{tree}`], this.readEnv()).trim();
  }
  index() {
    return readJson(this.path("recordings.json"), {});
  }
  active(session) {
    const id = this.index()[this.scope(session)];
    return id ? new Store(this, id) : null;
  }
  /** The current scope's recording, started now if there is none (from `baseTree`, or the current worktree). */
  recording(session, baseTree) {
    return this.withLock(() => {
      const existing = this.active(session);
      if (existing) return existing;
      const scope = this.scope(session);
      const id = (/* @__PURE__ */ new Date()).toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + randomBytes2(3).toString("hex");
      const tree = baseTree ?? this.snapshot();
      const store = new Store(this, id);
      mkdirSync4(store.dir, { recursive: true });
      const branch = currentBranch(this.root);
      const slug = (branch ?? "session").replace(/[^\w.-]+/g, "-");
      store.writeConfig({ scope, branch, session, baseTree: tree, createdAt: (/* @__PURE__ */ new Date()).toISOString(), logFile: `${id.slice(0, 8)}-${slug}-${id.slice(-6)}.tsv` });
      store.writeState({ lastTree: tree });
      writeJson(this.path("recordings.json"), { ...this.index(), [scope]: id });
      return store;
    });
  }
  /**
   * The work moved to another scope without changing (`git switch -c`, `git branch -m`):
   * the recording follows it, so its decisions stay with the code they explain.
   */
  carry(from, to) {
    return this.withLock(() => {
      const idx = this.index();
      if (!idx[from] || idx[to]) return false;
      idx[to] = idx[from];
      delete idx[from];
      writeJson(this.path("recordings.json"), idx);
      const store = new Store(this, idx[to]);
      store.writeConfig({ ...store.config(), scope: to, branch: currentBranch(this.root) });
      return true;
    });
  }
  /** End the current scope's recording; the next tool call starts a new one. */
  reset(session) {
    return this.withLock(() => {
      const idx = this.index();
      const scope = this.scope(session);
      if (!idx[scope]) return false;
      delete idx[scope];
      writeJson(this.path("recordings.json"), idx);
      return true;
    });
  }
};

// src/hook.ts
import { execFileSync as execFileSync3 } from "node:child_process";
import { appendFileSync as appendFileSync2, mkdirSync as mkdirSync5, readFileSync as readFileSync6, realpathSync as realpathSync2 } from "node:fs";
import { basename as basename3, dirname as dirname3, isAbsolute as isAbsolute3, join as join7, relative as relative2, resolve as resolve2, sep as sep2 } from "node:path";
var FILE_TOOLS = /* @__PURE__ */ new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);
function toolFiles(root, tool, input) {
  if (tool === "apply_patch") {
    const patch = String(input.command ?? input.patch ?? input.input ?? "");
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] ?? m[2]).trim());
    return paths.map((p) => relFile(root, p)).filter((p) => !!p);
  }
  const file2 = relFile(root, input.file_path ?? input.notebook_path);
  return file2 ? [file2] : [];
}
var PR_CREATE = /\bgh\b[^\n;&|]*\bpr\s+create\b/;
var COMMIT = /\bgit\b[^\n;&|]*\bcommit\b/;
var TRIVIAL_LINES = 3;
var RULES = `Understand keeps a decision log of this session for code review.
After the edits for each design choice (yours, or one the user made), run:
  understand decide --by agent|human --title "<the choice>" --why "<the reason, paraphrased>" \\
    --for <file>:<Symbol>   (repeat for every function, method, type, and import it shaped; a bare <file> covers the whole file)
    [--alt "<rejected option>: <why not>"] [--risk "<assumption or risk>"]
A decision explains only what it names. Record it right after its edits; one decision per distinct choice.
Mechanical batches: \`understand decide --mechanical --title \u2026 --for \u2026\`. Edits that follow a decision you recorded
earlier: \`understand link D<n> --for \u2026\`. Paraphrase; never quote the user. Decisions are also written to .decisions/ in
the repo and committed with your commits, so keep them free of secrets. The understand:record skill has details.
After opening a pull request, use the understand:explain skill to produce its review page.
If the user doesn't want this in a repo, \`understand off\` stops it there (\`--everywhere\` for all repos).`;
async function runHook(event) {
  let home2 = null;
  try {
    const p = JSON.parse(readFileSync6(0, "utf8") || "{}");
    const root = repoRoot(p.cwd || process.cwd());
    if (!root) return;
    home2 = Home.forRepo(root);
    if (home2.isOff()) return;
    if (process.env.UNDERSTAND_DEBUG) log("hook-payloads.jsonl", JSON.stringify({ event, ...p }));
    const out = await handlers[event]?.(home2, p);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    if (home2) log("hook-errors.log", `${(/* @__PURE__ */ new Date()).toISOString()} ${event} ${err.stack}`);
    process.stderr.write(`understand: recording failed during ${event}: ${err.message}
`);
    if (event === "stop") process.stdout.write(JSON.stringify({ systemMessage: `Understand could not check this turn: ${err.message}` }));
  }
}
function log(file2, line) {
  try {
    mkdirSync5(understandHome(), { recursive: true, mode: 448 });
    appendFileSync2(join7(understandHome(), file2), line + "\n");
  } catch {
  }
}
var context = (hookEventName, additionalContext) => ({ hookSpecificOutput: { hookEventName, additionalContext } });
var handlers = {
  "session-start"(home2, p) {
    const session = p.session_id ?? null;
    drain(home2);
    home2.update((st) => {
      if (session) st.lastHookSession = session;
    });
    const rec = home2.active(session);
    if (rec) capture(rec, { session, tool: "checkpoint", unverified: true });
    const recent = rec?.decisions().slice(-15).map((d) => `  ${d.id} [${d.by}] ${d.title}`).join("\n");
    return context("SessionStart", RULES + cliNote() + (recent ? `
Decisions already recorded here:
${recent}` : ""));
  },
  "pre-tool-use"(home2, p) {
    const session = p.session_id ?? null;
    drain(home2);
    home2.update((st) => {
      if (!session) return;
      st.lastHookSession = session;
      st.pre[session] = { scope: home2.scope(session), since: Math.floor(Date.now() / 1e3) };
    });
    const rec = home2.recording(session);
    capture(rec, { session, tool: "checkpoint", unverified: true });
    if (p.tool_name === "Bash" && COMMIT.test(String(p.tool_input?.command ?? ""))) stageLog(home2.root, writeLog(rec));
  },
  /** Also runs for failed tool calls (PostToolUseFailure): a command that errors after writing files still wrote them. */
  "post-tool-use"(home2, p) {
    const session = p.session_id ?? null;
    const tool = p.tool_name ?? "";
    const input = p.tool_input ?? {};
    const command = tool === "Bash" ? String(input.command ?? "") : "";
    const pre = session ? home2.state().pre[session] : void 0;
    home2.update((st) => {
      if (session) delete st.pre[session];
    });
    const scope = home2.scope(session);
    if (pre && pre.scope !== scope) {
      const branch = currentBranch(home2.root);
      if (branch && branchBornSince(home2.root, branch, pre.since)) {
        home2.carry(pre.scope, scope);
      } else {
        capture(home2.recording(session, home2.headTree() ?? void 0), { session, tool: "branch switch", unverified: true });
        return;
      }
    }
    const rec = home2.recording(session);
    const files = FILE_TOOLS.has(tool) ? toolFiles(home2.root, tool, input) : null;
    capture(rec, {
      session,
      tool,
      transcript: p.transcript_path ?? void 0,
      toolUseId: p.tool_use_id,
      ...command ? { command } : {},
      ...files ? { only: files } : {}
    });
    for (const f of files ?? []) if (isIgnored(home2.root, f)) rec.addIgnoredWrite(f);
    const problems = drain(home2);
    if (problems.length) return context("PostToolUse", `Understand couldn't record: ${problems.join("; ")}`);
    if (PR_CREATE.test(command) && p.hook_event_name === "PostToolUse") {
      return context("PostToolUse", "Understand: you opened a pull request. Now use the understand:explain skill to write its review page against the PR's base branch, then add a short summary to the PR description with `gh pr edit`.");
    }
  },
  async stop(home2, p) {
    const session = p.session_id ?? null;
    drain(home2);
    const endTurn = () => home2.update((st) => {
      if (session) st.turns[session] = (st.turns[session] ?? 0) + 1;
    });
    const rec = home2.active(session);
    if (!rec) return endTurn();
    let captureError = "";
    try {
      capture(rec, { session, tool: "checkpoint", unverified: true });
    } catch (err) {
      captureError = ` (Understand also couldn't snapshot the worktree: ${err.message})`;
    }
    const turn = new Set(rec.turnEdits(session).map((e) => e.id));
    const unnamed = turn.size && !p.stop_hook_active ? (await extract(rec)).symbols.filter((s) => s.gaps.unlinked.some((id) => turn.has(id))) : [];
    const weight = unnamed.reduce((n, s) => {
      const lines = s.rows.filter((r) => (r.t === "+" || r.t === "-") && r.p && s.gaps.unlinked.includes(r.p) && turn.has(r.p)).length;
      return n + (lines || TRIVIAL_LINES + 1);
    }, 0);
    if (weight > TRIVIAL_LINES) {
      const names = unnamed.map((s) => `${s.file}:${s.kind === "other" || s.kind === "file" ? "" : s.name}`.replace(/:$/, ""));
      return {
        decision: "block",
        reason: `Understand: this turn changed ${unnamed.length} symbol${unnamed.length > 1 ? "s" : ""} no decision names: ${names.slice(0, 12).join(", ")}${names.length > 12 ? ", \u2026" : ""}. Name each on the decision it belongs to with \`understand link D<n> --for <file>:<Symbol>\`, record a new one with \`understand decide \u2026 --for \u2026\`, or use \`understand decide --mechanical --title \u2026 --for \u2026\`. Then finish your reply.` + captureError
      };
    }
    endTurn();
  }
};
function cliNote() {
  if (!process.env.PLUGIN_ROOT) return "";
  return `
In this environment run the CLI as \`${join7(process.env.PLUGIN_ROOT, "bin", "understand")}\` wherever these rules or the skills say \`understand\`.`;
}
function stageLog(root, log2) {
  if (!log2) return;
  try {
    execFileSync3("git", ["-C", root, "add", "--", log2], { stdio: "ignore" });
  } catch {
  }
}
function real(p) {
  try {
    return realpathSync2(p);
  } catch {
    try {
      return join7(realpathSync2(dirname3(p)), basename3(p));
    } catch {
      return p;
    }
  }
}
function relFile(root, p) {
  if (typeof p !== "string" || !p) return null;
  const rel = relative2(real(root), real(isAbsolute3(p) ? p : resolve2(root, p)));
  if (rel === ".." || rel.startsWith(".." + sep2) || isAbsolute3(rel)) return null;
  return rel;
}

// src/render.ts
import { createHash as createHash2 } from "node:crypto";
import { readFileSync as readFileSync7 } from "node:fs";
import { fileURLToPath as fileURLToPath2 } from "node:url";
var ATTN2 = /* @__PURE__ */ new Set(["careful", "skim", "mechanical"]);
function viewerData(x, n) {
  const sessionNo = new Map(x.sessions.map((s, i) => [s, i + 1]));
  const domId = new Map(x.symbols.map((s, i) => [s.id, `s${i}`]));
  const decById = new Map(x.decisions.map((d) => [d.id, d]));
  const supersededBy = new Map(x.decisions.filter((d) => d.supersedes).map((d) => [d.supersedes, d.id]));
  const chapters = n?.chapters?.length ? explicitChapters(x, n, domId) : decisionChapters(x, domId);
  const symbols = x.symbols.map((s) => {
    const note = n?.symbols?.[s.id];
    const later = s.later.filter((d) => decById.has(d) && !s.decisions.includes(d));
    const unlinked = new Set(s.gaps.unlinked);
    const rows = s.rows.map((r) => {
      const flag = r.t === "+" || r.t === "-" ? r.p === "outside" ? "o" : r.p === "before" ? "b" : r.p && unlinked.has(r.p) ? "u" : void 0 : void 0;
      return { t: r.t, o: r.o, n: r.n, s: r.s, ...flag ? { x: flag } : {} };
    });
    const decs = s.decisions.map((d) => decById.get(d)).filter(Boolean);
    const mechanicalOnly = decs.length > 0 && decs.every((d) => d.mechanical);
    const attn = note?.attention && ATTN2.has(note.attention) ? note.attention : mechanicalOnly ? "mechanical" : "skim";
    const risks = [
      ...[...decs, ...later.map((d) => decById.get(d))].flatMap((d) => (d.risks ?? []).map((text2) => ({ text: text2, from: d.id }))),
      ...note?.risk ? [{ text: note.risk, from: null }] : []
    ];
    const shown = [...s.decisions, ...later].map((d) => decById.get(d)).map((d) => d && [d.id, d.title, d.why, d.alternatives, d.risks]);
    const fp = createHash2("sha1").update(JSON.stringify([s.rows, s.gaps, later, shown, note ?? null])).digest("hex").slice(0, 10);
    return {
      id: domId.get(s.id),
      ref: s.id,
      key: `${s.id}@${fp}`,
      file: s.file,
      kind: s.kind,
      name: s.name,
      sig: s.sig,
      status: s.status,
      moved: s.movedFrom,
      note: s.note,
      rows,
      dec: s.decisions,
      later,
      sum: note?.summary ?? null,
      why: note?.why,
      how: note?.how,
      risks,
      gaps: { outside: s.gaps.outside, before: s.gaps.before, unlinked: s.gaps.unlinked.length },
      explained: s.explained,
      attn,
      attnWhy: note?.attentionReason ?? null
    };
  });
  return {
    title: n?.title || `Changes on ${x.startedOn}`,
    intent: n?.intent ?? "",
    branch: x.branch,
    startedOn: x.startedOn,
    baseLabel: x.baseLabel,
    headLabel: x.headLabel,
    generatedAt: x.generatedAt,
    sessions: x.sessions.length,
    span: x.span,
    files: x.files,
    ignoredWrites: x.ignoredWrites,
    byName: x.byName,
    warnings: x.warnings,
    decisions: x.decisions.map((d) => ({
      id: d.id,
      who: d.by === "human" ? "human" : "agent",
      title: d.title,
      ctx: d.why,
      alts: d.alternatives,
      risks: d.risks ?? [],
      supersedes: d.supersedes,
      supersededBy: supersededBy.get(d.id),
      mechanical: !!d.mechanical,
      session: d.session ? sessionNo.get(d.session) ?? null : null
    })),
    chapters,
    symbols
  };
}
function explicitChapters(x, n, domId) {
  const placed = /* @__PURE__ */ new Set();
  const out = (n.chapters ?? []).map((c) => {
    const syms = c.symbols.filter((id) => domId.has(id) && !placed.has(id));
    syms.forEach((id) => placed.add(id));
    return { title: String(c.title), sum: String(c.summary ?? ""), syms: syms.map((id) => domId.get(id)) };
  });
  const rest = x.symbols.filter((s) => !placed.has(s.id));
  if (rest.length) out.push({ title: "Not placed in the reading order", sum: "The explanation didn't place these. They're listed so nothing is hidden.", syms: rest.map((s) => domId.get(s.id)) });
  return out;
}
function decisionChapters(x, domId) {
  const order = new Map(x.decisions.map((d, i) => [d.id, i]));
  const next = new Map(x.decisions.filter((d) => d.supersedes).map((d) => [d.supersedes, d.id]));
  const final = (id) => {
    const seen = /* @__PURE__ */ new Set();
    while (next.has(id) && !seen.has(id)) {
      seen.add(id);
      id = next.get(id);
    }
    return id;
  };
  const home2 = new Map(x.symbols.filter((s) => s.decisions.length).map((s) => [s.id, s.decisions.map(final).reduce((a, b) => order.get(b) > order.get(a) ? b : a)]));
  const out = [];
  for (const d of x.decisions) {
    const syms = x.symbols.filter((s) => home2.get(s.id) === d.id);
    if (syms.length) out.push({ title: d.title, sum: d.why, syms: syms.map((s) => domId.get(s.id)) });
  }
  const placed = new Set(home2.keys());
  const rest = x.symbols.filter((s) => !placed.has(s.id));
  if (rest.length) out.push({ title: "Not explained by a recorded decision", sum: "No decision in the log covers these changes.", syms: rest.map((s) => domId.get(s.id)) });
  return out;
}
function renderHtml(x, n) {
  const tpl = readFileSync7(fileURLToPath2(new URL("./viewer.html", import.meta.url)), "utf8");
  const json = JSON.stringify(viewerData(x, n)).replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const title = (n?.title || `Changes on ${x.startedOn}`).replace(/[<>&`"]/g, "");
  return tpl.replace("/*__UNDERSTAND_DATA__*/null", () => json).replace("<title>Understand</title>", () => `<title>Understand \xB7 ${title}</title>`);
}

// src/cli.ts
var HELP = `understand: keep a decision log while an agent codes, then explain the diff symbol by symbol.

Recording is automatic in every git repo once the plugin is installed.

Decision log (used by the agent):
  understand decide --title <t> --why <w> --for <file>[:<Symbol>]... [--by agent|human]
                   [--alt <a>]... [--risk <r>]... [--supersedes <Dn>] [--mechanical]
                                             Record a decision; it explains this turn's edits to what it names
  understand link <Dn> --for <file>[:<Symbol>]...
                                             A decision recorded earlier also explains these
  understand decisions                       List the decision log

Review page (pick what to explain; the same choice for all three):
  understand extract [<range>]               Changed symbols with provenance, and where to write the explanation
  understand check [<range>]                 Validate that explanation against the diff
  understand render [<range>] [--out <file>] [--open]
                                             Write the self-contained HTML page
  <range>:  --pr <ref>          a pull request: merge-base with <ref> \u2192 HEAD
            --branch            this branch: merge-base with trunk \u2192 working tree (committed and not)
            --staged            HEAD \u2192 the staged changes
            --uncommitted       HEAD \u2192 working tree
            --commits <a..b>    a commit range, or one commit
            (none)              where recording started \u2192 working tree

Control:
  understand status | where                  What's recorded here, and where it's stored
  understand reset                           End this branch's recording; the next edit starts a new one
  understand off | on [--everywhere]         Stop or resume recording in this repo (or all repos)

State lives in ${"$"}UNDERSTAND_HOME (default ~/.claude/understand), never inside the repo.
`;
var BOOL = /* @__PURE__ */ new Set(["mechanical", "open", "everywhere", "branch", "staged", "uncommitted"]);
var VALUE = /* @__PURE__ */ new Set(["title", "why", "by", "alt", "for", "risk", "supersedes", "out", "pr", "against", "commits"]);
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
function rangeOf(flags) {
  const pr = one(flags, "pr") ?? one(flags, "against");
  const picked = [
    ...pr ? [{ kind: "pr", ref: pr }] : [],
    ...flags.branch ? [{ kind: "branch" }] : [],
    ...flags.staged ? [{ kind: "staged" }] : [],
    ...flags.uncommitted ? [{ kind: "uncommitted" }] : [],
    ...one(flags, "commits") ? [{ kind: "commits", spec: one(flags, "commits") }] : []
  ];
  if (picked.length > 1) fail("pick one range: --pr, --branch, --staged, --uncommitted, or --commits");
  return picked[0] ?? { kind: "recording" };
}
function source(h) {
  return h.active(sessionOf(h)) ?? h;
}
var dirOf = (src) => src instanceof Home ? src.path("shared") : src.dir;
var explanationPath = (src, r) => join8(dirOf(src), "explanations", `${rangeKey(r)}.json`);
function home() {
  const root = repoRoot(process.cwd());
  if (!root) fail("not inside a git repository");
  return Home.forRepo(root);
}
function sessionOf(h) {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CLAUDE_SESSION_ID || h.state().lastHookSession || null;
}
function forSpecs(flags) {
  const specs = (flags.for ?? []).map((s) => s.trim()).filter(Boolean);
  if (!specs.length) fail("--for is required: name each file or file:Symbol this decision shaped (a decision explains only what it names)");
  for (const s of specs) {
    if (s.startsWith(":")) fail(`--for ${s}: name a file, e.g. --for src/api.ts:fetchJSON`);
    if (s.endsWith(":")) fail(`--for ${s}: name the symbol after the colon, or drop the colon to name the whole file`);
  }
  return specs;
}
function record(h, e) {
  try {
    const open = !!e.session && !!h.state().pre[e.session];
    return file(h, e, open ? "own" : "unknown");
  } catch (err) {
    if (!isWriteDenied(err)) fail(err.message);
    enqueue(h.root, e);
    return null;
  }
}
async function main() {
  const { cmd, args, flags } = parse(process.argv.slice(2));
  switch (cmd) {
    case "decide": {
      const h = home();
      const title = one(flags, "title")?.trim();
      if (!title) fail("--title is required");
      const mechanical = !!flags.mechanical;
      const why = (one(flags, "why") ?? "").trim();
      if (!why && !mechanical) fail("--why is required: paraphrase the reason (use --mechanical for edits with no design choice)");
      const by = one(flags, "by") ?? "agent";
      if (by !== "agent" && by !== "human") fail("--by must be agent or human");
      const input = {
        title,
        why,
        by,
        alternatives: flags.alt ?? [],
        risks: flags.risk ?? [],
        for: forSpecs(flags),
        ...one(flags, "supersedes") ? { supersedes: one(flags, "supersedes") } : {},
        ...mechanical ? { mechanical } : {}
      };
      const done = record(h, { kind: "decide", session: sessionOf(h), ts: (/* @__PURE__ */ new Date()).toISOString(), input });
      console.log(!done ? `Recorded for ${input.for.join(", ")}; it will be filed into the log when this command finishes.` : `${done.id} recorded for ${input.for.join(", ")}.${done.log ? ` Shared log: ${done.log} (committed with your changes).` : ""}`);
      return;
    }
    case "link": {
      const h = home();
      const id = args[0];
      if (!id) fail("usage: understand link <Dn> --for <file>[:<Symbol>]...");
      const specs = forSpecs(flags);
      record(h, { kind: "link", session: sessionOf(h), ts: (/* @__PURE__ */ new Date()).toISOString(), decision: id, for: specs });
      console.log(`${id} now also explains ${specs.join(", ")}.`);
      return;
    }
    case "decisions": {
      const src = source(home());
      const list2 = src instanceof Home ? readLogs(src.root) : src.decisions();
      if (src instanceof Home) console.log(list2.length ? "(from the decision log checked into .decisions/)" : "No decisions recorded here, locally or in .decisions/.");
      for (const d of list2) {
        console.log(`${d.id} [${d.by}${d.mechanical ? ", mechanical" : ""}]${d.supersedes ? ` (revises ${d.supersedes})` : ""} ${d.title}`);
        if (d.why) console.log(`    why: ${d.why}`);
        console.log(`    for: ${d.for.join(", ")}`);
        for (const a of d.alternatives) console.log(`    rejected: ${a}`);
        for (const r of d.risks ?? []) console.log(`    risk: ${r}`);
      }
      return;
    }
    case "status": {
      const h = home();
      const session = sessionOf(h);
      console.log(h.isOff() ? "Recording is off here (`understand on` resumes it)." : `Recording is on (${h.scope(session)}).`);
      const rec = h.active(session);
      if (!rec) return console.log("Nothing recorded yet; the first edit starts a recording.");
      console.log(`Recording ${rec.id} since ${rec.config().createdAt}: ${rec.decisions().length} decisions, ${rec.edits().length} captured changes.`);
      const turn = new Set(rec.turnEdits(session).map((e) => e.id));
      const unnamed = (await extract(rec)).symbols.filter((s) => s.gaps.unlinked.some((id) => turn.has(id)));
      if (unnamed.length) console.log(`Changed this turn, not named by any decision: ${unnamed.map((s) => `${s.file}:${s.name}`).join(", ")}`);
      return;
    }
    case "where": {
      const h = home();
      console.log(h.active(sessionOf(h))?.dir ?? h.dir);
      return;
    }
    case "reset": {
      const h = home();
      console.log(h.reset(sessionOf(h)) ? "Ended this recording; the next edit starts a new one." : "Nothing was being recorded here.");
      return;
    }
    case "off":
    case "on": {
      const file2 = flags.everywhere ? join8(understandHome(), "off") : home().path("off");
      mkdirSync6(dirname4(file2), { recursive: true, mode: 448 });
      if (cmd === "off") writeFileSync3(file2, (/* @__PURE__ */ new Date()).toISOString() + "\n");
      else rmSync3(file2, { force: true });
      if (cmd === "on" && !flags.everywhere && home().isOff()) console.log("Recording is still off here: `understand off --everywhere` (or UNDERSTAND_DISABLE) applies to every repo. Run `understand on --everywhere`.");
      else console.log(`Recording is ${cmd}${flags.everywhere ? " everywhere" : " in this repo"}.`);
      return;
    }
    case "extract": {
      const src = source(home());
      const range = rangeOf(flags);
      const x = await extract(src, range);
      mkdirSync6(dirOf(src), { recursive: true });
      writeFileSync3(join8(dirOf(src), "extract.json"), JSON.stringify(x, null, 2));
      printExtract(x);
      console.log(`
Full detail (code and per-line provenance): ${join8(dirOf(src), "extract.json")}`);
      console.log(`Write the explanation for this range to: ${explanationPath(src, range)}`);
      return;
    }
    case "check": {
      const src = source(home());
      const range = rangeOf(flags);
      const n = readExplanation(explanationPath(src, range));
      if (!n) fail(`no explanation for this range yet (${explanationPath(src, range)})`);
      const x = await extract(src, range);
      const r = check(x, n);
      for (const e of r.errors) console.log(`error: ${e}`);
      if (r.missing.length) console.log(`not explained or not in a chapter (${r.missing.length}):
  ${r.missing.join("\n  ")}`);
      if (r.errors.length || r.missing.length) process.exit(1);
      console.log(`OK: ${x.symbols.length} symbols explained across ${n.chapters?.length ?? 0} chapters.`);
      return;
    }
    case "render": {
      const src = source(home());
      const range = rangeOf(flags);
      const x = await extract(src, range);
      const n = readExplanation(explanationPath(src, range));
      if (n) {
        const r = check(x, n);
        if (r.errors.length) fail(`explanation is invalid (${r.errors.length} errors); fix them first:
  ${r.errors.join("\n  ")}`);
        if (r.missing.length) process.stderr.write(`warning: ${r.missing.length} symbols aren't explained; they'll be listed separately.
`);
      }
      const outFlag = one(flags, "out");
      const out = outFlag ? resolve3(outFlag) : join8(dirOf(src), "reports", `understand-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`);
      mkdirSync6(dirname4(out), { recursive: true });
      writeFileSync3(out, renderHtml(x, n));
      if (!outFlag) copyFileSync(out, join8(dirOf(src), "reports", "latest.html"));
      console.log(out);
      if (flags.open) {
        try {
          execFileSync4(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [out]);
        } catch {
        }
      }
      return;
    }
    case "hook":
      await runHook(args[0] ?? "");
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
function printExtract(x) {
  const byFile = /* @__PURE__ */ new Map();
  for (const s of x.symbols) byFile.set(s.file, [...byFile.get(s.file) ?? [], s]);
  console.log(`${x.symbols.length} changed symbols in ${byFile.size} files (${x.baseLabel} \u2192 ${x.headLabel}); ${x.decisions.length} decisions.`);
  for (const [file2, syms] of byFile) {
    const f = x.files[file2];
    console.log(`
${file2} (${f.status}${f.note ? `, ${f.note}` : ""})`);
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
main().catch((e) => {
  if (isWriteDenied(e)) {
    fail(`this command can't write Understand's state (${understandHome()}), probably because of a sandbox. Run it again with permission to write outside the workspace (in Codex, request escalated permissions), or add that folder to Codex's \`sandbox_workspace_write.writable_roots\`.`);
  }
  fail(e.message ?? String(e));
});
