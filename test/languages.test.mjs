// Symbols per language. Each language is data (languages/<id>/); these pin what its outline finds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { repo } from "./helpers.mjs";

/** The symbols extract finds in a new file, as sorted `kind:key` ids. */
const same = (actual, expected) => assert.deepEqual(actual, [...expected].sort());

function outline(path, src) {
  const t = repo();
  try {
    t.write("README", "x\n");
    t.commit();
    t.bash("add file", () => t.write(path, src));
    return t.extract().symbols.filter((s) => s.file === path).map((s) => s.id.split("#")[1]).sort();
  } finally {
    t.cleanup();
  }
}

test("Go: imports, receivers, groups, iota, and a block of one", () => {
  same(outline("a.go", `package a

import (
	"fmt"
	str "strings"
)

// Size is a size.
const Size = 1

const (
	A = iota
	B
)

type Store[T any] struct{ n int }

func (s *Store[T]) Add(x T) { fmt.Println(str.ToUpper("")) }

func main() {
	var inner int
	_ = inner
}
`), ["other@1", "import:fmt", "import:strings", "var:Size", "var:A", "var:B", "type:Store", "method:Store.Add", "func:main"]);
});

test("TypeScript: members, accessors, overloads, namespaces, exports", () => {
  same(outline("a.ts", `import { x } from "./x";

export class Box {
  size = 1;
  get value(): number { return 1; }
  value2(): number { function inner() {} return 2; }
}

export function f(a: string): void;
export function f(a: number): void;
export function f(a: unknown) {}

namespace N {
  export const k = 1;
  if (true) { function hidden() {} }
}

export const arrow = (a: number) => a;
export { x };
`), ["import:./x", "class:Box", "field:Box.size", "method:Box.get value", "method:Box.value2", "func:f", "namespace:N", "var:N.k", "func:arrow", "export:{ x }"]);
});

test("JavaScript: classes, functions, and multi-name declarations", () => {
  same(outline("a.js", `const i = 1, o = 2;
class C { m() {} static s = 1; }
export default function () {}
`), ["var:i, o", "class:C", "method:C.m", "field:C.s", "export:default"]);
});

test("Python: imports, decorated and nested members, module variables", () => {
  same(outline("a.py", `import os
from x import y

LIMIT = 3

class Outer:
    @property
    def size(self):
        return 1

    class Inner:
        def run(self):
            pass

    if os.name == "nt":
        def windows_only(self):
            pass

def main():
    import json
    local = 1
`), ["import:import os", "import:from x import y", "var:LIMIT", "class:Outer", "method:Outer.size", "class:Outer.Inner", "method:Outer.Inner.run", "func:main"]);
});

test("Rust: impl methods are named after their type; traits, modules, attributes", () => {
  same(outline("a.rs", `use std::collections::HashMap;

#[derive(Debug)]
pub struct Point { x: i32 }

pub trait Area {
    fn area(&self) -> f64;
}

impl Area for Point {
    fn area(&self) -> f64 { 0.0 }
}

impl Point {
    /// Makes a point.
    pub fn new(x: i32) -> Self { fn helper() {} Point { x } }
}

mod util { pub fn helper() {} }

const MAX: usize = 10;
`), ["import:std::collections::HashMap", "type:Point", "type:Area", "method:Area::area", "method:Point::area", "method:Point::new", "namespace:util", "func:util::helper", "var:MAX"]);
});

test("Java: classes, members, nested types, records", () => {
  same(outline("A.java", `package app;

import java.util.List;

/** A thing. */
public class A {
    private int count = 0;
    public A(int c) { count = c; }
    @Override
    public void run() { Runnable r = () -> {}; }
    static class Inner { void go() {} }
}

interface Shape {
    double area();
}
`), ["other@1", "import:java.util.List", "class:A", "field:A.count", "method:A.A", "method:A.run", "class:A.Inner", "method:A.Inner.go", "type:Shape", "method:Shape.area"]);
});

test("C: includes, functions, types, and declarations inside #ifdef", () => {
  same(outline("a.c", `#include <stdio.h>

struct point { int x; };
typedef struct { int n; } counter;

static int total = 0;

int add(int a, int b) { return a + b; }

#ifdef DEBUG
void trace(void) {}
#endif
`), ["import:<stdio.h>", "type:point", "type:counter", "var:total", "func:add", "func:trace", "other@10", "other@12"]);
});

test("C++: namespaces, class members, out-of-class definitions (named within their namespace), templates", () => {
  same(outline("a.cpp", `#include <vector>

namespace app {
class Store {
public:
    Store();
    int size() const { return n; }
private:
    int n = 0;
};

void Store::add(int v) {}

const Todo& Store::get(int i) const { return items[i]; }

Store::Store(int n) : n(n) {}

template <typename T>
T twice(T v) { return v; }
}
`), ["import:<vector>", "namespace:app", "class:app::Store", "method:app::Store::Store", "method:app::Store::size", "field:app::Store::n", "method:app::Store::add", "method:app::Store::get", "method:app::Store::Store", "func:app::twice"]);
});

test("Ruby: requires, modules, classes, methods, constants", () => {
  same(outline("a.rb", `require "json"

module App
  VERSION = "1.0"

  class Store
    def add(item)
      @items << item
    end

    def self.build
      new
    end
  end
end

def helper(x)
  x * 2
end
`), ["import:json", "namespace:App", "var:App.VERSION", "class:App.Store", "method:App.Store.add", "method:App.Store.self build", "func:helper"]);
});

test("C#: usings, namespaces of both kinds, members, properties", () => {
  same(outline("A.cs", `using System;

namespace App
{
    [Serializable]
    public class Store
    {
        private int count;
        public string Name { get; set; }
        public Store() { }
        public void Add(int item) { }
    }

    public interface IStore { void Add(int item); }
}
`), ["import:System", "namespace:App", "class:Store", "field:Store.count", "field:Store.Name", "method:Store.Store", "method:Store.Add", "type:IStore", "method:IStore.Add"]);
  same(outline("B.cs", `namespace App;

public class B
{
    void M() { }
}
`), ["namespace:App", "class:B", "method:B.M"]);
});

test("C#: a local function in top-level statements is its own symbol", () => {
  same(outline("Program.cs", `using System;

var x = Twice(2);
Console.WriteLine(x);

static int Twice(int v)
{
    return v * 2;
}
`), ["import:System", "func:Twice", "other@3"]);
});

test("files without an extension: by name (Makefile) and by #! line", () => {
  same(outline("bin/todo", `#!/usr/bin/env ruby
def main
  puts "hi"
end
`), ["func:main"]);
  const t = repo();
  try {
    t.write("README", "x\n");
    t.commit();
    t.bash("add files", () => { t.write("Makefile", "all:\n\techo hi\n"); t.write("run", "#!/bin/sh\necho hi\n"); });
    const x = t.extract();
    assert.equal(x.files["Makefile"].lang, "make");
    assert.equal(x.files["run"].lang, "shellscript");
  } finally {
    t.cleanup();
  }
});

test("a decision may name a Rust or C++ member with . or ::", () => {
  const t = repo();
  try {
    t.write("a.rs", "struct Point {}\n");
    t.commit();
    t.hook("session-start");
    t.edit("a.rs", "struct Point {}\n", "struct Point {}\n\nimpl Point {\n    fn new() -> Point { Point {} }\n}\n");
    t.u("decide", "--title", "Add a constructor", "--why", "w", "--for", "a.rs:Point.new");
    const s = t.extract().symbols.find((s) => s.name === "Point::new");
    assert.ok(s?.explained, "Point.new names Point::new");
  } finally {
    t.cleanup();
  }
});

test("a language with no data is one whole-file change", () => {
  same(outline("notes.txt", "hello\n"), ["file"]);
});

test("a page carries the syntax grammars of the languages in its diff, and no others", () => {
  const t = repo();
  try {
    t.write("README", "x\n");
    t.commit();
    t.bash("add files", () => { t.write("a.rs", "fn main() {}\n"); t.write("b.py", "x = 1\n"); });
    const html = readFileSync(t.u("render").trim(), "utf8");
    const carried = [...html.matchAll(/UNDERSTAND_LANGS\?\?=\{\}\)\.(\w+)=/g)].map((m) => m[1]).sort();
    assert.deepEqual(carried, ["python", "rust"]);
  } finally {
    t.cleanup();
  }
});

/** The review page's data for a change from `before` to `after` in one file. */
function page(path, before, after) {
  const t = repo();
  try {
    t.write(path, before);
    t.commit();
    t.bash("edit", () => t.write(path, after));
    return JSON.parse(readFileSync(t.u("render").trim(), "utf8").match(/const DATA = (.*?);<\/script>/)[1]);
  } finally {
    t.cleanup();
  }
}

test("an overload's card shows only its own lines; a new overload is all added", () => {
  const d = page("Todo.java", `class Todo {
    Todo(int id, String title) {
        this.id = id;
        this.title = title;
    }
}
`, `class Todo {
    Todo(int id, String title) {
        this(id, title, null);
    }

    Todo(int id, String title, String due) {
        this.id = id;
        this.title = title;
        this.due = due;
    }
}
`);
  const [old, added] = d.symbols.filter((s) => s.name === "Todo.Todo");
  assert.ok(!old.rows.some((r) => r.t === " " && /this\.id = id/.test(r.s)), "the old body isn't shown as this constructor's context");
  assert.ok(old.rows.some((r) => r.t === "-" && /this\.id = id/.test(r.s)), "it shows as removed from this constructor");
  assert.deepEqual(old.rows.filter((r) => r.s.trim() === "}").map((r) => r.t), [" "], "its closing brace stayed");
  assert.ok(added.rows.every((r) => r.t === "+" || r.t === "gap"), "the new overload is all added");
});

test("a class whose only change is a new member (and spacing) has no card of its own", () => {
  const d = page("A.java", `class A {
    void a() {}
}
`, `class A {
    void a() {}

    void b() {}
}
`);
  assert.deepEqual(d.symbols.map((s) => s.name), ["A.b"]);
  for (const s of d.symbols) {
    const rows = s.rows.filter((r) => r.t !== "gap");
    for (const r of [rows[0], rows.at(-1)]) assert.ok(r.s.trim(), "no blank line at either end");
  }
});

test("C++: a constructor's signature stops before its initializer list", () => {
  const t = repo();
  try {
    t.write("README", "x\n");
    t.commit();
    t.bash("add file", () => t.write("a.cpp", "class A {\n    int n;\n    A(int v) : n(v) {}\n};\n\nA::A(long v) : n(v) {}\n"));
    const sigs = t.extract().symbols.filter((s) => s.name.endsWith("A::A")).map((s) => s.sig);
    assert.deepEqual(sigs.sort(), ["A(int v)", "A::A(long v)"]);
  } finally {
    t.cleanup();
  }
});

test("signatures: no trailing ;, no comments, a name after its body keeps the body's place, no block opener", () => {
  const sigs = (path, src) => {
    const t = repo();
    try {
      t.write("README", "x\n");
      t.commit();
      t.bash("add file", () => t.write(path, src));
      return Object.fromEntries(t.extract().symbols.filter((s) => s.file === path).map((s) => [s.name, s.sig]));
    } finally {
      t.cleanup();
    }
  };
  const c = sigs("a.h", "#define LEN 10 /* YYYY-MM-DD */\ntypedef struct {\n  int n;\n} counter;\nint add(int a, int b);\n");
  assert.equal(c.LEN, "#define LEN 10");
  assert.equal(c.counter, "typedef struct { … } counter");
  assert.equal(c.add, "int add(int a, int b)");
  const rb = sigs("a.rb", "Item = Struct.new(:id, :due) do\n  def overdue?\n    false\n  end\nend\n");
  assert.equal(rb.Item, "Item = Struct.new(:id, :due)");
});

test("Rust: `mod name;` is a symbol of its own", () => {
  same(outline("src/main.rs", "mod date;\nmod store;\n\nfn main() {}\n"), ["import:date", "import:store", "func:main"]);
});

test("a decision may name a member by its qualified tail (Store::due in namespace todo)", () => {
  const t = repo();
  try {
    t.write("a.cpp", "namespace todo {\n}\n");
    t.commit();
    t.hook("session-start");
    t.edit("a.cpp", "namespace todo {\n}\n", "namespace todo {\nint Store::due() const { return 1; }\n}\n");
    t.u("decide", "--title", "Add due", "--why", "w", "--for", "a.cpp:Store::due");
    const s = t.extract().symbols.find((s) => s.name === "todo::Store::due");
    assert.ok(s?.explained, "Store::due names todo::Store::due");
  } finally {
    t.cleanup();
  }
});

test("a card's rows have no gap between a removed line and the line that replaced it", () => {
  const d = page("a.hpp", `class Store {
public:
    void a();
private:
};
`, `class Store {
public:
    void a();
    void b();
protected:
};
`);
  const rows = d.symbols.find((s) => s.name === "Store").rows;
  const i = rows.findIndex((r) => r.t === "-");
  assert.equal(rows[i + 1]?.t, "+", JSON.stringify(rows));
});

test("C++: methods that return a reference or pointer are members too", () => {
  same(outline("a.hpp", `class Store {
public:
    const Todo& add(const std::string& title);
    Todo* find(int id);
    const std::vector<Todo>& list() const { return todos_; }
};
`), ["class:Store", "method:Store::add", "method:Store::find", "method:Store::list"]);
});
