// Explaining any range, the checked-in decision log, and Codex's tool shapes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, repo, started, symbolFinder } from "./helpers.mjs";

const ids = (x) => x.symbols.map((s) => s.id).sort();

test("any range can be explained: branch, staged, uncommitted, commits, PR", () => {
  const t = started({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n", "c.ts": "export const c = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    t.bash("git commit -am a", () => t.commit("a"));
    t.edit("b.ts", "b = 1", "b = 2");
    t.bash("git add b.ts", () => t.sh("git", ["add", "b.ts"]));
    t.edit("c.ts", "c = 1", "c = 2");
    t.u("decide", "--title", "All three", "--why", "w", "--for", "a.ts", "--for", "b.ts", "--for", "c.ts");
    assert.deepEqual(ids(t.extract("--branch")), ["a.ts#var:a", "b.ts#var:b", "c.ts#var:c"]);
    assert.deepEqual(ids(t.extract("--uncommitted")), ["b.ts#var:b", "c.ts#var:c"]);
    assert.deepEqual(ids(t.extract("--staged")), ["b.ts#var:b"]);
    assert.deepEqual(ids(t.extract("--commits", "HEAD")), ["a.ts#var:a"]);
    assert.deepEqual(ids(t.extract("--pr", "main")), ["a.ts#var:a"]);
    assert.ok(symbolFinder(t.extract("--staged"))("b.ts#var:b").explained);
    assert.match(t.uFail("extract", "--staged", "--branch").stderr, /pick one range/);
    assert.match(t.u("extract", "--staged"), /explanations\/staged\.json/);
  } finally {
    t.cleanup();
  }
});

test("the decision log is shared as TSV, committed with the agent's commit, and never explained as code", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    const out = t.u("decide", "--by", "human", "--title", "Bump\ta", "--why", "Two lines\nof reason", "--for", "a.ts:a", "--alt", "Keep 1: too small", "--risk", "Callers assume 1");
    assert.match(out, /Shared log: \.decisions\//);
    const [file] = readdirSync(join(t.dir, ".decisions"));
    const [header, row] = readFileSync(join(t.dir, ".decisions", file), "utf8").trim().split("\n");
    assert.equal(header, "id\trecorded\tby\ttitle\twhy\tshaped\trejected\trisks\trevises\tmechanical");
    assert.deepEqual(row.split("\t").slice(2, 8), ["user", "Bump a", "Two lines of reason", "a.ts:a", "Keep 1: too small", "Callers assume 1"]);
    t.bash("git commit -am bump", () => t.sh("git", ["commit", "-qam", "bump"]));
    assert.match(t.sh("git", ["show", "--name-only", "--format=", "HEAD"]), /\.decisions\//, "the log rode along with the commit");
    assert.deepEqual(ids(t.extract("--pr", "main")), ["a.ts#var:a"], "the log itself is not a change to explain");
  } finally {
    t.cleanup();
  }
});

test("sharing can be turned off", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.sh("git", ["config", "understand.share", "false"]);
    t.edit("a.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "Bump", "--why", "w", "--for", "a.ts");
    assert.equal(existsSync(join(t.dir, ".decisions")), false);
  } finally {
    t.cleanup();
  }
});

test("without a local recording, the page is built from the checked-in log, by name", () => {
  const t = started({ "a.ts": "export function f() {\n  return 1;\n}\nexport function g() {\n  return 1;\n}\n" });
  try {
    t.bash("edit", () => t.write("a.ts", t.read("a.ts").replace(/return 1;/g, "return 2;")));
    t.u("decide", "--title", "Change f", "--why", "w", "--for", "a.ts:f");
    t.bash("git commit -am x", () => t.sh("git", ["commit", "-qam", "x"]));
    // A reviewer: same repo contents, no Understand state at all.
    const env = { ...t.env, UNDERSTAND_HOME: join(t.uhome, "reviewer") };
    const run = (...a) => spawnSync(CLI, a, { cwd: t.dir, env, encoding: "utf8" });
    assert.match(run("extract").stderr, /no local recording here/);
    const r = run("extract", "--pr", "main");
    assert.equal(r.status, 0, r.stderr);
    const x = JSON.parse(readFileSync(join(t.uhome, "reviewer", "repos", readdirSync(join(t.uhome, "reviewer", "repos"))[0], "shared", "extract.json"), "utf8"));
    assert.equal(x.byName, true);
    const by = symbolFinder(x);
    assert.equal(by("a.ts#func:f").explained, true);
    assert.equal(by("a.ts#func:g").explained, false);
    assert.equal(x.decisions[0].title, "Change f");
    const html = readFileSync(run("render", "--pr", "main").stdout.trim(), "utf8");
    assert.match(html, /"byName":true/);
  } finally {
    t.cleanup();
  }
});

test("Codex: apply_patch edits are credited by the paths in the patch; CODEX_SESSION_ID identifies the session", () => {
  const t = started({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
  try {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n@@\n-export const a = 1;\n+export const a = 2;\n*** Add File: n.ts\n+export const n = 1;\n*** End Patch\n";
    t.tool("apply_patch", { command: patch }, () => {
      t.write("a.ts", "export const a = 2;\n");
      t.write("n.ts", "export const n = 1;\n");
      t.write("b.ts", "export const b = 2;\n"); // a formatter touching another file
    });
    const env = { ...t.env, CODEX_SESSION_ID: "sess-1" };
    delete env.CLAUDE_CODE_SESSION_ID;
    const d = spawnSync(CLI, ["decide", "--title", "Patch", "--why", "w", "--for", "a.ts", "--for", "n.ts", "--for", "b.ts"], { cwd: t.dir, env, encoding: "utf8" });
    assert.equal(d.status, 0, d.stderr);
    const by = symbolFinder(t.extract());
    assert.equal(by("a.ts#var:a").explained, true);
    assert.equal(by("n.ts#var:n").explained, true);
    assert.equal(by("b.ts#var:b").gaps.outside, true, "not named in the patch: a side effect");
  } finally {
    t.cleanup();
  }
});

test("Codex: session start tells the agent the CLI's full path when plugin bin/ isn't on PATH", () => {
  const t = repo();
  try {
    t.commit();
    const out = spawnSync(CLI, ["hook", "session-start"], { cwd: t.dir, env: { ...t.env, PLUGIN_ROOT: "/opt/understand" }, input: JSON.stringify({ session_id: "s", cwd: t.dir }), encoding: "utf8" }).stdout;
    assert.match(JSON.parse(out).hookSpecificOutput.additionalContext, /\/opt\/understand\/bin\/understand/);
  } finally {
    t.cleanup();
  }
});

test("in a sandbox that blocks writes to Understand's state, decisions queue in the repo and the next hook files them", () => {
  const t = started({ "a.ts": "export const a = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    const payload = { tool_name: "Bash", tool_input: { command: "understand decide ..." }, tool_use_id: "toolu_sandbox" };
    t.hook("pre-tool-use", { ...payload, hook_event_name: "PreToolUse" });
    spawnSync("chmod", ["-R", "a-w", t.uhome]); // the sandbox: the agent's command may read our state but not write it
    let out;
    try {
      out = t.u("decide", "--title", "Bump", "--why", "w", "--for", "a.ts:a");
    } finally {
      spawnSync("chmod", ["-R", "u+w", t.uhome]);
    }
    assert.match(out, /will be filed/);
    assert.ok(existsSync(join(t.dir, ".decisions", ".pending.jsonl")));
    t.hook("post-tool-use", { ...payload, hook_event_name: "PostToolUse" }); // hooks run outside the sandbox
    assert.equal(existsSync(join(t.dir, ".decisions", ".pending.jsonl")), false);
    assert.equal(symbolFinder(t.extract())("a.ts#var:a").explained, true);
  } finally {
    t.cleanup();
  }
});

