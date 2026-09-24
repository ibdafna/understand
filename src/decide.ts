import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { capture } from "./capture.js";
import { appendJsonl } from "./fsutil.js";
import { LOG_DIR, writeLog } from "./decisionlog.js";
import type { Home } from "./home.js";
import type { Decider, Store } from "./store.js";

export interface DecisionInput {
  title: string;
  why: string;
  by: Decider;
  alternatives: string[];
  risks?: string[];
  for: string[];
  supersedes?: string;
  mechanical?: boolean;
}

/** A decision or link, as the agent's command asked for it. */
export type Entry =
  | { kind: "decide"; session: string | null; ts: string; input: DecisionInput }
  | { kind: "link"; session: string | null; ts: string; decision: string; for: string[] };

/**
 * How to treat changes not yet captured when the entry is filed: made by the calling command itself
 * (a hooked tool call is open), of unknown origin (a person's terminal), or already captured by a hook.
 */
export type Pending = "own" | "unknown" | "captured";

/** File an entry into the current scope's recording and refresh the shared log. Returns the decision id. */
export function file(h: Home, e: Entry, pending: Pending): { rec: Store; id: string; log: string | null } {
  const out = h.withLock(() => {
    const rec = h.recording(e.session);
    const known = (id: string) => rec.decisions().some((d) => d.id === id);
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
      ts: e.ts, session: e.session, title: d.title, why: d.why, by: d.by, alternatives: d.alternatives,
      ...(d.risks?.length ? { risks: d.risks } : {}),
      for: d.for, claimable,
      ...(d.supersedes ? { supersedes: d.supersedes } : {}),
      ...(d.mechanical ? { mechanical: true } : {}),
    });
    return { rec, id: rec2.id };
  });
  return { ...out, log: writeLog(out.rec) };
}

/**
 * When the agent's command can't write Understand's state (Codex runs commands in a sandbox that
 * only allows writes inside the workspace), the entry waits in the repo's `.decisions/` folder until
 * the next hook, which runs outside the sandbox, files it.
 */
const QUEUE = join(LOG_DIR, ".pending.jsonl");

export function enqueue(root: string, e: Entry): string {
  const path = join(root, QUEUE);
  mkdirSync(dirname(path), { recursive: true });
  appendJsonl(path, e);
  return QUEUE;
}

/** File every queued entry. Returns the problems, to tell the agent. */
export function drain(h: Home): string[] {
  const path = join(h.root, QUEUE);
  if (!existsSync(path)) return [];
  // Take the queue first, so entries written while filing aren't lost.
  const taken = `${path}.${process.pid}`;
  renameSync(path, taken);
  const problems: string[] = [];
  for (const line of readFileSync(taken, "utf8").split("\n").filter((l) => l.trim())) {
    try {
      file(h, JSON.parse(line) as Entry, "captured");
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  rmSync(taken, { force: true });
  return problems;
}

/** Errors that mean "you may not write here" (a sandbox), not "something is broken". */
export function isWriteDenied(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EACCES" || code === "EROFS" || /Operation not permitted|Read-only file system/.test(String((err as Error)?.message));
}
