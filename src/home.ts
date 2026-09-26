import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { DIR_MODE, readJson, withDirLock, writeJson } from "./fsutil.js";
import { commonDir, currentBranch, git, headCommit, trunkBranch, writeWorktreeTree, type GitEnv } from "./git.js";
import { Store } from "./store.js";

/** Resolve symlinks (e.g. macOS /var → /private/var) even for a path that doesn't exist yet. */
export function realish(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return dirname(p) === p ? p : join(realish(dirname(p)), basename(p));
  }
}

/** Everything Understand keeps lives here, never inside the user's repo. */
export function understandHome(): string {
  return process.env.UNDERSTAND_HOME || join(homedir(), ".claude", "understand");
}

export interface HomeState {
  /** Turn counter per session; a turn ends at each Stop. */
  turns: Record<string, number>;
  lastHookSession?: string;
  /**
   * Each session's open tool call: its scope and start time (unix seconds) when the pre hook ran.
   * Removed by the post hook; `decide` credits changes to the agent only while one is open.
   */
  pre: Record<string, { scope: string; since: number }>;
}

/**
 * Per-repository home, outside the repo: recordings, a private index, and a private object store
 * that snapshots are written to. Worktrees of one repo share it.
 */
export class Home {
  private depth = 0;

  private constructor(readonly root: string, readonly dir: string, readonly repoObjects: string) {}

  static forRepo(root: string): Home {
    const common = realpathSync(commonDir(root));
    // Named after the main checkout, keyed by the shared git dir: every worktree of a repo gets the same home.
    const main = basename(common) === ".git" ? basename(dirname(common)) : basename(common).replace(/\.git$/, "");
    const name = main.replace(/[^\w.-]/g, "_") + "-" + createHash("sha1").update(common).digest("hex").slice(0, 10);
    const home = realish(resolve(understandHome()));
    for (const inside of [realpathSync(root), common]) {
      const rel = relative(inside, home);
      if (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel)) throw new Error(`UNDERSTAND_HOME (${home}) is inside the repository; it must live outside it`);
    }
    return new Home(root, join(home, "repos", name), join(common, "objects"));
  }

  path(...parts: string[]) {
    return join(this.dir, ...parts);
  }

  /** Off for this repo (`understand off`), or everywhere (`understand off --everywhere`, UNDERSTAND_DISABLE=1). */
  isOff(): boolean {
    return !!process.env.UNDERSTAND_DISABLE || existsSync(join(understandHome(), "off")) || existsSync(this.path("off"));
  }

  /** Serialize every read-modify-write across hooks and CLI calls (reentrant within a process). */
  withLock<T>(fn: () => T): T {
    if (this.depth > 0) {
      this.depth++;
      try { return fn(); } finally { this.depth--; }
    }
    return withDirLock(this.dir, () => {
      this.depth = 1;
      try { return fn(); } finally { this.depth = 0; }
    });
  }

  state(): HomeState {
    return readJson<HomeState>(this.path("state.json"), { turns: {}, pre: {} });
  }
  update(fn: (s: HomeState) => void) {
    this.withLock(() => {
      const s = this.state();
      fn(s);
      writeJson(this.path("state.json"), s);
    });
  }
  turn(session: string | null): number {
    return (session && this.state().turns[session]) || 0;
  }

  /**
   * Snapshots are written only to our own object store, so they never depend on the repo's objects
   * surviving a `git gc`. Reads may also see the repo's objects (for merge-base comparisons).
   */
  writeEnv(): GitEnv {
    const wt = createHash("sha1").update(realpathSync(this.root)).digest("hex").slice(0, 10);
    mkdirSync(this.path("objects"), { recursive: true, mode: DIR_MODE });
    return { GIT_INDEX_FILE: this.path(`index-${wt}`), GIT_OBJECT_DIRECTORY: this.path("objects") };
  }
  readEnv(): GitEnv {
    return { ...this.writeEnv(), GIT_ALTERNATE_OBJECT_DIRECTORIES: this.repoObjects };
  }

  snapshot(): string {
    return this.withLock(() => writeWorktreeTree(this.root, this.writeEnv()));
  }

  /**
   * A feature branch is one recording across sessions; trunk gets one per session; a detached HEAD
   * one per session and commit (checking out another commit is not an edit).
   */
  scope(session: string | null): string {
    const branch = currentBranch(this.root);
    if (branch && branch !== trunkBranch(this.root)) return `branch:${branch}`;
    return `session:${session ?? "none"}:${branch ?? `detached@${headCommit(this.root)?.slice(0, 12)}`}`;
  }

  /** Tree of the committed HEAD, written into the private store (reads it via the repo's objects). */
  headTree(): string | null {
    const head = headCommit(this.root);
    if (!head) return null;
    return git(this.root, ["rev-parse", `${head}^{tree}`], this.readEnv()).trim();
  }

  private index(): Record<string, string> {
    return readJson<Record<string, string>>(this.path("recordings.json"), {});
  }

  active(session: string | null): Store | null {
    const id = this.index()[this.scope(session)];
    return id ? new Store(this, id) : null;
  }

  /** The current scope's recording, started now if there is none (from `baseTree`, or the current worktree). */
  recording(session: string | null, baseTree?: string): Store {
    return this.withLock(() => {
      const existing = this.active(session);
      if (existing) return existing;
      const scope = this.scope(session);
      const id = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + randomBytes(3).toString("hex");
      const tree = baseTree ?? this.snapshot();
      const store = new Store(this, id);
      mkdirSync(store.dir, { recursive: true });
      const branch = currentBranch(this.root);
      const slug = (branch ?? "session").replace(/[^\w.-]+/g, "-");
      store.writeConfig({ scope, branch, session, baseTree: tree, createdAt: new Date().toISOString(), logFile: `${id.slice(0, 8)}-${slug}-${id.slice(-6)}.tsv` });
      store.writeState({ lastTree: tree });
      writeJson(this.path("recordings.json"), { ...this.index(), [scope]: id });
      return store;
    });
  }

  /**
   * The work moved to another scope without changing (`git switch -c`, `git branch -m`):
   * the recording follows it, so its decisions stay with the code they explain.
   */
  carry(from: string, to: string): boolean {
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
  reset(session: string | null): boolean {
    return this.withLock(() => {
      const idx = this.index();
      const scope = this.scope(session);
      if (!idx[scope]) return false;
      delete idx[scope];
      writeJson(this.path("recordings.json"), idx);
      return true;
    });
  }
}
