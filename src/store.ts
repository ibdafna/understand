import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Written by `understand init`. `base` is a pinned commit; `initTree` is the worktree when recording began. */
export interface Config {
  version: 2;
  id: string;
  base: string;
  baseRef: string;
  initTree: string;
  branch: string;
  createdAt: string;
}

export type Decider = "human" | "agent";

/** A choice recorded while working. Append-only; `supersedes` is how a decision gets revised. */
export interface Decision {
  id: string;
  ts: string;
  session: string | null;
  turn: number;
  title: string;
  why: string;
  by: Decider;
  alternatives: string[];
  supersedes?: string;
  mechanical?: boolean;
  /** Edits it explains that had no decision when it was recorded. */
  adopts: string[];
  /** What it shaped: "path", "path:Symbol", or "Symbol". */
  for?: string[];
  /** Edits the claims may bind to: this turn's edits that existed when the decision was recorded. */
  claimable?: string[];
}

/** `understand link`: attaches unlinked edits (and optional claims) to an existing decision. */
export interface Link {
  decision: string;
  ts: string;
  session: string | null;
  turn: number;
  adopts: string[];
  for?: string[];
  claimable?: string[];
}

/**
 * One captured change: the worktree went from tree `from` to tree `to`.
 * `unverified` changes were found by a checkpoint in a hooked session, so no hooked
 * tool made them (a person's editor, another program). They never count as the agent's.
 */
export interface Edit {
  id: string;
  ts: string;
  session: string | null;
  turn: number;
  tool: string;
  from: string;
  to: string;
  files: string[];
  command?: string;
  unverified?: boolean;
}

export interface SessionState {
  turn: number;
  /** Hooks are running for this session, so the shell and edit tools are observed directly. */
  hooked: boolean;
}

export interface State {
  /** Worktree tree hash as of the last capture; anything after it hasn't been attributed yet. */
  lastTree: string;
  sessions: Record<string, SessionState>;
  /** Session of the most recent hook, for CLI calls that can't see their own session id. */
  lastHookSession?: string;
}

export interface Claim {
  decision: string;
  spec: string;
  /** The only edits this claim can explain. */
  edits: Set<string>;
}

export class Store {
  private depth = 0;

  constructor(readonly root: string) {}

  get dir() {
    return join(this.root, ".understand");
  }
  path(...parts: string[]) {
    return join(this.dir, ...parts);
  }

  /** .understand must be a real directory inside the repo; anything else could redirect writes. */
  assertSafe() {
    if (!existsSync(this.dir)) return;
    if (lstatSync(this.dir).isSymbolicLink()) throw new Error(".understand is a symlink; refusing to record through it");
    const rel = relative(realpathSync(this.root), realpathSync(this.dir));
    if (rel !== ".understand") throw new Error(".understand resolves outside the repository");
  }

  exists() {
    this.assertSafe();
    return existsSync(this.path("config.json"));
  }

  /**
   * Serialize every read-modify-write across hooks and CLI calls (reentrant within a process).
   * The lock records its owner; it is only reclaimed when that process is gone, never by age.
   */
  withLock<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    }
    this.assertSafe();
    mkdirSync(this.dir, { recursive: true });
    const lock = this.path("lock");
    const owner = join(lock, "owner");
    const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
    const start = Date.now();
    for (;;) {
      try {
        mkdirSync(lock);
        writeFileSync(owner, token);
        break;
      } catch (e: any) {
        if (e.code !== "EEXIST") throw e;
        if (ownerGone(owner)) {
          // Claim the stale lock by renaming it away atomically, so two reclaimers can't both win.
          const stale = `${lock}.stale.${process.pid}.${Date.now()}`;
          try {
            renameSync(lock, stale);
            if (ownerGone(join(stale, "owner"))) rmSync(stale, { recursive: true, force: true });
            else renameSync(stale, lock); // raced with a fresh owner: give it back
          } catch {}
          continue;
        }
        if (Date.now() - start > 60_000) throw new Error("timed out waiting for .understand/lock");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    }
    this.depth = 1;
    try {
      return fn();
    } finally {
      this.depth = 0;
      try {
        if (readFileSync(owner, "utf8") === token) rmSync(lock, { recursive: true, force: true });
      } catch {}
    }
  }

  config(): Config {
    const c = JSON.parse(readFileSync(this.path("config.json"), "utf8"));
    if (c.version !== 2) throw new Error("this recording was made by an older understand; run `understand init --force` to start a new one");
    return c;
  }
  writeConfig(c: Config) {
    writeAtomic(this.path("config.json"), JSON.stringify(c, null, 2) + "\n");
  }

  state(): State {
    let raw: string;
    try {
      raw = readFileSync(this.path("state.json"), "utf8");
    } catch (e: any) {
      if (e.code === "ENOENT") throw new Error("recording state is missing; run `understand init --force`");
      throw e;
    }
    return JSON.parse(raw); // malformed state is an error, never silently "fresh"
  }
  writeState(s: State) {
    writeAtomic(this.path("state.json"), JSON.stringify(s, null, 2) + "\n");
  }
  updateState(fn: (s: State) => void) {
    this.withLock(() => {
      const s = this.state();
      fn(s);
      this.writeState(s);
    });
  }
  session(s: State, id: string | null): SessionState {
    return (id && s.sessions[id]) || { turn: 0, hooked: false };
  }

  decisions(): Decision[] {
    return readJsonl<Decision>(this.path("decisions.jsonl")).filter((d) => /^D\d+$/.test(d.id));
  }
  edits(): Edit[] {
    return readJsonl<Edit>(this.path("edits.jsonl")).filter((e) => /^E\d+$/.test(e.id));
  }
  linkRecords(): Link[] {
    return readJsonl<Link>(this.path("links.jsonl")).filter((l) => /^D\d+$/.test(l.decision));
  }
  ignoredWrites(): { file: string; ts: string }[] {
    return readJsonl(this.path("ignored.jsonl"));
  }

  addDecision(d: Omit<Decision, "id">): Decision {
    return this.withLock(() => {
      const rec = { id: `D${nextNumber(this.decisions().map((x) => x.id))}`, ...d };
      append(this.path("decisions.jsonl"), rec);
      return rec;
    });
  }
  addEdit(e: Omit<Edit, "id">): Edit {
    return this.withLock(() => {
      const rec = { id: `E${nextNumber(this.edits().map((x) => x.id))}`, ...e };
      append(this.path("edits.jsonl"), rec);
      return rec;
    });
  }
  addLink(l: Link) {
    this.withLock(() => append(this.path("links.jsonl"), l));
  }
  addIgnoredWrite(file: string) {
    this.withLock(() => append(this.path("ignored.jsonl"), { file, ts: new Date().toISOString() }));
  }

  /** Edit id → decision id, from adoption by `decide` or `link`. First claim wins. */
  links(): Map<string, string> {
    const m = new Map<string, string>();
    const all = [...this.decisions().map((d) => ({ decision: d.id, adopts: d.adopts, ts: d.ts })), ...this.linkRecords()];
    all.sort((a, b) => a.ts.localeCompare(b.ts));
    for (const r of all) for (const id of r.adopts) if (!m.has(id)) m.set(id, r.decision);
    return m;
  }

  claims(): Claim[] {
    const out: Claim[] = [];
    for (const r of [...this.decisions().map((d) => ({ ...d, decision: d.id })), ...this.linkRecords()]) {
      const edits = new Set(r.claimable ?? []);
      for (const spec of r.for ?? []) out.push({ decision: r.decision, spec, edits });
    }
    return out;
  }

  /** Agent edits from this session's current turn, explained or not. */
  turnEdits(session: string | null): Edit[] {
    const turn = this.session(this.state(), session).turn;
    return this.edits().filter((e) => !e.unverified && e.session === session && e.turn === turn);
  }

  /**
   * Agent edits from this session's current turn that no decision explains yet. Earlier turns are
   * closed: whatever they left unexplained stays unexplained rather than being explained later.
   */
  unlinkedEdits(session: string | null): Edit[] {
    const links = this.links();
    const turn = this.session(this.state(), session).turn;
    return this.edits().filter((e) => !e.unverified && !links.has(e.id) && e.session === session && e.turn === turn);
  }
}

function ownerGone(owner: string): boolean {
  let pid: number;
  try {
    pid = Number(readFileSync(owner, "utf8").split(" ")[0]);
  } catch {
    return false; // being created right now; wait
  }
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e: any) {
    return e.code === "ESRCH";
  }
}

const nextNumber = (ids: string[]) => Math.max(0, ...ids.map((id) => Number(id.slice(1)) || 0)) + 1;

/** Append one record, first terminating any partial line a crash left behind. */
function append(file: string, rec: object) {
  let prefix = "";
  try {
    const cur = readFileSync(file, "utf8");
    if (cur && !cur.endsWith("\n")) prefix = "\n";
  } catch {}
  appendFileSync(file, prefix + JSON.stringify(rec) + "\n");
}

function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

/** A crash mid-append can leave a partial last line; skip unparsable lines rather than lose the log. */
function readJsonl<T>(file: string): T[] {
  if (!existsSync(file)) return [];
  const out: T[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      process.stderr.write(`warning: skipping a corrupt line in ${file}\n`);
    }
  }
  return out;
}
