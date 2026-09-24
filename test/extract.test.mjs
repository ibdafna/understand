// Extraction regressions: every case here once produced a missing, duplicated, or misleading change.
import { test } from "node:test";
import assert from "node:assert/strict";
import { repo } from "./helpers.mjs";

/** Commit `before`, start recording, write `after` (no hooks), and list what extract reports. */
function changes(files) {
  const t = repo();
  try {
    for (const [p, [before]] of Object.entries(files)) if (before != null) t.write(p, before);
    t.commit();
    t.bash("apply fixture", () => {
      for (const [p, [, after]] of Object.entries(files)) {
        if (after == null) t.sh("rm", ["-f", p]);
        else t.write(p, after);
      }
    });
    const x = t.extract();
    return x.symbols.map((s) => `${s.status} ${s.id.split("#")[1]}${s.movedFrom ? ` from ${s.movedFrom}` : ""}${s.note ? ` (${s.note})` : ""}`);
  } finally {
    t.cleanup();
  }
}

test("Go const group turned into var group is reported", () => {
  const got = changes({ "a.go": ["package x\n\nconst (\n\tA = 1\n\tB = 2\n)\n", "package x\n\nvar (\n\tA = 1\n\tB = 2\n)\n"] });
  assert.equal(got.length, 1, got.join(" | "));
  assert.match(got[0], /^modified other@/, "the group wrapper change is shown once, as its own hunk");
});

test("swapped declarations are reported as a reorder", () => {
  const got = changes({ "a.ts": ["const first = events.push(1);\nconst second = events.push(2);\n", "const second = events.push(2);\nconst first = events.push(1);\n"] });
  assert.equal(got.length, 1);
  assert.match(got[0], /^modified other@o?\d+$/);
});

test("adding a trailing newline is reported", () => {
  assert.equal(changes({ "a.ts": ["const a = 1;", "const a = 1;\n"] }).length, 1);
});

test("an empty file is reported", () => {
  assert.deepEqual(changes({ "a.ts": [null, ""] }), ["added file:(empty file)"]);
});

test("inserting an iota const flags the constant whose value shifted", () => {
  const got = changes({ "a.go": ["package x\n\nconst (\n\tA = iota\n\tB\n)\n", "package x\n\nconst (\n\tA = iota\n\tX\n\tB\n)\n"] });
  assert.ok(got.includes("added var:X"));
  assert.ok(got.some((g) => g.startsWith("modified var:B") && g.includes("iota")), got.join(" | "));
});

test("two methods on one line: only the changed one is reported", () => {
  const got = changes({ "a.ts": ["class C { a(){ return 1 } b(){ return 2 } }\n", "class C { a(){ return 1 } b(){ return 3 } }\n"] });
  assert.deepEqual(got, ["modified method:C.b"]);
});

test("inserting a duplicate Go init() doesn't shift the others", () => {
  const got = changes({ "a.go": [
    "package x\n\nfunc init() { println(1) }\n\nfunc init() { println(2) }\n",
    "package x\n\nfunc init() { println(0) }\n\nfunc init() { println(1) }\n\nfunc init() { println(2) }\n",
  ] });
  assert.equal(got.length, 1);
  assert.match(got[0], /^added func:init/);
});

test("a Python move with an indentation change is not an unchanged move", () => {
  const got = changes({
    "a.py": ["def f(flag):\n    if flag:\n        pass\n    return audit()\n", ""],
    "b.py": ["", "def f(flag):\n    if flag:\n        pass\n        return audit()\n"],
  });
  assert.ok(!got.some((g) => g.startsWith("moved")), got.join(" | "));
});

test("an identical move is still detected", () => {
  const got = changes({
    "a.py": ["def f():\n    return 1\n\n\ndef g():\n    return 2\n", "def g():\n    return 2\n"],
    "b.py": [null, "def f():\n    return 1\n"],
  });
  assert.ok(got.includes("moved func:f from a.py"), got.join(" | "));
});

test("TypeScript namespaces, class fields, and default exports have stable symbols", () => {
  const got = changes({ "a.ts": [
    "namespace N {\n  export function f() { return 1 }\n}\nclass C {\n  x = 1;\n  y = 2;\n}\nexport default () => 1;\n",
    "namespace N {\n  export function f() { return 2 }\n}\nclass C {\n  x = 1;\n  y = 3;\n}\nexport default () => 2;\n",
  ] });
  assert.deepEqual(got.sort(), ["modified export:default", "modified field:C.y", "modified func:N.f"]);
});

test("nested Python class methods are their own symbols", () => {
  const got = changes({ "a.py": ["class Outer:\n    class Inner:\n        def run(self):\n            return 1\n", "class Outer:\n    class Inner:\n        def run(self):\n            return 2\n"] });
  assert.deepEqual(got, ["modified method:Outer.Inner.run"]);
});

test("a file whose only change is its mode is reported", () => {
  const t = repo();
  try {
    t.write("run.sh", "echo hi\n");
    t.commit();
    t.bash("chmod +x run.sh", () => t.sh("chmod", ["+x", "run.sh"]));
    const x = t.extract();
    assert.deepEqual(x.symbols.map((s) => s.id), ["run.sh#file:(file mode)"]);
  } finally {
    t.cleanup();
  }
});

test("a tracked file that matches .gitignore is still seen", () => {
  const t = repo();
  try {
    t.write(".gitignore", "secret.ts\n");
    t.write("secret.ts", "export const k = 1;\n");
    t.sh("git", ["add", ".gitignore"]);
    t.sh("git", ["add", "-f", "secret.ts"]);
    t.sh("git", ["commit", "-qm", "b"]);
    t.bash("edit secret", () => t.write("secret.ts", "export const k = 2;\n"));
    assert.deepEqual(t.extract().symbols.map((s) => s.id), ["secret.ts#var:k"]);
  } finally {
    t.cleanup();
  }
});
