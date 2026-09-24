// Regressions from the adversarial review of the automatic-recording rework.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLI, repo, started, symbolFinder } from "./helpers.mjs";

test("a branch created after editing on main carries the recording and its decisions", () => {
  const t = started({ "a.ts": "export const a = 1;\n" }, { branch: null });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "Bump", "--why", "w", "--for", "a.ts:a");
    t.bash("git switch -c feature", () => t.sh("git", ["switch", "-q", "-c", "feature"]));
    t.bash("git commit -am x", () => t.commit("x"));
    t.bash("git branch -m renamed", () => t.sh("git", ["branch", "-m", "renamed"]));
    const a = symbolFinder(t.extract("--against", "main"))("a.ts#var:a");
    assert.deepEqual(a.decisions, ["D1"]);
    assert.equal(a.explained, true);
  } finally {
    t.cleanup();
  }
});

test("checking out another commit on a detached HEAD is not an edit", () => {
  const t = started({ "a.ts": "export const a = 1;\n" }, { branch: null });
  try {
    t.write("a.ts", "export const a = 5;\n");
    t.commit("second");
    t.sh("git", ["checkout", "-q", "--detach", "HEAD~1"]);
    t.edit("a.ts", "a = 1", "a = 2");
    t.bash("git stash && git checkout HEAD@{1}", () => { t.sh("git", ["stash", "-q"]); t.sh("git", ["checkout", "-q", "--detach", "main"]); });
    const recs = join(t.recDir(), "..", "..", "recordings");
    const all = spawnSync("sh", ["-c", `cat ${recs}/*/edits.jsonl 2>/dev/null`], { encoding: "utf8" }).stdout;
    assert.match(all, /"tool":"Edit"/, "the agent's edit was recorded");
    assert.doesNotMatch(all, /"tool":"Bash"/, "the checkout was not credited to the Bash call");
  } finally {
    t.cleanup();
  }
});

test("every shell command is captured, whatever it looks like", () => {
  const t = started({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    t.bash("env FOO=1 node mutate.js", () => t.write("b.ts", "export const b = 2;\n"));
    t.edit("a.ts", "a = 2", "a = 3");
    t.u("decide", "--title", "Both", "--why", "w", "--for", "a.ts", "--for", "b.ts");
    assert.equal(symbolFinder(t.extract())("b.ts#var:b").explained, true);
  } finally {
    t.cleanup();
  }
});

test("a new Go import group keeps its wrapper lines", () => {
  const t = started({ "a.go": "package a\n" });
  try {
    t.bash("edit", () => t.write("a.go", 'package a\n\nimport (\n\t"fmt"\n\t"os"\n)\n'));
    const added = t.extract().symbols.flatMap((s) => s.rows).filter((r) => r.t === "+").map((r) => r.s.trim());
    for (const line of ["import (", '"fmt"', '"os"', ")"]) assert.ok(added.includes(line), `${line} missing: ${JSON.stringify(added)}`);
  } finally {
    t.cleanup();
  }
});

test("claims: imports with colons work, empty suffixes are refused, ambiguous short names need qualifying", () => {
  const t = started({ "a.ts": "export const x = 1;\nclass A {\n  run() { return 1; }\n}\nclass B {\n  run() { return 1; }\n}\n" });
  try {
    t.edit("a.ts", "export const x = 1;", 'import { readFileSync } from "node:fs";\nexport const x = 1;');
    t.bash("edit both", () => t.write("a.ts", t.read("a.ts").replace(/return 1;/g, "return 2;")));
    assert.match(t.uFail("decide", "--title", "X", "--why", "w", "--for", "a.ts:").stderr, /name the symbol after the colon/);
    t.u("decide", "--title", "Read files", "--why", "w", "--for", "a.ts:node:fs", "--for", "a.ts:run");
    let by = symbolFinder(t.extract());
    assert.equal(by("a.ts#import:node:fs").explained, true);
    assert.equal(by("a.ts#method:A.run").explained, false, "`run` is ambiguous here");
    t.u("link", "D1", "--for", "a.ts:A.run", "--for", "a.ts:B.run");
    by = symbolFinder(t.extract());
    assert.equal(by("a.ts#method:A.run").explained, true);
    assert.equal(by("a.ts#method:B.run").explained, true);
  } finally {
    t.cleanup();
  }
});

test("a decision run from a person's terminal never credits their edits to the agent", () => {
  const t = started({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    t.write("b.ts", "export const b = 2;\n"); // a person's edit
    const env = { ...t.env };
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync(CLI, ["decide", "--by", "human", "--title", "X", "--why", "w", "--for", "a.ts", "--for", "b.ts"], { cwd: t.dir, env, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const by = symbolFinder(t.extract());
    assert.equal(by("b.ts#var:b").gaps.outside, true);
    assert.equal(by("b.ts#var:b").explained, false);
  } finally {
    t.cleanup();
  }
});

test("a line restored and deleted again belongs to whoever deleted it last", () => {
  const t = started({ "a.txt": "keep\nremove me\n" });
  try {
    t.edit("a.txt", "keep\nremove me\n", "keep\n");
    t.u("decide", "--title", "Drop it", "--why", "w", "--for", "a.txt");
    t.write("a.txt", "keep\nremove me\n"); // a person restores it
    t.bash("true");
    t.write("a.txt", "keep\n"); // and deletes it again
    const del = t.extract().symbols.flatMap((s) => s.rows).find((r) => r.t === "-" && r.s === "remove me");
    assert.equal(del.p, "outside");
  } finally {
    t.cleanup();
  }
});

test("a mode change belongs to whoever made the final mode", () => {
  const t = started({ "run.sh": "echo hi\n" });
  try {
    t.bash("true");
    t.sh("chmod", ["+x", "run.sh"]); // a person
    t.bash("true");
    t.sh("chmod", ["-x", "run.sh"]); // and back
    t.bash("chmod +x run.sh", () => t.sh("chmod", ["+x", "run.sh"]));
    t.u("decide", "--title", "Executable", "--why", "w", "--for", "run.sh");
    const s = symbolFinder(t.extract())("run.sh#file:(file mode)");
    assert.equal(s.explained, true, JSON.stringify(s.gaps));
  } finally {
    t.cleanup();
  }
});

test("stop weighs only the unexplained lines, and always counts lineless changes", () => {
  const t = started({ "a.ts": "export function f() {\n  return 1;\n}\n", "run.sh": "echo hi\n" });
  try {
    t.edit("a.ts", "  return 1;", Array.from({ length: 20 }, (_, i) => `  const v${i} = ${i};`).join("\n") + "\n  return 1;");
    t.u("decide", "--title", "Big", "--why", "w", "--for", "a.ts:f");
    t.edit("a.ts", "return 1;", "return 2;"); // one unexplained line
    assert.equal(t.hook("stop"), "", "one unexplained line doesn't interrupt");
    t.bash("chmod +x run.sh", () => t.sh("chmod", ["+x", "run.sh"]));
    const block = JSON.parse(t.hook("stop"));
    assert.equal(block.decision, "block");
    assert.match(block.reason, /run\.sh/);
  } finally {
    t.cleanup();
  }
});

test("the PR nudge fires only after a successful gh pr create, however it's spelled", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    assert.match(t.bash("gh --repo o/r pr create --fill"), /understand:explain/);
    let out = "unset";
    const payload = { tool_name: "Bash", tool_input: { command: "gh pr create --fill" }, tool_use_id: "toolu_prfail" };
    t.hook("pre-tool-use", { ...payload, hook_event_name: "PreToolUse" });
    out = t.hook("post-tool-use", { ...payload, hook_event_name: "PostToolUseFailure" });
    assert.equal(out, "", "no nudge when creating the PR failed");
  } finally {
    t.cleanup();
  }
});

test("status reports unnamed symbols like the stop check does; on warns about a global off", () => {
  const t = started({ "a.ts": "export function f() {\n  return 1;\n}\nexport function g() {\n  return 1;\n}\n" });
  try {
    t.bash("edit both", () => t.write("a.ts", t.read("a.ts").replace(/return 1;/g, "return 2;")));
    t.u("decide", "--title", "F", "--why", "w", "--for", "a.ts:f");
    assert.match(t.u("status"), /a\.ts:g/);
    t.u("off", "--everywhere");
    assert.match(t.u("on"), /still off/);
  } finally {
    t.cleanup();
  }
});

test("storage: private permissions, one home per repo across worktrees, never inside the repo", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    const repos = join(t.uhome, "repos");
    const home = join(repos, readFileSync(join(t.recDir(), "config.json"), "utf8") && spawnSync("ls", [repos], { encoding: "utf8" }).stdout.trim());
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(t.recDir(), "edits.jsonl")).mode & 0o777, 0o600);
    const wt = join(t.dir, "..", `wt-${Date.now()}`);
    t.sh("git", ["worktree", "add", "-q", "-b", "other", wt]);
    spawnSync(CLI, ["hook", "pre-tool-use"], { cwd: wt, env: t.env, input: JSON.stringify({ session_id: "sess-1", cwd: wt, tool_name: "Bash", tool_input: { command: "true" } }) });
    assert.equal(spawnSync("ls", [repos], { encoding: "utf8" }).stdout.trim().split("\n").length, 1, "worktrees share the repo's home");
    const inside = spawnSync(CLI, ["status"], { cwd: t.dir, env: { ...t.env, UNDERSTAND_HOME: join(t.dir, ".understand") }, encoding: "utf8" });
    assert.equal(inside.status, 1);
    assert.match(inside.stderr, /inside the repository/);
  } finally {
    t.cleanup();
  }
});

test("default chapters put a revised symbol under its latest decision", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "First try", "--why", "w", "--for", "a.ts:a");
    t.edit("a.ts", "a = 2", "a = 3");
    t.u("decide", "--title", "Second thoughts", "--why", "w", "--for", "a.ts:a", "--supersedes", "D1");
    const data = JSON.parse(readFileSync(t.u("render").trim(), "utf8").match(/const DATA = (.*?);\n/)[1]);
    assert.deepEqual(data.chapters.map((c) => c.title), ["Second thoughts"]);
  } finally {
    t.cleanup();
  }
});

// --- Second verification round ---

test("creating a branch, editing, and committing in one command keeps everything in the branch's recording", () => {
  const t = started({ "a.ts": "export const a = 1;\nexport function legacy() {\n  return 0;\n}\n" }, { branch: null });
  try {
    t.bash("git checkout -b feat && edit && git commit", () => {
      t.sh("git", ["checkout", "-q", "-b", "feat"]);
      t.write("a.ts", "export const a = 1;\n");
      t.commit("drop legacy");
    });
    t.u("decide", "--by", "human", "--title", "Drop legacy", "--why", "Dead code", "--for", "a.ts:legacy");
    const s = symbolFinder(t.extract("--against", "main"))("a.ts#func:legacy");
    assert.equal(s.gaps.before, false, JSON.stringify(s.gaps));
    assert.equal(s.explained, true);
  } finally {
    t.cleanup();
  }
});

test("checking out an existing branch at the same commit doesn't carry the recording", () => {
  const t = started({ "a.ts": "export const a = 1;\n" }, { branch: null });
  try {
    t.sh("git", ["branch", "other"]); // exists before any tool call
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1100); // reflog times have one-second resolution
    t.edit("a.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "Bump", "--why", "w", "--for", "a.ts");
    const onMain = t.recDir();
    t.bash("git checkout other", () => t.sh("git", ["checkout", "-q", "other"]));
    assert.notEqual(t.recDir(), onMain);
  } finally {
    t.cleanup();
  }
});

test("a renamed symbol stays explained by the decision that named it before the rename", () => {
  const t = started({ "s.ts": "export const x = 1;\n" });
  try {
    t.edit("s.ts", "export const x = 1;", "export const x = 1;\nexport function done(id: number) {\n  const hit = find(id);\n  return mark(hit);\n}");
    t.u("decide", "--title", "Add done", "--why", "w", "--for", "s.ts:done");
    t.hook("stop");
    t.edit("s.ts", "export function done(", "export function complete(");
    t.u("decide", "--by", "human", "--title", "Rename to complete", "--why", "w", "--for", "s.ts:complete");
    const s = symbolFinder(t.extract())("s.ts#func:complete");
    assert.deepEqual([...s.decisions].sort(), ["D1", "D2"]);
    assert.equal(s.explained, true, JSON.stringify(s.gaps));
  } finally {
    t.cleanup();
  }
});

test("a blank line added by another edit doesn't leave a symbol unexplained", () => {
  const t = started({ "a.ts": "export function f() {\n  return 1;\n}\n" });
  try {
    t.edit("a.ts", "  return 1;", "  const y = 2;\n  return 1;");
    t.u("decide", "--title", "F", "--why", "w", "--for", "a.ts:f");
    t.hook("stop");
    t.edit("a.ts", "  const y = 2;\n", "  const y = 2;\n\n");
    assert.equal(symbolFinder(t.extract())("a.ts#func:f").explained, true);
  } finally {
    t.cleanup();
  }
});

test("a decision from a shell with the session variable but no hooked tool call stays unverified", () => {
  const t = started({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    t.write("b.ts", "export const b = 2;\n"); // a person's edit
    t.u("decide", "--title", "X", "--why", "w", "--for", "a.ts", "--for", "b.ts"); // env has CLAUDE_CODE_SESSION_ID, no open tool call
    assert.equal(symbolFinder(t.extract())("b.ts#var:b").explained, false);
  } finally {
    t.cleanup();
  }
});

test("a home next to the repo named '..understand' still counts as inside it", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    const r = spawnSync(CLI, ["status"], { cwd: t.dir, env: { ...t.env, UNDERSTAND_HOME: join(t.dir, "..understand") }, encoding: "utf8" });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /inside the repository/);
  } finally {
    t.cleanup();
  }
});

test("a later chmod doesn't take credit for a binary's content", () => {
  const t = started({ "img.bin": "\0\u0001a" });
  try {
    t.bash("regenerate image", () => t.write("img.bin", "\0\u0001b"));
    t.u("decide", "--title", "New image", "--why", "w", "--for", "img.bin");
    t.hook("stop");
    t.sh("chmod", ["+x", "img.bin"]); // a person
    const by = symbolFinder(t.extract());
    assert.equal(by("img.bin#file:(binary file)").explained, true);
    assert.equal(by("img.bin#file:(file mode)").gaps.outside, true);
  } finally {
    t.cleanup();
  }
});

test("colons: a file named with a colon can be claimed", () => {
  const t = started({ "a:b.ts": "export const a = 1;\n" });
  try {
    t.edit("a:b.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "Bump", "--why", "w", "--for", "a:b.ts");
    assert.equal(symbolFinder(t.extract())("a:b.ts#var:a").explained, true);
  } finally {
    t.cleanup();
  }
});

test("an unexplained move is always worth asking about", () => {
  const t = started({ "a.py": "def keep():\n    return 0\n\n\ndef f():\n    return 1\n", "b.py": "" });
  try {
    t.bash("move f", () => { t.write("a.py", "def keep():\n    return 0\n"); t.write("b.py", "def f():\n    return 1\n"); });
    const block = JSON.parse(t.hook("stop"));
    assert.equal(block.decision, "block");
  } finally {
    t.cleanup();
  }
});

test("default chapters follow a decision to the one that superseded it", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "First try", "--why", "w", "--for", "a.ts:a");
    t.u("decide", "--title", "Rethought", "--why", "w", "--for", "a.ts:a", "--supersedes", "D1");
    const data = JSON.parse(readFileSync(t.u("render").trim(), "utf8").match(/const DATA = (.*?);\n/)[1]);
    assert.deepEqual(data.chapters.map((c) => c.title), ["Rethought"]);
  } finally {
    t.cleanup();
  }
});
