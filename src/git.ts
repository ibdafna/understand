import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * Environment that points git at Understand's private index and object store (outside the repo).
 * The repo's own objects stay readable through alternates; nothing is written into the repo.
 */
export type GitEnv = Record<string, string>;

export function git(root: string, args: string[], env?: GitEnv): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function gitInput(root: string, args: string[], input: string, env?: GitEnv): string {
  return execFileSync("git", ["-C", root, ...args], { input, encoding: "utf8", env: env ? { ...process.env, ...env } : process.env });
}

export function repoRoot(cwd: string): string | null {
  try {
    return execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
}

export function commonDir(root: string): string {
  const p = git(root, ["rev-parse", "--git-common-dir"]).trim();
  return isAbsolute(p) ? p : join(root, p);
}

/** Current branch, or null when HEAD is detached. */
export function currentBranch(root: string): string | null {
  try {
    const b = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).trim();
    return b || null;
  } catch {
    return null;
  }
}

export function headCommit(root: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Was this branch created or renamed at or after `since` (unix seconds)? Answered by its reflog, so a
 * `git switch -c` followed by a commit in the same command still counts as creating it.
 */
export function branchBornSince(root: string, branch: string, since: number): boolean {
  let out = "";
  try {
    out = git(root, ["reflog", "show", "--date=unix", "--format=%gd%x09%gs", `refs/heads/${branch}`]);
  } catch {
    return false;
  }
  const entries = out.trim().split("\n").filter(Boolean).map((l) => {
    const [ref, subject] = l.split("\t");
    return { time: Number(/@\{(\d+)\}/.exec(ref)?.[1] ?? 0), subject: subject ?? "" };
  });
  const oldest = entries[entries.length - 1];
  if (oldest && oldest.time >= since && /^branch: Created/.test(oldest.subject)) return true;
  return entries.some((e) => e.time >= since && /^Branch: renamed/i.test(e.subject));
}

/**
 * The repo's trunk, first match wins: `git config understand.trunk`; a remote's HEAD (origin first);
 * `init.defaultBranch`; a common name that exists; else the local branch the most others descend from.
 */
export function trunkBranch(root: string): string | null {
  const tryGit = (args: string[]) => { try { return git(root, args).trim(); } catch { return ""; } };
  const exists = (b: string) => !!b && !!tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${b}`]);
  const set = tryGit(["config", "--get", "understand.trunk"]);
  if (set) return set;
  const remotes = tryGit(["remote"]).split("\n").filter(Boolean).sort((a, b) => (a === "origin" ? -1 : b === "origin" ? 1 : 0));
  for (const r of remotes) {
    const head = tryGit(["symbolic-ref", "--quiet", "--short", `refs/remotes/${r}/HEAD`]);
    if (head) return head.slice(r.length + 1);
  }
  const init = tryGit(["config", "--get", "init.defaultBranch"]);
  if (exists(init)) return init;
  for (const b of ["main", "master", "trunk", "develop"]) if (exists(b)) return b;
  // Last resort, only for small repos (it's quadratic and runs in hooks).
  const branches = tryGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"]).split("\n").filter(Boolean);
  if (branches.length > 12) return null;
  let best: string | null = null, most = 0;
  for (const b of branches) {
    const n = branches.filter((o) => o !== b && isAncestor(root, b, o)).length;
    if (n > most) { most = n; best = b; }
  }
  return best;
}

function isAncestor(root: string, a: string, b: string): boolean {
  try {
    execFileSync("git", ["-C", root, "merge-base", "--is-ancestor", a, b], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Tree hash of the whole worktree (untracked and uncommitted included, .gitignore respected). */
export function writeWorktreeTree(root: string, env: GitEnv): string {
  git(root, ["add", "-A", "--", "."], env);
  // Files the repo tracks despite matching .gitignore are part of the code; `add -A` would skip them.
  const tracked = git(root, ["ls-files", "-z", "--cached", "--ignored", "--exclude-standard"]).split("\0").filter((p) => p && existsSync(join(root, p)));
  if (tracked.length) gitInput(root, ["--literal-pathspecs", "add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], tracked.join("\0"), env);
  return git(root, ["write-tree"], env).trim();
}

export function treeOf(root: string, rev: string, env?: GitEnv): string {
  return git(root, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`], env).trim();
}

export function readAt(root: string, treeish: string, path: string, env: GitEnv): string | null {
  try {
    return execFileSync("git", ["-C", root, "cat-file", "blob", `${treeish}:${path}`], {
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

/** Mode + object id of one path in a tree, so a chmod counts as a change. */
export function entryAt(root: string, tree: string, path: string, env: GitEnv): string {
  try {
    return git(root, ["ls-tree", "-z", tree, "--", `:(literal)${path}`], env).split("\t")[0];
  } catch {
    return "";
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

export function changedFiles(root: string, from: string, to: string, env: GitEnv): FileChange[] {
  const out = git(root, ["diff-tree", "-r", "--no-renames", "--raw", "-z", from || EMPTY_TREE, to], env);
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
