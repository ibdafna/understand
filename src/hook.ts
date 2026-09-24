import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { capture } from "./capture.js";
import { drain } from "./decide.js";
import { writeLog } from "./decisionlog.js";
import { extract } from "./extract/index.js";
import { branchBornSince, currentBranch, isIgnored, repoRoot } from "./git.js";
import { Home, understandHome } from "./home.js";

interface Payload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: any;
  tool_use_id?: string;
  stop_hook_active?: boolean;
}

const FILE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "apply_patch"]);

/** The files a file tool says it changes. Codex's apply_patch names them only inside the patch text. */
function toolFiles(root: string, tool: string, input: any): string[] {
  if (tool === "apply_patch") {
    const patch = String(input.command ?? input.patch ?? input.input ?? "");
    const paths = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)].map((m) => (m[1] ?? m[2]).trim());
    return paths.map((p) => relFile(root, p)).filter((p): p is string => !!p);
  }
  const file = relFile(root, input.file_path ?? input.notebook_path);
  return file ? [file] : [];
}
const PR_CREATE = /\bgh\b[^\n;&|]*\bpr\s+create\b/;
const COMMIT = /\bgit\b[^\n;&|]*\bcommit\b/;
/** Unexplained edits this small don't interrupt the agent (they still show as unexplained). */
const TRIVIAL_LINES = 3;

/** Injected at every session start (including after compaction), so nothing needs to be invoked. */
const RULES = `Understand keeps a decision log of this session for code review.
After the edits for each design choice (yours, or one the user made), run:
  understand decide --by agent|human --title "<the choice>" --why "<the reason, paraphrased>" \\
    --for <file>:<Symbol>   (repeat for every function, method, type, and import it shaped; a bare <file> covers the whole file)
    [--alt "<rejected option>: <why not>"] [--risk "<assumption or risk>"]
A decision explains only what it names. Record it right after its edits; one decision per distinct choice.
Mechanical batches: \`understand decide --mechanical --title … --for …\`. Edits that follow a decision you recorded
earlier: \`understand link D<n> --for …\`. Paraphrase; never quote the user. Decisions are also written to .decisions/ in
the repo and committed with your commits, so keep them free of secrets. The understand:record skill has details.
After opening a pull request, use the understand:explain skill to produce its review page.
If the user doesn't want this in a repo, \`understand off\` stops it there (\`--everywhere\` for all repos).`;

/** Entry point for `understand hook <event>`. Hook errors never break the session, but they are never silent. */
export async function runHook(event: string) {
  let home: Home | null = null;
  try {
    const p: Payload = JSON.parse(readFileSync(0, "utf8") || "{}");
    const root = repoRoot(p.cwd || process.cwd());
    if (!root) return;
    home = Home.forRepo(root);
    if (home.isOff()) return;
    if (process.env.UNDERSTAND_DEBUG) log("hook-payloads.jsonl", JSON.stringify({ event, ...p }));
    const out = await handlers[event]?.(home, p);
    if (out) process.stdout.write(JSON.stringify(out));
  } catch (err) {
    if (home) log("hook-errors.log", `${new Date().toISOString()} ${event} ${(err as Error).stack}`);
    process.stderr.write(`understand: recording failed during ${event}: ${(err as Error).message}\n`);
    if (event === "stop") process.stdout.write(JSON.stringify({ systemMessage: `Understand could not check this turn: ${(err as Error).message}` }));
  }
}

function log(file: string, line: string) {
  try {
    mkdirSync(understandHome(), { recursive: true, mode: 0o700 });
    appendFileSync(join(understandHome(), file), line + "\n");
  } catch {}
}

const context = (hookEventName: string, additionalContext: string) => ({ hookSpecificOutput: { hookEventName, additionalContext } });

const handlers: Record<string, (h: Home, p: Payload) => object | void | Promise<object | void>> = {
  "session-start"(home, p) {
    const session = p.session_id ?? null;
    drain(home);
    home.update((st) => { if (session) st.lastHookSession = session; });
    const rec = home.active(session);
    // Whatever changed while no agent was running is not the agent's work.
    if (rec) capture(rec, { session, tool: "checkpoint", unverified: true });
    const recent = rec?.decisions().slice(-15).map((d) => `  ${d.id} [${d.by}] ${d.title}`).join("\n");
    return context("SessionStart", RULES + cliNote() + (recent ? `\nDecisions already recorded here:\n${recent}` : ""));
  },

  "pre-tool-use"(home, p) {
    const session = p.session_id ?? null;
    drain(home);
    home.update((st) => {
      if (!session) return;
      st.lastHookSession = session;
      st.pre[session] = { scope: home.scope(session), since: Math.floor(Date.now() / 1000) };
    });
    // Changes since the last capture weren't made by an observed tool: close them off as unverified.
    const rec = home.recording(session);
    capture(rec, { session, tool: "checkpoint", unverified: true });
    // The agent is committing: include the shared decision log, so the commit carries its reasons.
    if (p.tool_name === "Bash" && COMMIT.test(String(p.tool_input?.command ?? ""))) stageLog(home.root, writeLog(rec));
  },

  /** Also runs for failed tool calls (PostToolUseFailure): a command that errors after writing files still wrote them. */
  "post-tool-use"(home, p) {
    const session = p.session_id ?? null;
    const tool = p.tool_name ?? "";
    const input = p.tool_input ?? {};
    const command = tool === "Bash" ? String(input.command ?? "") : "";
    const pre = session ? home.state().pre[session] : undefined;
    home.update((st) => { if (session) delete st.pre[session]; });
    const scope = home.scope(session);
    if (pre && pre.scope !== scope) {
      const branch = currentBranch(home.root);
      if (branch && branchBornSince(home.root, branch, pre.since)) {
        // This command created or renamed the branch (`git switch -c`, `git branch -m`): the work moved,
        // so the recording follows it and the command's own edits are captured as usual.
        home.carry(pre.scope, scope);
      } else {
        // A switch to other existing code: start from its committed state; whatever else changed is unverified.
        capture(home.recording(session, home.headTree() ?? undefined), { session, tool: "branch switch", unverified: true });
        return;
      }
    }
    const rec = home.recording(session);
    const files = FILE_TOOLS.has(tool) ? toolFiles(home.root, tool, input) : null;
    capture(rec, {
      session, tool, transcript: p.transcript_path ?? undefined, toolUseId: p.tool_use_id,
      ...(command ? { command } : {}),
      ...(files ? { only: files } : {}),
    });
    for (const f of files ?? []) if (isIgnored(home.root, f)) rec.addIgnoredWrite(f);
    // Decisions the command queued (it couldn't write our state from inside a sandbox) are filed now,
    // after its own changes were captured, exactly as if it had filed them itself.
    const problems = drain(home);
    if (problems.length) return context("PostToolUse", `Understand couldn't record: ${problems.join("; ")}`);
    if (PR_CREATE.test(command) && p.hook_event_name === "PostToolUse") {
      return context("PostToolUse", "Understand: you opened a pull request. Now use the understand:explain skill to write its review page against the PR's base branch, then add a short summary to the PR description with `gh pr edit`.");
    }
  },

  async stop(home, p) {
    const session = p.session_id ?? null;
    drain(home);
    const endTurn = () => home.update((st) => { if (session) st.turns[session] = (st.turns[session] ?? 0) + 1; });
    const rec = home.active(session);
    if (!rec) return endTurn();
    let captureError = "";
    try {
      capture(rec, { session, tool: "checkpoint", unverified: true });
    } catch (err) {
      captureError = ` (Understand also couldn't snapshot the worktree: ${(err as Error).message})`;
    }
    // Which symbols did this turn's edits change without any decision naming them?
    const turn = new Set(rec.turnEdits(session).map((e) => e.id));
    const unnamed = turn.size && !p.stop_hook_active
      ? (await extract(rec)).symbols.filter((s) => s.gaps.unlinked.some((id) => turn.has(id)))
      : [];
    // Size of what's unexplained, not of the whole symbol. Changes without countable lines (a mode,
    // a binary, a submodule, a moved symbol) always count as worth asking about.
    const weight = unnamed.reduce((n, s) => {
      const lines = s.rows.filter((r) => (r.t === "+" || r.t === "-") && r.p && s.gaps.unlinked.includes(r.p) && turn.has(r.p)).length;
      return n + (lines || TRIVIAL_LINES + 1);
    }, 0);
    if (weight > TRIVIAL_LINES) {
      const names = unnamed.map((s) => `${s.file}:${s.kind === "other" || s.kind === "file" ? "" : s.name}`.replace(/:$/, ""));
      return {
        decision: "block",
        reason:
          `Understand: this turn changed ${unnamed.length} symbol${unnamed.length > 1 ? "s" : ""} no decision names: ` +
          `${names.slice(0, 12).join(", ")}${names.length > 12 ? ", …" : ""}. ` +
          "Name each on the decision it belongs to with `understand link D<n> --for <file>:<Symbol>`, " +
          "record a new one with `understand decide … --for …`, or use `understand decide --mechanical --title … --for …`. Then finish your reply." + captureError,
      };
    }
    endTurn();
  },
};

/**
 * Claude Code puts a plugin's bin/ on the agent's PATH; Codex doesn't (it sets PLUGIN_ROOT for hooks
 * instead). There, tell the agent the full path to use wherever the rules and skills say `understand`.
 */
function cliNote(): string {
  if (!process.env.PLUGIN_ROOT) return "";
  return `\nIn this environment run the CLI as \`${join(process.env.PLUGIN_ROOT, "bin", "understand")}\` wherever these rules or the skills say \`understand\`.`;
}

function stageLog(root: string, log: string | null) {
  if (!log) return;
  try {
    execFileSync("git", ["-C", root, "add", "--", log], { stdio: "ignore" });
  } catch {}
}

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
  return rel;
}
