import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { file, enqueue, isWriteDenied, type Entry } from "./decide.js";
import { readLogs } from "./decisionlog.js";
import { check, readExplanation } from "./explanation.js";
import { extract, rangeKey, type Extract, type Range } from "./extract/index.js";
import { repoRoot } from "./git.js";
import { Home, understandHome } from "./home.js";
import { runHook } from "./hook.js";
import { renderHtml } from "./render.js";
import type { Decider, Store } from "./store.js";

const HELP = `understand: keep a decision log while an agent codes, then explain the diff symbol by symbol.

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
  <range>:  --pr <ref>          a pull request: merge-base with <ref> → HEAD
            --branch            this branch: merge-base with trunk → working tree (committed and not)
            --staged            HEAD → the staged changes
            --uncommitted       HEAD → working tree
            --commits <a..b>    a commit range, or one commit
            (none)              where recording started → working tree

Control:
  understand status | where                  What's recorded here, and where it's stored
  understand reset                           End this branch's recording; the next edit starts a new one
  understand off | on [--everywhere]         Stop or resume recording in this repo (or all repos)

State lives in ${"$"}UNDERSTAND_HOME (default ~/.claude/understand), never inside the repo.
`;

const BOOL = new Set(["mechanical", "open", "everywhere", "branch", "staged", "uncommitted"]);
const VALUE = new Set(["title", "why", "by", "alt", "for", "risk", "supersedes", "out", "pr", "commits"]);
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

function rangeOf(flags: Flags): Range {
  const pr = one(flags, "pr");
  const picked: Range[] = [
    ...(pr ? [{ kind: "pr" as const, ref: pr }] : []),
    ...(flags.branch ? [{ kind: "branch" as const }] : []),
    ...(flags.staged ? [{ kind: "staged" as const }] : []),
    ...(flags.uncommitted ? [{ kind: "uncommitted" as const }] : []),
    ...(one(flags, "commits") ? [{ kind: "commits" as const, spec: one(flags, "commits")! }] : []),
  ];
  if (picked.length > 1) fail("pick one range: --pr, --branch, --staged, --uncommitted, or --commits");
  return picked[0] ?? { kind: "recording" };
}

/** The recording to explain from, or (no local recording) the repo home, which reads the checked-in decision log. */
function source(h: Home): Store | Home {
  return h.active(sessionOf(h)) ?? h;
}
const dirOf = (src: Store | Home) => (src instanceof Home ? src.path("shared") : src.dir);
const explanationPath = (src: Store | Home, r: Range) => join(dirOf(src), "explanations", `${rangeKey(r)}.json`);

function home(): Home {
  const root = repoRoot(process.cwd());
  if (!root) fail("not inside a git repository");
  return Home.forRepo(root);
}

/** The calling agent's session: Claude Code exports it to commands; otherwise fall back to the latest hook. */
function sessionOf(h: Home): string | null {
  return process.env.CLAUDE_CODE_SESSION_ID || process.env.CODEX_SESSION_ID || process.env.CLAUDE_SESSION_ID || h.state().lastHookSession || null;
}

/** `--for` specs must name a file; `file:Symbol` narrows to a symbol. */
function forSpecs(flags: Flags): string[] {
  const specs = (flags.for ?? []).map((s) => s.trim()).filter(Boolean);
  if (!specs.length) fail("--for is required: name each file or file:Symbol this decision shaped (a decision explains only what it names)");
  for (const s of specs) {
    if (s.startsWith(":")) fail(`--for ${s}: name a file, e.g. --for src/api.ts:fetchJSON`);
    if (s.endsWith(":")) fail(`--for ${s}: name the symbol after the colon, or drop the colon to name the whole file`);
  }
  return specs;
}

/**
 * File a decision or link. While a hooked tool call of this session is open, changes since the last
 * capture came from that same command; otherwise (a person's terminal) their origin is unknown. When
 * the command may not write Understand's state (a sandbox), queue it for the next hook. Returns the id
 * when filed now.
 */
function record(h: Home, e: Entry): { id: string; log: string | null } | null {
  try {
    const open = !!e.session && !!h.state().pre[e.session];
    return file(h, e, open ? "own" : "unknown");
  } catch (err) {
    if (!isWriteDenied(err)) fail((err as Error).message);
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
      const by = (one(flags, "by") ?? "agent") as Decider;
      if (by !== "agent" && by !== "human") fail("--by must be agent or human");
      const input = {
        title, why, by, alternatives: flags.alt ?? [], risks: flags.risk ?? [], for: forSpecs(flags),
        ...(one(flags, "supersedes") ? { supersedes: one(flags, "supersedes") } : {}),
        ...(mechanical ? { mechanical } : {}),
      };
      const done = record(h, { kind: "decide", session: sessionOf(h), ts: new Date().toISOString(), input });
      console.log(!done ? `Recorded for ${input.for.join(", ")}; it will be filed into the log when this command finishes.`
        : `${done.id} recorded for ${input.for.join(", ")}.${done.log ? ` Shared log: ${done.log} (committed with your changes).` : ""}`);
      return;
    }

    case "link": {
      const h = home();
      const id = args[0];
      if (!id) fail("usage: understand link <Dn> --for <file>[:<Symbol>]...");
      const specs = forSpecs(flags);
      record(h, { kind: "link", session: sessionOf(h), ts: new Date().toISOString(), decision: id, for: specs });
      console.log(`${id} now also explains ${specs.join(", ")}.`);
      return;
    }

    case "decisions": {
      const src = source(home());
      const list = src instanceof Home ? readLogs(src.root) : src.decisions();
      if (src instanceof Home) console.log(list.length ? "(from the decision log checked into .decisions/)" : "No decisions recorded here, locally or in .decisions/.");
      for (const d of list) {
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
      const file = flags.everywhere ? join(understandHome(), "off") : home().path("off");
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      if (cmd === "off") writeFileSync(file, new Date().toISOString() + "\n");
      else rmSync(file, { force: true });
      if (cmd === "on" && !flags.everywhere && home().isOff()) console.log("Recording is still off here: `understand off --everywhere` (or UNDERSTAND_DISABLE) applies to every repo. Run `understand on --everywhere`.");
      else console.log(`Recording is ${cmd}${flags.everywhere ? " everywhere" : " in this repo"}.`);
      return;
    }

    case "extract": {
      const src = source(home());
      const range = rangeOf(flags);
      const x = await extract(src, range);
      mkdirSync(dirOf(src), { recursive: true });
      writeFileSync(join(dirOf(src), "extract.json"), JSON.stringify(x, null, 2));
      printExtract(x);
      console.log(`\nFull detail (code and per-line provenance): ${join(dirOf(src), "extract.json")}`);
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
      if (r.missing.length) console.log(`not explained or not in a chapter (${r.missing.length}):\n  ${r.missing.join("\n  ")}`);
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
        if (r.errors.length) fail(`explanation is invalid (${r.errors.length} errors); fix them first:\n  ${r.errors.join("\n  ")}`);
        if (r.missing.length) process.stderr.write(`warning: ${r.missing.length} symbols aren't explained; they'll be listed separately.\n`);
      }
      const outFlag = one(flags, "out");
      const out = outFlag ? resolve(outFlag) : join(dirOf(src), "reports", `understand-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.html`);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, renderHtml(x, n));
      if (!outFlag) copyFileSync(out, join(dirOf(src), "reports", "latest.html"));
      console.log(out);
      if (flags.open) {
        try {
          execFileSync(process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open", [out]);
        } catch {}
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

function printExtract(x: Extract) {
  const byFile = new Map<string, typeof x.symbols>();
  for (const s of x.symbols) byFile.set(s.file, [...(byFile.get(s.file) ?? []), s]);
  console.log(`${x.symbols.length} changed symbols in ${byFile.size} files (${x.baseLabel} → ${x.headLabel}); ${x.decisions.length} decisions.`);
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

main().catch((e) => {
  if (isWriteDenied(e)) {
    fail(`this command can't write Understand's state (${understandHome()}), probably because of a sandbox. ` +
      "Run it again with permission to write outside the workspace (in Codex, request escalated permissions), " +
      "or add that folder to Codex's `sandbox_workspace_write.writable_roots`.");
  }
  fail((e as Error).message ?? String(e));
});
