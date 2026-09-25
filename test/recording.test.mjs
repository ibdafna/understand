// The recording model end to end: automatic capture, explicit decisions, provenance, PR diffs, the page.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, manifestCommands, repo, started, symbolFinder } from "./helpers.mjs";

test("the manifest brackets every observed tool and injects the rules at session start", () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) {
    assert.deepEqual(manifestCommands("PreToolUse", tool), ["pre-tool-use"], tool);
    assert.deepEqual(manifestCommands("PostToolUse", tool), ["post-tool-use"], tool);
  }
  assert.deepEqual(manifestCommands("Stop", ""), ["stop"]);
  const t = repo();
  try {
    t.commit();
    const ctx = JSON.parse(t.hook("session-start")).hookSpecificOutput.additionalContext;
    assert.match(ctx, /understand decide/);
    assert.match(ctx, /understand:explain/);
  } finally {
    t.cleanup();
  }
});

test("recording starts at the first tool call, and nothing lands in the repo", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    const refsBefore = t.sh("git", ["for-each-ref"]);
    const objectsBefore = t.sh("git", ["count-objects", "-v"]);
    assert.equal(t.recDir().includes("/recordings/"), false, "a session start alone records nothing");
    t.edit("a.ts", "a = 1", "a = 2");
    assert.ok(t.recDir().includes("/recordings/"));
    t.u("decide", "--title", "Bump a", "--why", "w", "--for", "a.ts:a");
    t.hook("stop");
    assert.equal(t.sh("git", ["for-each-ref"]), refsBefore, "no refs added");
    assert.equal(t.sh("git", ["count-objects", "-v"]), objectsBefore, "no objects written into the repo");
    assert.equal(existsSync(join(t.dir, ".understand")), false);
    assert.equal(t.sh("git", ["status", "--short"]).trim(), "M a.ts\n?? .decisions/", "only the shared decision log, by design");
  } finally {
    t.cleanup();
  }
});

test("a decision explains only what it names; the stop hook asks about the rest", () => {
  const t = started({ "auth.ts": "export function check() {\n  return true;\n}\n", "fmt.ts": "export const w = 1;\n" });
  try {
    t.edit("auth.ts", "return true;", "if (!token) {\n    return false;\n  }\n  return verify(token);");
    t.edit("fmt.ts", "w = 1", "w = 2");
    assert.match(t.uFail("decide", "--title", "Wider", "--why", "w").stderr, /--for is required/);
    t.u("decide", "--title", "Wider output", "--why", "Readability", "--for", "fmt.ts");
    const block = JSON.parse(t.hook("stop"));
    assert.equal(block.decision, "block");
    assert.match(block.reason, /auth\.ts/);
    assert.doesNotMatch(block.reason, /fmt\.ts/);
    t.u("decide", "--by", "human", "--title", "Require a token", "--why", "User asked to reject anonymous calls", "--for", "auth.ts:check", "--risk", "verify() may throw");
    assert.equal(t.hook("stop"), "");
    const by = symbolFinder(t.extract());
    assert.deepEqual(by("fmt.ts#var:w").decisions, ["D1"]);
    assert.deepEqual(by("auth.ts#func:check").decisions, ["D2"]);
    assert.equal(by("auth.ts#func:check").explained, true);
  } finally {
    t.cleanup();
  }
});

test("tiny unexplained edits don't interrupt, but stay flagged", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    assert.equal(t.hook("stop"), "");
    assert.equal(symbolFinder(t.extract())("a.ts#var:a").explained, false);
  } finally {
    t.cleanup();
  }
});

test("a decision can't explain edits made after it, or edits from an earlier turn", () => {
  const t = started({ "a.ts": "export function f() {\n  return 1;\n}\n", "b.ts": "export const b = 1;\n" });
  try {
    t.u("decide", "--title", "Early", "--why", "w", "--for", "a.ts:f");
    t.edit("a.ts", "return 1", "return 2");
    const f = symbolFinder(t.extract())("a.ts#func:f");
    assert.equal(f.explained, false, "recorded before the edit existed");
    assert.deepEqual(f.later, ["D1"]);
    t.u("link", "D1", "--for", "a.ts:f");
    assert.equal(symbolFinder(t.extract())("a.ts#func:f").explained, true, "link names it afterwards, same turn");

    t.edit("b.ts", "b = 1", "b = 2");
    t.hook("stop", { stop_hook_active: true }); // turn ends with b unexplained
    t.edit("a.ts", "return 2", "return 3");
    t.u("decide", "--title", "Late", "--why", "w", "--for", "b.ts", "--for", "a.ts:f");
    const by = symbolFinder(t.extract());
    assert.equal(by("b.ts#var:b").explained, false, "an earlier turn stays closed");
    assert.equal(by("a.ts#func:f").explained, true);
  } finally {
    t.cleanup();
  }
});

test("manual edits and watcher side effects are never credited to the agent; failed commands still are", () => {
  const t = started({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n", "gen.ts": "export const g = 1;\n", "c.ts": "export const c = 1;\n" });
  try {
    t.bash("git status --porcelain=v2 > /dev/null"); // any mutating-capable call starts the recording
    t.write("b.ts", "export const b = 2;\n"); // a person, in their editor
    const cur = t.read("a.ts");
    t.tool("Edit", { file_path: join(t.dir, "a.ts"), old_string: "a = 1", new_string: "a = 2" }, () => {
      t.write("a.ts", cur.replace("a = 1", "a = 2"));
      t.write("gen.ts", "export const g = 2;\n"); // a watcher reacting to the edit
    });
    // A command that writes a file and then fails: Claude Code sends PostToolUseFailure.
    const payload = { tool_name: "Bash", tool_input: { command: "python3 fix.py && false" }, tool_use_id: "toolu_fail" };
    for (const cmd of manifestCommands("PreToolUse", "Bash")) t.hook(cmd, payload);
    t.write("c.ts", "export const c = 2;\n");
    assert.deepEqual(manifestCommands("PostToolUseFailure", "Bash"), ["post-tool-use"]);
    for (const cmd of manifestCommands("PostToolUseFailure", "Bash")) t.hook(cmd, payload);
    t.u("decide", "--title", "Everything", "--why", "w", "--for", "a.ts", "--for", "b.ts", "--for", "gen.ts", "--for", "c.ts");
    const by = symbolFinder(t.extract());
    assert.equal(by("a.ts#var:a").explained, true);
    assert.equal(by("c.ts#var:c").explained, true, "a failed command's writes are still the agent's");
    assert.equal(by("b.ts#var:b").gaps.outside, true);
    assert.equal(by("gen.ts#var:g").gaps.outside, true);
  } finally {
    t.cleanup();
  }
});

test("a feature branch is one recording across sessions; trunk sessions are separate", () => {
  const t = started({ "a.ts": "export const a = 1;\n" }, { branch: null });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    const onMain = t.recDir();
    t.sh("git", ["checkout", "-q", "-b", "feature"]);
    t.edit("a.ts", "a = 2", "a = 3");
    const feature = t.recDir();
    assert.notEqual(feature, onMain);
    // A new session on the same branch continues the same recording.
    const env2 = { ...t.env, CLAUDE_CODE_SESSION_ID: "sess-2" };
    const where2 = () => spawnSync(CLI, ["where"], { cwd: t.dir, env: env2, encoding: "utf8" }).stdout.trim();
    assert.equal(where2(), feature);
    t.sh("git", ["checkout", "-q", "main"]);
    assert.notEqual(where2(), onMain, "trunk recordings are per session");
  } finally {
    t.cleanup();
  }
});

test("switching branches is not recorded as an edit", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.sh("git", ["checkout", "-q", "-b", "other"]);
    t.write("a.ts", "export const a = 9;\n");
    t.commit("other work");
    t.sh("git", ["checkout", "-q", "feature"]);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100); // reflog times have one-second resolution
    t.edit("a.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "Bump", "--why", "w", "--for", "a.ts");
    t.bash("git commit -am bump", () => t.commit("bump"));
    t.bash("git checkout other", () => t.sh("git", ["checkout", "-q", "other"]));
    t.bash("git checkout feature", () => t.sh("git", ["checkout", "-q", "feature"]));
    const x = t.extract();
    assert.deepEqual(x.symbols.map((s) => `${s.id} ${s.explained}`), ["a.ts#var:a true"]);
  } finally {
    t.cleanup();
  }
});

test("a PR page covers merge-base → HEAD: earlier commits are 'before recording', uncommitted work is left out", () => {
  const t = started({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
  try {
    // Committed on the branch before Understand saw anything.
    t.write("b.ts", "export const b = 2;\n");
    t.commit("pre-recording work");
    t.edit("a.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "Bump a", "--why", "w", "--for", "a.ts:a");
    t.bash("git commit -am 'bump a'", () => t.commit("bump a"));
    t.edit("a.ts", "a = 2", "a = 3"); // not committed
    const out = t.bash("gh pr create --fill");
    assert.match(out, /understand:explain/);
    const by = symbolFinder(t.extract("--against", "main"));
    assert.equal(by("b.ts#var:b").gaps.before, true);
    const a = by("a.ts#var:a");
    assert.ok(a.rows.some((r) => r.t === "+" && r.s.includes("a = 2")), "HEAD's committed content");
    assert.ok(!a.rows.some((r) => r.s.includes("a = 3")), "uncommitted edit is not in the PR");
    assert.deepEqual(a.decisions, ["D1"]);
  } finally {
    t.cleanup();
  }
});

test("the explanation: every symbol needs a summary; later links never clear a gap; invalid values are refused", () => {
  const t = started({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    t.edit("b.ts", "b = 1", "b = 2");
    t.u("decide", "--title", "Bump a", "--why", "w", "--for", "a.ts", "--risk", "Callers assume 1");
    t.hook("stop", { stop_hook_active: true });
    const dir = t.recDir();
    mkdirSync(join(dir, "explanations"), { recursive: true });
    const expl = {
      title: "T", intent: "I",
      symbols: {
        "a.ts#var:a": { summary: "Bumped.", attention: "careful", attentionReason: "changes a default", risk: "Noticed later" },
        "b.ts#var:b": { summary: "Also bumped.", attention: "mechanical", attentionReason: "a value bump", decisions: ["D1"] },
      },
    };
    writeFileSync(join(dir, "explanations", "recording.json"), JSON.stringify({ ...expl, symbols: { "a.ts#var:a": expl.symbols["a.ts#var:a"] } }));
    assert.match(t.uFail("check").stdout, /not explained or not in a chapter \(1\)/);
    writeFileSync(join(dir, "explanations", "recording.json"), JSON.stringify(expl));
    assert.match(t.u("check"), /^OK/);
    const { attentionReason, ...noReason } = expl.symbols["a.ts#var:a"];
    writeFileSync(join(dir, "explanations", "recording.json"), JSON.stringify({ ...expl, symbols: { ...expl.symbols, "a.ts#var:a": noReason } }));
    assert.match(t.uFail("check").stdout, /a\.ts#var:a: say why it is careful/);
    writeFileSync(join(dir, "explanations", "recording.json"), JSON.stringify(expl));
    const html = readFileSync(t.u("render").trim(), "utf8");
    const data = JSON.parse(html.match(/const DATA = (.*?);<\/script>/)[1]);
    const b = data.symbols.find((s) => s.name === "b");
    assert.equal(b.explained, false);
    assert.deepEqual(b.later, ["D1"]);
    const a = data.symbols.find((s) => s.name === "a");
    assert.deepEqual(a.risks.map((r) => r.from), ["D1", null]);
    assert.equal(a.attnWhy, attentionReason);
    expl.symbols["a.ts#var:a"].attention = 'careful"><img src=x onerror=alert(1)>';
    writeFileSync(join(dir, "explanations", "recording.json"), JSON.stringify(expl));
    const bad = t.uFail("render");
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /attention must be/);
  } finally {
    t.cleanup();
  }
});

test("off and on", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.u("off");
    t.edit("a.ts", "a = 1", "a = 2");
    assert.match(t.u("status"), /off/);
    assert.equal(t.recDir().includes("/recordings/"), false);
    t.u("on");
    t.edit("a.ts", "a = 2", "a = 3");
    assert.ok(t.recDir().includes("/recordings/"));
  } finally {
    t.cleanup();
  }
});

test("log integrity: strict flags, distinct concurrent ids, recovery from a partial line", async () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    assert.match(t.uFail("decide", "--title", "X", "--why=", "--for", "a.ts").stderr, /--why is required/);
    assert.match(t.uFail("decide", "--title", "X", "--why", "w", "--for", "a.ts", "--bogus", "x").stderr, /unknown option/);
    await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((res) => {
      spawn(CLI, ["decide", "--title", `T${i}`, "--why", "w", "--for", "a.ts"], { cwd: t.dir, env: t.env, stdio: "ignore" }).on("exit", res);
    })));
    const log = join(t.recDir(), "decision_log.jsonl");
    const ids = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).id);
    assert.equal(new Set(ids).size, 6, ids.join(","));
    appendFileSync(log, '{"id":"D7","title":"half');
    t.u("decide", "--title", "After crash", "--why", "w", "--for", "a.ts");
    assert.match(t.u("decisions"), /D7 \[agent\] After crash/);
  } finally {
    t.cleanup();
  }
});

test("provenance: reorder then manual delete, hooked chmod, standalone blank line", () => {
  const t = started({ "list.txt": "alpha line\nbeta line\n", "run.sh": "echo hi\n", "a.ts": "export const a = 1;\n\nexport const b = 1;\n\nexport const c = 1;\n" });
  try {
    t.edit("list.txt", "alpha line\nbeta line\n", "beta line\nalpha line\n");
    t.bash("chmod +x run.sh", () => t.sh("chmod", ["+x", "run.sh"]));
    t.u("decide", "--title", "Reorder and make executable", "--why", "w", "--for", "list.txt", "--for", "run.sh");
    t.write("list.txt", "beta line\n"); // a person deletes alpha
    t.bash("edit a.ts", () => t.write("a.ts", "export const a = 2;\n\nexport const b = 1;\n\n\nexport const c = 1;\n"));
    const x = t.extract();
    const del = x.symbols.flatMap((s) => s.rows).find((r) => r.t === "-" && r.s === "alpha line");
    assert.equal(del.p, "outside");
    assert.deepEqual(symbolFinder(x)("run.sh#file:(file mode)").decisions, ["D1"]);
    assert.ok(x.symbols.some((s) => s.file === "a.ts" && s.name.startsWith("whitespace")));
  } finally {
    t.cleanup();
  }
});
