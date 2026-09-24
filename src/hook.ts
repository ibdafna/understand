import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { capture } from "./capture.js";
import { isIgnored, repoRoot } from "./git.js";
import { Store } from "./store.js";

interface Payload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: any;
  stop_hook_active?: boolean;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** Entry point for `understand hook <event>`. Hook errors never break the session, but they are never silent either. */
export function runHook(event: string) {
  let store: Store | null = null;
  try {
    const p: Payload = JSON.parse(readFileSync(0, "utf8") || "{}");
    const root = repoRoot(p.cwd || process.cwd());
    if (!root) return;
    store = new Store(root);
    if (!store.exists()) return; // opt-in: only repos where `understand init` ran
    if (process.env.UNDERSTAND_DEBUG) appendFileSync(store.path("hook-payloads.jsonl"), JSON.stringify({ event, ...p }) + "\n");
    const out = handlers[event]?.(store, p);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    const msg = `${new Date().toISOString()} ${event} ${(err as Error).stack}`;
    try {
      if (store) appendFileSync(store.path("hook-errors.log"), msg + "\n");
    } catch {}
    // Surface recording failures to the agent/user instead of silently skipping checks.
    process.stderr.write(`understand: recording failed during ${event}: ${(err as Error).message}\n`);
    if (event === "stop") process.stdout.write(JSON.stringify({ systemMessage: `Understand could not check this turn: ${(err as Error).message}` }));
  }
}

function touchSession(s: Store, session: string | null) {
  s.updateState((st) => {
    if (!session) return;
    st.sessions[session] = { turn: st.sessions[session]?.turn ?? 0, hooked: true };
    st.lastHookSession = session;
  });
}

const handlers: Record<string, (s: Store, p: Payload) => object | void> = {
  "session-start"(s, p) {
    const session = p.session_id ?? null;
    touchSession(s, session);
    // Whatever changed while no agent was running is not the agent's work.
    capture(s, { session, tool: "checkpoint", unverified: true });
    const recent = s.decisions().slice(-15).map((d) => `  ${d.id} [${d.by}] ${d.title}`).join("\n");
    return {
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext:
          "Understand is recording decisions in this repo (.understand/). Follow the understand:record skill: " +
          "after the edits for each design choice (yours or the user's), run `understand decide` naming what it shaped with --for. " +
          "Paraphrase, never quote the user." +
          (recent ? `\nDecisions recorded so far:\n${recent}` : ""),
      },
    };
  },

  "pre-tool-use"(s, p) {
    const session = p.session_id ?? null;
    touchSession(s, session);
    // Changes since the last capture weren't made by an observed tool: close them off as unverified.
    capture(s, { session, tool: "checkpoint", unverified: true });
  },

  "post-tool-use"(s, p) {
    const session = p.session_id ?? null;
    const tool = p.tool_name ?? "";
    const input = p.tool_input ?? {};
    const file = FILE_TOOLS.has(tool) ? relFile(s.root, input.file_path ?? input.notebook_path) : null;
    capture(s, { session, tool, command: tool === "Bash" ? String(input.command ?? "") : undefined, ...(FILE_TOOLS.has(tool) ? { only: file ?? "\0" } : {}) });
    if (file && isIgnored(s.root, file)) s.addIgnoredWrite(file);
  },

  stop(s, p) {
    const session = p.session_id ?? null;
    let captureError = "";
    try {
      capture(s, { session, tool: "checkpoint", unverified: true });
    } catch (err) {
      captureError = ` (Understand also couldn't snapshot the worktree: ${(err as Error).message})`;
    }
    const pending = s.unlinkedEdits(session);
    if (pending.length && !p.stop_hook_active) {
      const files = [...new Set(pending.flatMap((e) => e.files))];
      return {
        decision: "block",
        reason:
          `Understand: ${pending.length} edit${pending.length > 1 ? "s" : ""} this session ha${pending.length > 1 ? "ve" : "s"} no recorded decision ` +
          `(${files.slice(0, 6).join(", ")}${files.length > 6 ? ", …" : ""}). ` +
          "If they came from a decision you already recorded, run `understand link D<n> --for <file>:<Symbol>`. " +
          "Otherwise record why with `understand decide --title … --why … --by agent|human --for <file>:<Symbol>`, " +
          "or `understand decide --mechanical --title …` if they were mechanical. Then finish your reply." + captureError,
      };
    }
    s.updateState((st) => {
      if (session) st.sessions[session] = { hooked: true, turn: (st.sessions[session]?.turn ?? 0) + 1 };
    });
  },
};

/** Resolve symlinks on both sides (e.g. macOS /var → /private/var) so tool paths match git's root. */
function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; }
  }
}

function relFile(root: string, p: unknown): string | null {
  if (typeof p !== "string" || !p) return null;
  const rel = relative(real(root), real(isAbsolute(p) ? p : resolve(root, p)));
  if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  if (rel === ".understand" || rel.startsWith(".understand" + sep)) return null;
  return rel;
}
