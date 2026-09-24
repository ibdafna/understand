import { randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Everything Understand stores is private to the user: source snapshots, decisions, transcripts pointers. */
export const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/**
 * Directory lock. The lock records its owner; it is only reclaimed when that process is gone,
 * never by age, so a slow holder can't lose it to a waiter.
 */
export function withDirLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  chmodSync(dir, DIR_MODE); // tighten a folder an older version created with default permissions
  const lock = join(dir, "lock");
  const owner = join(lock, "owner");
  const token = `${process.pid} ${randomBytes(8).toString("hex")}`;
  const start = Date.now();
  for (;;) {
    // Build the lock with its owner inside, then move it into place in one step: a lock never exists without an owner.
    const tmp = `${lock}.${process.pid}.${randomBytes(4).toString("hex")}`;
    mkdirSync(tmp, { mode: DIR_MODE });
    writeFileSync(join(tmp, "owner"), token);
    try {
      renameSync(tmp, lock);
      break;
    } catch (e: any) {
      rmSync(tmp, { recursive: true, force: true });
      if (e.code !== "EEXIST" && e.code !== "ENOTEMPTY") throw e;
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
      if (Date.now() - start > 60_000) throw new Error(`timed out waiting for ${lock}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return fn();
  } finally {
    try {
      if (readFileSync(owner, "utf8") === token) rmSync(lock, { recursive: true, force: true });
    } catch {}
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

export function writeAtomic(file: string, text: string) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: FILE_MODE });
  renameSync(tmp, file);
}

export function readJson<T>(file: string, dflt: T): T {
  if (!existsSync(file)) return dflt;
  return JSON.parse(readFileSync(file, "utf8")); // malformed state is an error, never silently "fresh"
}

export function writeJson(file: string, value: unknown) {
  writeAtomic(file, JSON.stringify(value, null, 2) + "\n");
}

/** A crash mid-append can leave a partial last line; skip unparsable lines rather than lose the log. */
export function readJsonl<T>(file: string): T[] {
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

/** Append one record, first terminating any partial line a crash left behind. */
export function appendJsonl(file: string, rec: object) {
  let prefix = "";
  try {
    const cur = readFileSync(file, "utf8");
    if (cur && !cur.endsWith("\n")) prefix = "\n";
  } catch {}
  appendFileSync(file, prefix + JSON.stringify(rec) + "\n", { mode: FILE_MODE });
}

export const nextNumber = (ids: string[]) => ids.reduce((m, id) => Math.max(m, Number(id.slice(1)) || 0), 0) + 1;
