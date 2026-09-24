import { execFileSync } from "node:child_process";
import { appendFileSync, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { Store } from "./store.js";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function git(root: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function repoRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

export function currentBranch(root: string): string {
  try {
    return git(root, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  } catch {
    return "(no commits)";
  }
}

function gitPath(root: string, name: string): string {
  const p = git(root, ["rev-parse", "--git-path", name]).trim();
  return isAbsolute(p) ? p : join(root, p);
}

/** Keep .understand/ out of git without touching tracked files. */
export function excludeLogDir(root: string) {
  const file = gitPath(root, "info/exclude");
  const cur = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!cur.split("\n").includes(".understand/")) appendFileSync(file, (cur && !cur.endsWith("\n") ? "\n" : "") + ".understand/\n");
}

/**
 * Tree hash of the whole worktree, including untracked files and uncommitted changes.
 * Uses a private index so the user's staging area is never touched. The private index
 * starts as a copy of the real one, so tracked-but-ignored files and sparse-checkout
 * (skip-worktree) entries behave exactly as they do for the user's own `git add -A`.
 */
export function snapshot(store: Store): string {
  return store.withLock(() => {
    const index = store.path("index");
    const real = gitPath(store.root, "index");
    if (existsSync(index) && lstatSync(index).isSymbolicLink()) throw new Error(".understand/index is a symlink; refusing to snapshot through it");
    if (existsSync(real) && existsSync(index) && realpathSync(index) === realpathSync(real)) throw new Error("private index resolves to the repository's own index");
    if (!existsSync(index) && existsSync(real)) copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    git(store.root, ["add", "-A", "--", "."], env);
    return git(store.root, ["write-tree"], env).trim();
  });
}

/** Pin a tree with a commit + ref so `git gc` never collects the baseline. */
export function pinTree(root: string, tree: string, ref: string): string {
  const commit = git(root, ["commit-tree", tree, "-m", "understand baseline"]).trim();
  git(root, ["update-ref", ref, commit]);
  return commit;
}

export function treeOf(root: string, rev: string): string {
  return git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`]).trim();
}

export function readAt(root: string, treeish: string, path: string): string | null {
  try {
    return execFileSync("git", ["-C", root, "cat-file", "blob", `${treeish}:${path}`], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

export interface FileChange {
  status: "A" | "M" | "D";
  path: string;
  oldMode: string;
  newMode: string;
  oldSha: string;
  newSha: string;
}

export function changedFiles(root: string, from: string, to: string): FileChange[] {
  const out = git(root, ["diff-tree", "-r", "--no-renames", "--raw", "-z", from || EMPTY_TREE, to]);
  const parts = out.split("\0");
  const res: FileChange[] = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta.startsWith(":")) break;
    const [oldMode, newMode, oldSha, newSha, st] = meta.slice(1).split(" ");
    const s = st[0];
    res.push({ status: s === "A" || s === "D" ? s : "M", path: parts[i + 1], oldMode, newMode, oldSha, newSha });
  }
  return res;
}

export function isIgnored(root: string, path: string): boolean {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", path], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}
