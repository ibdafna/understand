import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { capture } from "./capture.js";
import { extract, type Extract } from "./extract/index.js";
import { currentBranch, excludeLogDir, pinTree, repoRoot, snapshot, treeOf } from "./git.js";
import { runHook } from "./hook.js";
import { check, readNarration } from "./narration.js";
import { renderHtml } from "./render.js";
import { Store, type Decider } from "./store.js";

const HELP = `understand: record why code changed, then render a reviewable explanation.

Usage:
  understand init [--base <ref>] [--force]   Start recording (baseline = current worktree, or <ref> to widen the diff)
  understand decide --title <t> --why <w> [--by agent|human] [--for <file>[:<Symbol>]]... [--alt <a>]...
                   [--supersedes <Dn>] [--mechanical]
                                             Record a decision; it explains every edit not yet linked to one
  understand link <Dn> [--for <file>[:<Symbol>]]...
                                             Attach unlinked edits to a decision recorded earlier
  understand status                          Decisions, edits, and edits still missing a decision
  understand decisions                       List every recorded decision
  understand extract                         Symbol-level diff vs. baseline → .understand/extract.json
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

const BOOL = new Set(["force", "mechanical", "open", "help"]);
const VALUE = new Set(["title", "why", "by", "alt", "for", "supersedes", "base", "out"]);
type Flags = Record<string, string[]>;

function parse(argv: string[]): { cmd: string; args: string[]; flags: Flags } {
  const [cmd = "help", ...rest] = argv;
  const flags: Flags = {}, args: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--") || a === "--") { args.push(a); continue; }
    const eq = a.indexOf("=");
    const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
    if (BOOL.has(k)) {
      if (eq > 0) fail(`--${k} takes no value`);
      (flags[k] ??= []).push("true");
    } else if (VALUE.has(k)) {
      const v = eq > 0 ? a.slice(eq + 1) : rest[++i];
      if (v === undefined) fail(`--${k} needs a value`);
      (flags[k] ??= []).push(v);
    } else fail(`unknown option --${k}. Run \`understand help\`.`);
  }
  return { cmd, args, flags };
}

const one = (f: Flags, k: string) => f[k]?.[f[k].length - 1];

function fail(msg: string): never {
  process.stderr.write(`understand: ${msg}\n`);
  process.exit(1);
}

function store(): Store {
  const root = repoRoot(process.cwd());
  if (!root) fail("not inside a git repository");
  return new Store(root);
}

function ready(): Store {
  const s = store();
  if (!s.exists()) fail("not recording here yet. Run `understand init` first.");
  s.config();
  return s;
}

/** The calling agent's session: Claude Code exports it to commands; otherwise fall back to the latest hook. */
function sessionOf(s: Store): string | null {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || s.state().lastHookSession || null;
}

function newId() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14) + "-" + randomBytes(3).toString("hex");
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
      // Validate everything before touching an existing recording.
      const baseRef = one(flags, "base");
      let baseTree: string | null = null;
      if (baseRef) {
        try { baseTree = treeOf(s.root, baseRef); } catch { fail(`--base ${baseRef}: not a commit or tree`); }
      }
      s.withLock(() => {
        mkdirSync(s.dir, { recursive: true });
        excludeLogDir(s.root);
        const fresh = !existsSync(s.path("config.json"));
        if (fresh) rmSync(s.path("index"), { force: true }); // seed from the real index
        // Everything that can fail happens before the old recording is touched.
        const tree = snapshot(s);
        const id = newId();
        const baseRefName = `refs/understand/${id}`;
        const base = pinTree(s.root, baseTree ?? tree, baseRefName);
        if (!fresh) archive(s);
        s.writeState({ lastTree: tree, sessions: {} });
        s.writeConfig({ version: 2, id, base, baseRef: baseRefName, initTree: tree, branch: currentBranch(s.root), createdAt: new Date().toISOString() });
        console.log(
          `Recording in ${s.root}. Baseline: ${baseRef ?? "current worktree"} (${base.slice(0, 8)}). Log: .understand/ (git-excluded)` +
            (baseRef ? "\nChanges already between the baseline and now will show as \"before recording\": their reasons weren't captured." : ""),
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
      const by = (one(flags, "by") ?? "agent") as Decider;
      if (by !== "agent" && by !== "human") fail("--by must be agent or human");
      const supersedes = one(flags, "supersedes");
      if (supersedes && !s.decisions().some((d) => d.id === supersedes)) fail(`--supersedes ${supersedes}: no such decision`);
      const d = s.withLock(() => {
        const session = sessionOf(s);
        // Changes since the last capture happened inside the agent's own command (or, without hooks,
        // since its last decision): they are the agent's.
        capture(s, { session, tool: s.session(s.state(), session).hooked ? "Bash" : "checkpoint", command: "(changes made in the same command as `understand decide`)" });
        const adopts = s.unlinkedEdits(session).map((e) => e.id);
        return s.addDecision({
          ts: new Date().toISOString(), session, turn: s.session(s.state(), session).turn, title, why, by,
          alternatives: flags.alt ?? [],
          ...(flags.for ? { for: flags.for, claimable: s.turnEdits(session).map((e) => e.id) } : {}),
          ...(supersedes ? { supersedes } : {}),
          ...(mechanical ? { mechanical } : {}),
          adopts,
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
        const adopts = s.unlinkedEdits(session).map((e) => e.id);
        s.addLink({ decision: id, ts: new Date().toISOString(), session, turn: s.session(s.state(), session).turn, adopts, ...(flags.for ? { for: flags.for, claimable: s.turnEdits(session).map((e) => e.id) } : {}) });
        return adopts;
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
      writeFileSync(s.path("extract.json"), JSON.stringify(x, null, 2));
      printExtract(x);
      console.log(`\nFull detail (with code and per-line provenance): .understand/extract.json`);
      return;
    }

    case "check": {
      const s = ready();
      const n = readNarration(s.path("narration.json"));
      if (!n) fail("no .understand/narration.json yet");
      const x = await extract(s);
      const r = check(x, n);
      for (const e of r.errors) console.log(`error: ${e}`);
      if (r.missing.length) console.log(`not narrated or not in a chapter (${r.missing.length}):\n  ${r.missing.join("\n  ")}`);
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
        if (r.errors.length) fail(`narration is invalid (${r.errors.length} errors); fix them first:\n  ${r.errors.join("\n  ")}`);
        if (r.missing.length) process.stderr.write(`warning: ${r.missing.length} symbols aren't narrated; they'll be listed under "Not placed in the story".\n`);
      }
      const html = renderHtml(x, n);
      const outFlag = one(flags, "out");
      const out = outFlag ? resolve(outFlag) : s.path("reports", `understand-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, html);
      if (!outFlag) copyFileSync(out, s.path("reports", "latest.html"));
      console.log(out);
      if (flags.open) {
        try {
          execFileSync(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [out]);
        } catch {}
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

/** Move the current recording aside; its baseline ref stays so the archive remains readable. */
function archive(s: Store) {
  let id = "unknown";
  try { id = s.config().id ?? id; } catch {}
  const dest = s.path("archive", `${id}-${randomBytes(2).toString("hex")}`);
  mkdirSync(dest, { recursive: true });
  for (const f of ["decisions.jsonl", "edits.jsonl", "links.jsonl", "ignored.jsonl", "state.json", "narration.json", "config.json"]) {
    if (existsSync(s.path(f))) renameSync(s.path(f), join(dest, f));
  }
}

function printExtract(x: Extract) {
  const byFile = new Map<string, typeof x.symbols>();
  for (const s of x.symbols) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  console.log(`${x.symbols.length} changed symbols in ${byFile.size} files; ${x.decisions.length} decisions.`);
  for (const [file, syms] of byFile) {
    const f = x.files[file];
    console.log(`\n${file} (${f.status}${f.note ? `, ${f.note}` : ""})`);
    for (const s of syms) {
      const plus = s.rows.filter((r) => r.t === "+").length, minus = s.rows.filter((r) => r.t === "-").length;
      const tags = [
        s.decisions.length ? s.decisions.join(",") : "",
        s.gaps.outside ? "OUTSIDE" : "",
        s.gaps.before ? "BEFORE-RECORDING" : "",
        s.gaps.unlinked.length ? "UNEXPLAINED" : "",
      ].filter(Boolean).join(" ");
      console.log(`  ${s.id}\n      ${s.status}${s.movedFrom ? ` from ${s.movedFrom}` : ""} ${s.kind} +${plus}/-${minus} [${tags || "?"}]${s.note ? ` (${s.note})` : ""}`);
    }
  }
  if (x.ignoredWrites.length) console.log(`\nWritten by the agent but ignored by git (not in the diff): ${x.ignoredWrites.join(", ")}`);
}

main().catch((e) => fail((e as Error).message ?? String(e)));
