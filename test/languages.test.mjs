// Symbols per language. Each language is data (languages/<id>/); these pin what its outline finds.
import { test } from "node:test";
import assert from "node:assert/strict";
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

test("a language with no data is one whole-file change", () => {
  same(outline("notes.txt", "hello\n"), ["file"]);
});
