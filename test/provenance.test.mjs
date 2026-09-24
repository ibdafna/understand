// Provenance regressions found by the verification review of the snapshot-based recorder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { manifestCommands, repo, symbolFinder } from "./helpers.mjs";

function recorded(files) {
  const t = repo();
  for (const [p, text] of Object.entries(files)) t.write(p, text);
  t.commit();
  t.u("init");
  t.hook("session-start");
  return t;
}

test("the plugin manifest brackets every observed tool with pre and post hooks", () => {
  for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]) {
    assert.deepEqual(manifestCommands("PreToolUse", tool), ["pre-tool-use"], tool);
    assert.deepEqual(manifestCommands("PostToolUse", tool), ["post-tool-use"], tool);
  }
  assert.deepEqual(manifestCommands("Stop", ""), ["stop"]);
  assert.deepEqual(manifestCommands("SessionStart", ""), ["session-start"]);
});

test("a manual edit made between tool calls is never folded into the next tool's capture", () => {
  const t = recorded({ "a.ts": "export const a = 1;\n", "b.ts": "export const b = 1;\n" });
  try {
    t.write("b.ts", "export const b = 2;\n"); // a person, in their editor
    t.edit("a.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "Bump a", "--why", "w");
    const by = symbolFinder(t.extract());
    assert.equal(by("a.ts#var:a").explained, true);
    assert.equal(by("b.ts#var:b").explained, false);
    assert.equal(by("b.ts#var:b").gaps.outside, true);
  } finally {
    t.cleanup();
  }
});

test("files a watcher rewrites during an Edit aren't credited to that Edit", () => {
  const t = recorded({ "a.ts": "export const a = 1;\n", "gen.ts": "export const g = 1;\n" });
  try {
    const cur = t.read("a.ts");
    t.tool("Edit", { file_path: join(t.dir, "a.ts"), old_string: "a = 1", new_string: "a = 2" }, () => {
      t.write("a.ts", cur.replace("a = 1", "a = 2"));
      t.write("gen.ts", "export const g = 2;\n"); // side effect of the edit
    });
    t.u("decide", "--title", "Bump a", "--why", "w");
    const by = symbolFinder(t.extract());
    assert.deepEqual(by("a.ts#var:a").decisions, ["D1"]);
    assert.equal(by("gen.ts#var:g").explained, false);
    assert.deepEqual(by("gen.ts#var:g").decisions, []);
  } finally {
    t.cleanup();
  }
});

test("a --for claim can't explain edits made after its decision", () => {
  const t = recorded({ "a.ts": "export function f() {\n  return 1;\n}\n" });
  try {
    t.edit("a.ts", "return 1", "return 2");
    t.u("decide", "--title", "First", "--why", "w", "--for", "a.ts:f");
    t.edit("a.ts", "return 2", "return 3");
    t.u("decide", "--title", "Second", "--why", "w");
    const f = symbolFinder(t.extract())("a.ts#func:f");
    assert.ok(f.decisions.includes("D2"), `D2 explains the later edit: ${f.decisions}`);
    assert.equal(f.explained, true);
  } finally {
    t.cleanup();
  }
});

test("a manual deletion after an agent reorder is not credited to the reorder", () => {
  const t = recorded({ "list.txt": "alpha line\nbeta line\n" });
  try {
    t.edit("list.txt", "alpha line\nbeta line\n", "beta line\nalpha line\n");
    t.u("decide", "--title", "Reorder", "--why", "w");
    t.write("list.txt", "beta line\n"); // a person deletes alpha
    const x = t.extract();
    const rows = x.symbols.flatMap((s) => s.rows);
    const del = rows.find((r) => r.t === "-" && r.s === "alpha line");
    assert.ok(del, "alpha's removal is shown");
    assert.equal(del.p, "outside");
  } finally {
    t.cleanup();
  }
});

test("a hooked chmod is explained by its decision", () => {
  const t = recorded({ "run.sh": "echo hi\n" });
  try {
    t.bash("chmod +x run.sh", () => t.sh("chmod", ["+x", "run.sh"]));
    t.u("decide", "--title", "Make the script executable", "--why", "CI runs it directly");
    const s = symbolFinder(t.extract())("run.sh#file:(file mode)");
    assert.deepEqual(s.decisions, ["D1"]);
    assert.equal(s.explained, true);
  } finally {
    t.cleanup();
  }
});

test("a blank line added away from other changes is still reported", () => {
  const t = recorded({ "a.ts": "export const a = 1;\n\nexport const b = 1;\n\nexport const c = 1;\n" });
  try {
    t.write("a.ts", "export const a = 2;\n\nexport const b = 1;\n\n\nexport const c = 1;\n");
    const ids = t.extract().symbols.map((s) => `${s.id.split("#")[1]} ${s.name}`);
    assert.ok(ids.some((i) => i.startsWith("var:a")));
    assert.ok(ids.some((i) => i.includes("whitespace")), ids.join(" | "));
  } finally {
    t.cleanup();
  }
});

test("a partial log line from a crash doesn't swallow the next record", () => {
  const t = recorded({ "a.txt": "a\n" });
  try {
    t.u("decide", "--title", "One", "--why", "w");
    appendFileSync(join(t.dir, ".understand/decisions.jsonl"), '{"id":"D2","title":"half');
    t.u("decide", "--title", "Two", "--why", "w");
    const out = t.u("decisions");
    assert.match(out, /D2 \[agent\] Two/);
  } finally {
    t.cleanup();
  }
});

test("a symlinked private index is refused", () => {
  const t = recorded({ "a.txt": "a\n" });
  try {
    rmSync(join(t.dir, ".understand/index"));
    symlinkSync(join(t.dir, ".git/index"), join(t.dir, ".understand/index"));
    t.write("u.txt", "untracked\n");
    const r = t.uFail("extract");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /symlink/);
    assert.ok(!/^A /m.test(t.sh("git", ["status", "--short"])));
  } finally {
    t.cleanup();
  }
});

test("a changed explanation resets the reviewed mark", () => {
  const t = recorded({ "a.ts": "export const a = 1;\n" });
  try {
    t.edit("a.ts", "a = 1", "a = 2");
    t.u("decide", "--title", "Bump", "--why", "w");
    const narr = (summary) => JSON.stringify({ title: "T", intent: "I", chapters: [{ title: "C", summary: "S", symbols: ["a.ts#var:a"] }], symbols: { "a.ts#var:a": { summary, attention: "skim" } } });
    const keyOf = () => {
      const html = readFileSync(t.u("render").trim(), "utf8");
      return JSON.parse(html.match(/const DATA = (.*?);\n/)[1]).symbols[0].key;
    };
    t.write(".understand/narration.json", narr("First reason."));
    const k1 = keyOf();
    t.write(".understand/narration.json", narr("A different reason."));
    assert.notEqual(keyOf(), k1);
  } finally {
    t.cleanup();
  }
});
