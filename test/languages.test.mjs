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
`), ["import:std::collections::HashMap", "type:Point", "type:Area", "method:Area.area", "method:Point.area", "method:Point.new", "namespace:util", "func:util.helper", "var:MAX"]);
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

test("C++: namespaces, class members, out-of-class definitions, templates", () => {
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

template <typename T>
T twice(T v) { return v; }
}
`), ["import:<vector>", "namespace:app", "class:app.Store", "method:app.Store.Store", "method:app.Store.size", "field:app.Store.n", "method:Store.add", "func:app.twice"]);
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
