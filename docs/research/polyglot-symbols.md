# Symbols for any language

Research date: 2026-09-25. **Question:** how can Understand split changed files into symbols for any language, with no per-language logic in our code and the best fidelity we can get? This document compares the options, gives measurements, and ends with a ranked recommendation.

Every claim cites its source. "Measured" means I ran it on this machine (macOS arm64, Node 26.0.0); the scripts are listed at the end. Anything I could not verify is marked **unverified**.

## Summary

**Recommendation: keep tree-sitter.** Replace the three hand-written walkers with one generic engine driven by per-language query files that we write and own. The engine derives nesting from range containment. Ship prebuilt grammar `.wasm` files taken from the official grammar npm packages. Keep today's whole-file fallback for languages without a grammar.

Under that design, the only per-language material is data: an extension list, a grammar file, and one `.scm` query file. Go, TypeScript and Python can keep everything they have today (imports, receivers, `const (`/`import (` groups, iota, `export` wrappers, overload folding), but only if the engine gains a few language-neutral features, described in the recommendation below.

**LSP `documentSymbol` should not be a tier, primary or fallback.** Four reasons:
- Its output differs by server and by machine. Understand saves symbol names in checked-in decision logs and matches them later in CI (`docs/design.md` lines 20 and 29), so names must not depend on which tools a machine has installed.
- Most servers drop imports.
- Most servers leave doc comments out of ranges.
- A server costs 70–1,300 ms per process start, and every hook is a fresh process.

**Universal Ctags and ast-grep are weaker than queries we write ourselves.**
- Ctags gives no end lines for 72 of 127 languages, TypeScript among them, and it is GPL.
- ast-grep's outline command is alpha, covers only 14 languages, and exists only in a 51 MB CLI.

## What Understand needs from a symbol extractor

`src/extract/symbols.ts` produces, for each file version, `FileSymbols { syms, groups }`:

- **`Sym.key`**: a stable identity made of a kind class plus a qualified name, for example `func:Store.Add`, `import:fmt` or `var:A`. Duplicates get `#2`, `#3` (`symbols.ts` L99–103). Keys pair old and new versions of a symbol (`src/extract/diff.ts` ~L105–130).
- **`kind`, `name`, `sig`**: `name` is qualified: Go `Store.Add`, TS `A.run`, `NS.inner`, Python `A.run`. `sig` is the declaration header up to the body, whitespace-collapsed (`symbols.ts` L135–138, L154–158).
- **`own`**: exact 1-based lines the symbol owns.
  - It includes contiguous doc comments directly above the symbol (`startWithComments`, L144–152).
  - A container excludes its members' lines (L106–108).
- **`cmp`**: the exact source used for equality. It is the doc comment plus the node text, with members cut out. "Equality means unchanged" (L31–32).
- **`iota`**: position inside a Go `const (` group that uses `iota` (L33–34, L195–207).
- **`Group`**: wrapper lines such as `import (`, `const (` and `)`, which travel with their members when the whole group appears or disappears (L37–41; `diff.ts` ~L139–150).
- **Per-language special cases in the walkers:**
  - Go: every `import_spec` is its own symbol; methods are named by receiver type.
  - TS/JS:
    - `export`/`declare` wrappers are unwrapped.
    - `namespace` is parsed as an expression statement.
    - Overload signatures fold into their implementation.
    - `get`/`set` accessors get distinct keys.
    - `export {…}` clauses become symbols.
    - An arrow function held in a `const` counts as a function.
  - Python: decorated definitions; module-level imports and assignments.

Where the extractor runs, and why it matters for the options below:
- **The Stop hook** runs a full `extract` every turn (`src/hook.ts` L157–160), and every hook is a new process (`hooks/hooks.json`).
- **Historical text, not the working tree.** Symbols are computed for old and new git blobs, and for the text each recorded edit wrote (`src/extract/index.ts` L125–141 and L438–455).
- **Without a recording** (a reviewer's checkout or CI), symbols are matched by name to the decisions checked into `.decisions/` (`docs/design.md` L29).
- **`--for file:Symbol`** matches a full name, or a short name (`run`) when it is unique (`docs/design.md` L20; `index.ts` ~L425–431).

**Consequence: the extractor must be deterministic across machines.** The same file must give the same keys and names on the author's laptop, a reviewer's laptop and CI. Otherwise a decision recorded for `Store.Add` stops matching.

Parse failures already degrade to a whole-file change (`index.ts` L138–141). Unknown extensions get the same treatment (`langOf` returns null).

---

## Option 1: LSP `textDocument/documentSymbol`

### What the protocol gives

- **Response type:** `DocumentSymbol[] | SymbolInformation[] | null`.
- **`DocumentSymbol` fields:** `name`, `detail` ("e.g the signature of a function"), `kind`, `tags`, `range`, `selectionRange` and `children`.
  - `range` is "The range enclosing this symbol not including leading/trailing whitespace but everything else like comments".
  - A client gets the hierarchy only if it declares `hierarchicalDocumentSymbolSupport`. Otherwise servers may return flat `SymbolInformation`, whose ranges "can not be used to re-construct a hierarchy".
  - Sources: [spec 3.17, documentSymbol](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#textDocument_documentSymbol); source file [`_specifications/lsp/3.17/language/documentSymbol.md`](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/language/documentSymbol.md) L5–8, L17–67, L183–234, L246–291.
- **`SymbolKind`** has 26 values (File=1 … TypeParameter=26, same file L123–150). Import is not one of them.
- **Positions** are zero-based, the end is exclusive, and columns are UTF-16 by default ([`types/position.md`](https://github.com/microsoft/language-server-protocol/blob/gh-pages/_specifications/lsp/3.17/types/position.md)).

### Measured: what real servers return

I measured with a minimal JSON-RPC client that sends `initialize` (hierarchical support on), `didOpen`, then `documentSymbol`. All four servers dropped imports (TypeScript 7 is the exception, below) and left leading comments out of `range`.

- **gopls v0.23.0**
  - `(*Store).Add` is a top-level Method, not nested under `Store`.
  - `import (…)` produced no symbols.
  - `const ( A = iota; B )` gave two Constants with no group.
  - `// Store keeps items.` on the line above `type Store` was outside the range (15–17).
  - `detail` is the function type (`func(x string)`).
- **pyright 1.1.414**
  - No imports.
  - Parameters appear as child Variables: `run` has child `n`.
  - The decorated `size` range includes its decorator.
  - `detail` is empty.
- **typescript-language-server 6.0.1 + typescript@5**
  - Returned symbols in **alphabetical order** (`A, f, g, P`), not source order.
  - No imports; `detail` empty.
  - A `get size()` accessor showed up as Method.
- **TypeScript 7.0.2 native (`tsc --lsp --stdio`)**
  - Source order.
  - The import binding `readFileSync` appeared as Variable.
  - The same getter was a Property, and `const f = () => …` was a Variable (typescript-language-server called it Constant).
  - **So two servers for the same language disagree on kinds and order.**
- **clangd (Apple 21.0.0)**
  - Hierarchical `namespace > class > members`.
  - The out-of-line definition `Store::Size` was a sibling named with its qualifier.
  - The comment above the class was excluded.
  - `detail` is the type (`int () const`).

Latency (one `initialize` plus one `documentSymbol` on a small file; three warm runs each, fresh process each time):

| Server | Total |
|---|---|
| TypeScript 7 `tsc --lsp` | ~72 ms |
| gopls | ~185 ms |
| clangd | ~182 ms |
| pyright | ~195 ms |
| typescript-language-server | ~336 ms |

- gopls on a real 346-line file inside the `golang.org/x/tools/gopls` module: **1,282 ms cold, ~340 ms warm**.
- For comparison, web-tree-sitter in-process: runtime + Go grammar load 9 ms; parse + query of that same file 7 ms.

**Failure found while measuring:** with npm's current `typescript` (7.0.2), typescript-language-server's `initialize` fails with "The TypeScript of the workspace (TypeScript 7.0.2 …)". Every `documentSymbol` then returns `[]` with no other error.
- TypeScript 7's npm package no longer ships `tsserver`; its `bin` is only `tsc`, backed by native platform packages (`npm view typescript@7.0.2 bin dependencies`).
- The native port's LSP lives in [microsoft/TypeScript `tsc/internal/ls/symbols.go`](https://github.com/microsoft/TypeScript/blob/main/tsc/internal/ls/symbols.go) (the repo's `main` is now the Go port; `microsoft/typescript-go` is archived per `gh api repos/microsoft/typescript-go`).

### Per-server behaviour from source

| Server | Install (official) | Imports? | Signature in `detail`? | Nesting, receivers | Range includes doc comments? |
|---|---|---|---|---|---|
| gopls | `go install golang.org/x/tools/gopls@latest` + Go toolchain ([gopls/doc/index.md](https://github.com/golang/tools/blob/master/gopls/doc/index.md)) | No: only `FuncDecl`/`GenDecl` specs ([symbols.go L37–75](https://github.com/golang/tools/blob/06cad12/gopls/internal/golang/symbols.go)) | Yes, function type (L210) | Methods top-level, named `(%s).%s` → `(*T).M` (L47) | No: `FuncDecl.Pos()` is `func`, `TypeSpec.Pos()` is the name, so `type` is excluded too |
| pyright / basedpyright | `npm i -g pyright` / `pip install basedpyright` ([pyright docs/installation.md](https://github.com/microsoft/pyright/blob/main/docs/installation.md)) | No: aliases skipped ([documentSymbolProvider.ts](https://github.com/microsoft/pyright/blob/5e17375/packages/pyright-internal/src/languageService/documentSymbolProvider.ts)) | No | Hierarchical; params and locals included | Classes and functions get the full node; variables get the name only |
| pylsp | `pip install python-lsp-server` | Yes by default (`jedi_symbols.include_import_symbols`, [CONFIGURATION.md](https://github.com/python-lsp/python-lsp-server/blob/develop/CONFIGURATION.md)) | No | **Flat** `SymbolInformation` + `containerName` ([symbols.py](https://github.com/python-lsp/python-lsp-server/blob/develop/pylsp/plugins/symbols.py)) | n/a |
| typescript-language-server | `npm i -g typescript-language-server typescript` (needs TS ≤6; npm 6.0.1 wants Node ≥22.22.2) | No: `alias` entries filtered ([document-symbol.ts L90–95](https://github.com/typescript-language-server/typescript-language-server/blob/master/src/document-symbol.ts)) | No (`detail: ''`, L47) | Hierarchical from tsserver `navtree` | No (`getStart()` skips trivia) |
| TypeScript 7 native | bundled in `typescript@7` (`tsc --lsp --stdio`) | Yes, as bindings ([symbols.go L199–215](https://github.com/microsoft/TypeScript/blob/main/tsc/internal/ls/symbols.go)) | No | Hierarchical | No (`SkipTrivia`, L292–347) |
| rust-analyzer | `rustup component add rust-analyzer` | No (`use` is not a symbol) | Yes (`fn(&self) -> T`) | `impl Foo` nodes with methods inside ([file_structure.rs](https://github.com/rust-lang/rust-analyzer/blob/1ad44dc/crates/ide/src/file_structure.rs)) | **Yes**: `text_range()` covers doc comments and attributes |
| jdtls | Needs Java 21+, per-project `-data` dir ([eclipse.jdt.ls README L45, L84](https://github.com/eclipse-jdtls/eclipse.jdt.ls)) | No (L229 of DocumentSymbolHandler.java) | Yes | Hierarchical | **unverified** |
| clangd | `brew install llvm` / `apt install clangd` ([clangd.llvm.org/installation](https://clangd.llvm.org/installation)) | `using namespace` only | Yes (type) | Hierarchical; out-of-line `Foo::f` as a sibling ([FindSymbols.cpp](https://github.com/llvm/llvm-project/blob/main/clang-tools-extra/clangd/FindSymbols.cpp)) | No |
| ruby-lsp | `gem install ruby-lsp` | No (classes, modules, defs, constants, `attr_*`) ([document_symbol.rb](https://github.com/Shopify/ruby-lsp/blob/main/lib/ruby_lsp/listeners/document_symbol.rb)) | — | Hierarchical | **unverified** |
| sourcekit-lsp | Swift toolchain / Xcode | — | — | Hierarchical; `// MARK:` comments become symbols | No ([DocumentSymbols.swift L84–87](https://github.com/swiftlang/sourcekit-lsp/blob/main/Sources/SwiftLanguageService/DocumentSymbols.swift)) |
| bash-language-server | `npm i -g bash-language-server` (Node ≥20) | — | — | **Flat** `SymbolInformation[]` ([server.ts L685–690](https://github.com/bash-lsp/bash-language-server/blob/main/server/src/server.ts)) | n/a |

Other ecosystems:
- **Kotlin:** JetBrains' [kotlin-lsp](https://github.com/Kotlin/kotlin-lsp) is Alpha.
- **C#:** `csharp-ls` needs the .NET 10 SDK.
- **PHP:** intelephense is proprietary.

### Claude Code and Codex

- **Claude Code plugins can declare LSP servers.** Put `lspServers` in `plugin.json` or a `.lsp.json` at the plugin root ([plugins reference, "lspServers"](https://code.claude.com/docs/en/plugins-reference)).
  - Required fields: `command` and `extensionToLanguage` (`".go": "go"`).
  - Optional fields: `args`, `transport`, `env`, `initializationOptions`, `settings`, `workspaceFolder`, `startupTimeout`, `shutdownTimeout`, `restartOnCrash`, `maxRestarts`, `diagnostics`.
  - Each extension gets one server, and the first one registered wins ([plugins/components](https://code.claude.com/docs/en/plugins/components)).
- **The user must install the binary.** A plugin "doesn't include the language server. Install the language server binary first" ([code-intelligence](https://code.claude.com/docs/en/plugins/code-intelligence)).
  - The server starts the first time Claude edits a matching file.
  - Cloud sessions don't start plugin language servers.
- **Anthropic's official LSP plugins** are config only, in [`anthropics/claude-plugins-official` `.claude-plugin/marketplace.json`](https://github.com/anthropics/claude-plugins-official/blob/main/.claude-plugin/marketplace.json):
  - clangd, csharp-ls, gopls, jdtls, kotlin-lsp, lua-language-server, intelephense, pyright, ruby-lsp, rust-analyzer, sourcekit-lsp, typescript-language-server.
  - jdtls and kotlin-lsp get `startupTimeout: 120000`.
- **What the model gets** ([tools reference, "LSP tool behavior"](https://code.claude.com/docs/en/tools-reference)):
  - Diagnostics after edits.
  - A read-only `LSP` tool that can, among other things, "List symbols in a file".
- **Hooks cannot reach those servers.**
  - The [hooks reference](https://code.claude.com/docs/en/hooks) defines `command`, `http`, `mcp_tool`, `prompt` and `agent` hooks. `mcp_tool` can call MCP servers, but nothing reaches LSP servers.
  - Whether an `agent` hook's subagent gets the LSP tool is **unverified**.
  - To use LSP from a hook, Understand would have to spawn and manage its own servers.
- **Codex CLI has no LSP integration.**
  - A grep of [openai/codex](https://github.com/openai/codex) at `f5ffa46` (2026-09-25) for `lsp`, "language server" and `documentSymbol` found only a transitive `lsp-types` crate via `starlark_syntax` (`codex-rs/Cargo.lock`, `codex-rs/execpolicy/Cargo.toml:28`).
  - Feature requests are open: [#8745](https://github.com/openai/codex/issues/8745), [#31504](https://github.com/openai/codex/issues/31504).

### Assessment

- **Fidelity: good for names, kinds and nesting in most servers, but uneven.**
  - Imports are missing in 6 of 8 servers checked; pylsp and TypeScript 7 are the exceptions.
  - `range` usually excludes doc comments despite the spec's wording, so `own` and `cmp` would need our own comment attachment, which is per-language.
  - Go receivers come back as `(*T).M` strings rather than nesting.
  - No group or iota information.
  - Signatures are missing in pyright and TypeScript.
- **Coverage: any language with a server**, which in practice means the ones users already have installed.
- **Install burden: high, and outside our control.** Each server is a user-installed binary; several need a toolchain (Go, Rust, Java 21, .NET 10, Node ≥22).
- **Runtime cost:** 70–340 ms warm and over 1 s cold, per server, per hook process. The Stop hook runs every turn. Servers that "index the whole project" also cost memory ([troubleshooting](https://code.claude.com/docs/en/plugins/troubleshooting)).
- **Per-language logic:** a table of "extension → server command, args, init options" is configuration, but it is per-language, and so is the normalization it needs:
  - kind mapping
  - flat vs hierarchical output
  - `(*T).M` vs `Foo::f` naming
  - comment attachment
  - server-specific quirks, such as typescript-language-server rejecting TS 7
  - Microsoft's [multilspy](https://github.com/microsoft/multilspy) (`language_server.py` L76–131 is an if/elif per language) and [Serena](https://github.com/oraios/serena) (`src/solidlsp/ls_config.py`, about 70 server IDs, each with its own extension matcher) show how much of this a working client carries.
- **Failure modes:**
  - The server is missing, or the wrong version is installed (TS 7 above).
  - The project isn't loadable (clangd without `compile_commands.json`, rust-analyzer without cargo metadata, jdtls without a workspace dir).
  - The server silently returns `[]` (seen above).
  - Results differ between the author's machine and CI, which **breaks name matching of recorded decisions**. This alone rules out LSP as a tier in a hybrid, because which tier runs would depend on the machine.

---

## Option 2: Universal Ctags

- **Output:** JSON Lines with `--output-format=json`. It needs a build with libjansson ([ctags-json-output(5)](https://docs.ctags.io/en/latest/man/ctags-json-output.5.html)).
  - Fields include `name`, `path`, `line`, `end`, `kind`, `scope`, `scopeKind`, `signature`, `typeref`, `access` and `roles`. `end`, `line` and `signature` are off by default and are enabled with `--fields=+neS`.
  - Language-specific fields (Go's `receiver`) need `--fields-<LANG>=`.
  - `--_interactive` takes buffers over stdin ([interactive mode](https://docs.ctags.io/en/latest/interactive-mode.html)).
- **Coverage:** 169 languages from `--list-languages`, 3 of them disabled.
  - 31 are regex "optlib" parsers and 5 are PEG parsers ([`main/parsers_p.h`](https://github.com/universal-ctags/ctags/blob/99b7257c979ea82fb0f3ef911e7cee347d230392/main/parsers_p.h) L41–50); the rest are hand-written C. It has no tree-sitter.
  - No parser for Swift, Scala, Dart, Zig, Solidity, Vue or Svelte.
- **End lines are the critical gap.** Nothing documents which parsers fill `end`. Running the official nightly with `--fields=+elS` over every `Units/parser-*.r` test input:
  - **55 of 127 languages emitted `end`**, among them C, C++, C#, Go, Java, Python, Ruby and Sh.
  - **72 emitted none, including TypeScript, JavaScript, Rust, PHP and Kotlin.**
  - The source agrees: `parsers/typescript.c`, `jscript.c` and `rust.c` never call `setTagEndLine`, while `go.c` (L912, L1306) and `python.c` (L1752) do.
  - Only 36 languages emitted `signature`, and TypeScript is not one of them.
- **Scope, receivers and imports** (tested on the nightly):
  - **Go:** a method gets scope `pkg.Store`, scopeKind `struct` ([`go.c` L858–879](https://github.com/universal-ctags/ctags/blob/99b7257c979ea82fb0f3ef911e7cee347d230392/parsers/go.c#L858-L879)). Imports are reference tags with role `imported`, and need `--extras=+r`.
    - **Bug:** a generic receiver `func (b *Box[T]) Put` gets scope `store.T` (`parseReceiver`, L780–822). No Units test covers it.
  - **Python:** methods are kind `member` with scope `A`. `end` is correct, signatures are joined across lines, and imports are reference tags ([ctags-lang-python(7)](https://docs.ctags.io/en/latest/man/ctags-lang-python.7.html)).
  - **TypeScript:** methods are scoped to their class, but there is no `end`, no signature and no import tags. Only `*.ts` is mapped, so `.tsx`, `.mts` and `.cts` are skipped by default (`typescript.c` L2525).
  - 27 known-bug tests are marked `.b` in the Units suite ([docs/testing-parser.rst](https://github.com/universal-ctags/ctags/blob/99b7257c979ea82fb0f3ef911e7cee347d230392/docs/testing-parser.rst) L243–262).
- **Install:**
  - Homebrew: `universal-ctags` 6.2.1 ([formula](https://formulae.brew.sh/formula/universal-ctags)).
  - Debian: trixie ships 5.9.20210829 ([sources.debian.org](https://sources.debian.org/src/universal-ctags/)).
  - **macOS already has a different `ctags`** on `PATH`: `/usr/bin/ctags` is BSD ctags and rejects `--output-format` (measured).
  - Official [nightly builds](https://github.com/universal-ctags/ctags-nightly-build): static Linux, macOS arm64/x86_64. The macOS arm64 binary is 4.0 MB unpacked, ad-hoc signed and not notarized (measured).
  - **No official WASM or npm build.** npm `universal-ctags@0.0.1` is an unrelated 2016 emscripten port.
- **License:** GPL-2.0-or-later ([COPYING](https://github.com/universal-ctags/ctags/blob/master/COPYING)).
  - Running a user-installed binary through pipes and arguments is normally two separate programs ([GPL FAQ #MereAggregation](https://www.gnu.org/licenses/gpl-faq.html#MereAggregation)).
  - Shipping the binary in `dist/` obliges us to provide the complete corresponding source or a written offer ([GPL FAQ #UnchangedJustBinary](https://www.gnu.org/licenses/gpl-faq.html#UnchangedJustBinary); COPYING §3).
  - That is legal alongside MIT code, but it is a real distribution obligation.
- **Assessment:**
  - Wide language coverage, but no exact ranges for most languages, and TypeScript is among the ones missing them.
  - Without `end` we cannot compute `own` or `cmp`, so for those languages ctags is no better than whole-file.
  - An installed binary varies by machine and version, which is the same determinism problem as LSP.
  - Accuracy relies on hand-written heuristic parsers with open known bugs, where tree-sitter gives a real parse tree.

---

## Option 3: tree-sitter queries from shared data files

We already parse with web-tree-sitter, and its `Query` API runs `.scm` query files. The runtime exposes `Query` (measured), so any collection of query files can drive a generic engine.

### (a) Upstream `queries/tags.scm` (the tree-sitter tags spec)

- **Spec** ([code navigation](https://tree-sitter.github.io/tree-sitter/4-code-navigation.html); [source](https://github.com/tree-sitter/tree-sitter/blob/master/docs/src/4-code-navigation.md)):
  - Captures are `@definition.{class,function,interface,method,module}` and `@reference.{call,class,implementation}` (L81–90), with an inner `@name` and an optional `@doc`.
  - Two predicates exist: `#strip!` and `#select-adjacent!`.
- **The tags crate** ([`crates/tags/src/tags.rs`](https://github.com/tree-sitter/tree-sitter/blob/master/crates/tags/src/tags.rs)):
  - `Tag` has a byte `range` for the whole definition node (unioned with the name, L512–513) and a `span` for the name only (L514).
  - It has **no parent or scope field**, and it rejects any capture name outside its vocabulary (L147–165).
  - The CLI's `tree-sitter tags` prints only the name position ([`crates/cli/src/tags.rs` L47–56](https://github.com/tree-sitter/tree-sitter/blob/master/crates/cli/src/tags.rs)).
- **Which of our 16 grammars ship `tags.scm`** (at the refs pinned in [vscode-tree-sitter-wasm `build/main.ts`](https://github.com/microsoft/vscode-tree-sitter-wasm/blob/v0.3.1/build/main.ts) L11–84):
  - **Ship it:** c-sharp, cpp, go, java, javascript, php, python, ruby, rust, typescript/tsx. TypeScript's file only adds to JavaScript's; the two are loaded together ([`tree-sitter.json` L23–26](https://github.com/tree-sitter/tree-sitter-typescript/blob/v0.23.2/tree-sitter.json)).
  - **Don't:** bash, css, ini, powershell, regex.
- **Content is thin for our purposes:**
  - **Go:** methods capture only `field_identifier`, so there is no receiver.
    - The `package`/`import`/`var`/`const` patterns carry only `@name` and no role, so the tags crate drops them.
    - The import pattern misses grouped `import (…)`, which is an `import_spec_list`.
    - It spells `#set-adjacent!` where `#select-adjacent!` is meant.
    - Source: [tree-sitter-go `queries/tags.scm`](https://github.com/tree-sitter/tree-sitter-go/blob/master/queries/tags.scm).
  - **Python and PHP:** methods are tagged `definition.function`.
  - **C#:** a stray bare `@module` capture at L23 ([tags.scm](https://github.com/tree-sitter/tree-sitter-c-sharp/blob/485f0bae0274ac9114797fc10db6f7034e4086e3/queries/tags.scm#L23)) would make the tags crate reject the file.
  - **None capture imports.**
- **Measured on our grammars:** all 10 files compile against @vscode's grammars, with no query/grammar version skew. On samples they:
  - found Go methods (no receiver) and Python methods (tagged as functions);
  - missed TS `namespace` (`internal_module`), enums, type aliases, class-field arrows and imports;
  - gave a TS class range that excluded `export`.
  - The runtime exposes the `#strip!`/`#select-adjacent!` directives through `query.predicatesForPattern(i)`, so an engine that needs them has to apply them itself.
- **License:** MIT, the same as the grammar repos, for example [tree-sitter-go LICENSE](https://github.com/tree-sitter/tree-sitter-go/blob/master/LICENSE).

### (b) nvim-treesitter-textobjects and nvim-treesitter

- **[nvim-treesitter-textobjects](https://github.com/nvim-treesitter/nvim-treesitter-textobjects)** (Apache-2.0): 79 `queries/<lang>/textobjects.scm` on `main`, with `@function.outer`, `@class.outer`, `@parameter.*` and so on ([BUILTIN_TEXTOBJECTS.md](https://github.com/nvim-treesitter/nvim-treesitter-textobjects/blob/main/BUILTIN_TEXTOBJECTS.md)).
  - **No `@name` capture**, so you get ranges without names.
  - Some files use Neovim-only directives (`#offset!`, `#lua-match?`) and `; inherits:`.
- **[nvim-treesitter](https://github.com/nvim-treesitter/nvim-treesitter)** (Apache-2.0): 323 language query directories (highlights, injections, folds, indents, locals). It has no tags and no outlines.
  - `main` is "a full, incompatible, rewrite", and `master` is locked (README L12–13).

### (c) Zed `outline.scm`

- **Captures:** `@item` and `@name` are required; `@context`, `@context.extra`, `@annotation`, `@open` and `@close` are optional ([`crates/language_core/src/grammar.rs` L118–127](https://github.com/zed-industries/zed/blob/main/crates/language_core/src/grammar.rs)).
  - Nesting comes from range containment ([`crates/language/src/buffer.rs` L4910–4938](https://github.com/zed-industries/zed/blob/main/crates/language/src/buffer.rs)).
  - This is the closest existing design to what Understand needs.
  - The Go file captures `func` and the receiver tokens as `@context`, which displays as `func (s *Store) Add` ([go/outline.scm L21–32](https://github.com/zed-industries/zed/blob/main/crates/grammars/src/go/outline.scm)). No outline file captures imports.
- **Core languages** (now in `crates/grammars/src/`): c, cpp, css, go, javascript, json, jsonc, markdown, python, rust, tsx, typescript, yaml.
  - Many more languages come from extensions, many under Apache-2.0 or MIT (spot-checked: [zed-extensions/java](https://github.com/zed-extensions/java), csharp, php, ruby, powershell).
- **Measured:** Zed's go, python, typescript, tsx, rust, cpp and css outlines compile against our grammars. Nesting by containment gave `Store > items`, `class A > def run > def inner`, and `namespace NS > function inner()`.
  - Zed's javascript file fails ("Bad node name 'internal_module'") because Zed runs JavaScript with the tsx grammar.
- **License: the core queries are GPL-3.0-or-later.** `crates/languages` and `crates/language` declare GPL-3.0-or-later, and `crates/grammars` ships `LICENSE-GPL` (Zed [README L32](https://github.com/zed-industries/zed/blob/main/README.md): "licensed primarily under GPL-3.0-or-later, with Apache-2.0 components where marked").
  - **Do not copy them into this MIT project.** Use the capture design, not the files.

### (d) Aider's repo map

- **Queries:** `aider/queries/tree-sitter-language-pack/` (31 `*-tags.scm`) and `aider/queries/tree-sitter-languages/` (27), 42 languages distinct. They are "adapted from" or "modified versions of" upstream `tags.scm` files (READMEs in [aider/queries](https://github.com/Aider-AI/aider/tree/main/aider/queries)).
  - Captures are renamed to `@name.definition.X` and `@name.reference.X`.
  - Aider is Apache-2.0; the query files carry no license of their own and derive from mostly-MIT upstreams.
- **How they are used:** [`repomap.py`](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py) keeps `(rel_fname, fname, line, name, kind)` (L29), with only the **name's start row** (L319–333). It never uses definition ranges, so its queries are tuned for naming, not for spans.

### (e) Other query collections

- **[aerial.nvim](https://github.com/stevearc/aerial.nvim)** (MIT): 61 `queries/<lang>/aerial.scm`, covering 14 of our 16 grammars. Captures are `@symbol`, `@name`, `@start`/`@end`, with `#set! "kind"` using LSP kind names.
  - The Go file captures `@receiver`.
  - **It is the most directly reusable outline-oriented set under a permissive license.**
- **[Helix](https://github.com/helix-editor/helix)** (MPL-2.0): 341 query dirs, 77 of them with `tags.scm` and 158 with `textobjects.scm`.
  - MPL-2.0 is file-level copyleft: copied files stay MPL, but they can live inside an MIT project ([MPL-2.0 §3.3](https://www.mozilla.org/en-US/MPL/2.0/)).
- **Continue** (Apache-2.0): its Go snippet query captures `@receiver`, `@parameters` and `@return_type`, which is useful for signatures.
- **Roo-Code** (Apache-2.0) is archived. **Cline** removed its tree-sitter definitions in v4.x.
- **No Node library** for query-driven outlines across many languages exists on npm (`tree-sitter-outline` and `code-outline` do not exist).

### (f) Getting grammars for Node/WASM

- **[@vscode/tree-sitter-wasm](https://www.npmjs.com/package/@vscode/tree-sitter-wasm)** 0.3.1 (MIT): 16 grammars, 22.1 MB unpacked.
  - Measured ABIs: 15 for bash, c-sharp, css, go, ini, javascript, php, python, regex, rust; 14 for cpp, java, powershell, ruby, tsx, typescript.
  - Its `build/main.ts` builds the runtime from tree-sitter `v0.25.10`.
  - Its shipped `cgmanifest.json` says 0.25.1 but pins commit `fc15f62`, which is tree-sitter 0.22.2 (`gh api repos/tree-sitter/tree-sitter/commits/fc15f62…`), so the manifest is stale.
- **The official grammar npm packages ship prebuilt `.wasm`**, and most ship `queries/tags.scm` too (`npm pack --dry-run`):
  - With both: go, rust, java, c, cpp, ruby, python, typescript (+tsx), javascript, c-sharp, php, scala, ocaml, elixir, lua.
  - With `.wasm` but no tags: bash, haskell, json, html, css, zig, yaml, toml.
  - Kotlin, Swift and Markdown publish `.wasm` as GitHub release assets instead ([fwcd/tree-sitter-kotlin](https://github.com/fwcd/tree-sitter-kotlin/releases), [alex-pinkus/tree-sitter-swift](https://github.com/alex-pinkus/tree-sitter-swift/releases)).
  - **All 32 loaded on our 0.25 runtime and on web-tree-sitter 0.27.0** (measured).
  - These packages run `node-gyp-build` on install, so extract the `.wasm` from the tarball at build time rather than depending on the package at runtime.
- **ABI rules:** the runtime accepts languages whose ABI is between `TREE_SITTER_MIN_COMPATIBLE_LANGUAGE_VERSION` (13) and `TREE_SITTER_LANGUAGE_VERSION` (15) ([`lib/include/tree_sitter/api.h` L29, L35](https://github.com/tree-sitter/tree-sitter/blob/master/lib/include/tree_sitter/api.h); [`lib/binding_web/src/parser.ts` L164–169](https://github.com/tree-sitter/tree-sitter/blob/master/lib/binding_web/src/parser.ts)).
  - Separately, since tree-sitter moved WASM builds to wasi-sdk ([PR #4393](https://github.com/tree-sitter/tree-sitter/pull/4393)), web-tree-sitter ≥0.26 requires a `dylink.0` section. Older emscripten builds carry `dylink`.
- **[tree-sitter-wasms](https://github.com/Gregoor/tree-sitter-wasms)** (Unlicense, 36 grammars, 51.8 MB) is built with tree-sitter-cli 0.20.8.
  - All 36 files fail to load on web-tree-sitter 0.26 and 0.27 (measured). On 0.25, `elm` and `ql` crash, and `yaml` fails on our runtime.
  - The upgrade PR ([#52](https://github.com/Gregoor/tree-sitter-wasms/pull/52)) was closed unmerged. **Avoid it.**
- **[tree-sitter-language-pack](https://github.com/xberg-io/tree-sitter-language-pack)** (MIT) claims 371 languages.
  - Its native Node builds download parsers from GitHub releases on first use (`crates/ts-pack-core/src/download.rs` L22), which is not offline.
  - Its WASM package is one 56 MB file with a "curated grammar subset". In Node it listed **32** languages, behind its own API rather than web-tree-sitter.
  - Not a fit.
- **Long tail:** the tree-sitter wiki [List of parsers](https://github.com/tree-sitter/tree-sitter/wiki/List-of-parsers) has about 438 distinct grammars. Most have no prebuilt `.wasm`; we would build them ourselves with `tree-sitter build --wasm` in our CI, not on users' machines.
- **Size reference** (@vscode files, measured):

  | Grammar | Size |
  |---|---|
  | go | 217 KB |
  | python | 458 KB |
  | javascript | 412 KB |
  | java | 415 KB |
  | php | 1.06 MB |
  | rust | 1.11 MB |
  | bash | 1.38 MB |
  | typescript | 1.41 MB |
  | tsx | 1.45 MB |
  | ruby | 2.1 MB |
  | c-sharp | 5.1 MB |
  | cpp | 5.4 MB |

  Today's `dist/` is 7.2 MB. Thirty mainstream grammars would plausibly add 25–40 MB (an estimate, not measured).

### Assessment

- **Fidelity: as good as the queries we write.**
  - Tree-sitter gives exact byte and line ranges for every node, doc comments as sibling nodes, and full parse trees for signatures.
  - Receivers, `export` wrappers, decorators and grouped declarations can all be captured.
  - What no existing query set provides is **imports, receivers-as-scope and grouping** together, so we write our own files.
- **Coverage:** every language with a grammar. That is 16 today, about 30 from official prebuilt `.wasm`, and 400+ if we build our own.
- **Runtime:** in-process, offline, milliseconds, deterministic for a given bundled grammar version. Nothing to install.
- **License:** grammars are mostly MIT (check each; elixir is Apache-2.0). Queries we write are ours. aerial (MIT) and the upstream `tags.scm` files are safe starting points; Apache-2.0 sources need their notices; Zed core queries are off-limits.
- **Failure modes:**
  - A query or grammar mismatch after a grammar upgrade: a node type is renamed and the query fails to compile. This is caught at build time by compiling every query in tests.
  - Parse errors: tree-sitter still produces a tree with `ERROR` nodes, and today's fallback handles exceptions.

---

## Option 4: ast-grep

- **Languages:** 27 built in per the [languages page](https://ast-grep.github.io/reference/languages.html). 0.45.3 also handles Dart; Zig is on `main` only.
  - Custom languages load compiled tree-sitter shared libraries (`.so`/`.dylib`/`.dll`) through `customLanguages` ([custom language](https://ast-grep.github.io/advanced/custom-language.html)). That means native builds per platform.
- **Outline:** it now has one, contrary to the usual assumption. `ast-grep outline --json`, "an alpha preview in ast-grep 0.44.0" ([outline guide](https://ast-grep.github.io/guide/outline-code.html)).
  - It uses bundled YAML rules for 14 languages: Rust, TS, JS, Python, Go, Kotlin, Java, Swift, C#, C++, C, Ruby, PHP, Markdown ([`crates/outline/src/default_rule.rs` L7–34](https://github.com/ast-grep/ast-grep/blob/6602aeb97d387b01e6ef4e49a6d07578dbf645cd/crates/outline/src/default_rule.rs)).
  - Other languages return `"items": []` with no error (measured on Lua and Dart).
  - Output has only two levels, item and direct members ([`model.rs`](https://github.com/ast-grep/ast-grep/blob/6602aeb97d387b01e6ef4e49a6d07578dbf645cd/crates/outline/src/model.rs)).
  - "Go receiver methods remain top-level items" ([outline rules](https://ast-grep.github.io/reference/outline-rules.html)).
  - Signatures fall back to the first non-empty line, so a multi-line Go signature is truncated to `func (s *Store) Add(item string,`.
  - Imports are flagged `isImport`.
  - The TypeScript rules miss `abstract class` (measured).
- **Distribution:** outline exists **only in the CLI**, and the CLI binary is about 51 MB per platform (darwin-arm64). `@ast-grep/napi` (7–8 MB per platform, 9 platforms) has no outline API.
  - `@ast-grep/wasm` (1.8 MB, needs `web-tree-sitter`) exists, but outline is not documented for it (**unverified**).
  - The ast-grep LSP has no `documentSymbolProvider` ([`crates/lsp/src/lib.rs` L91–101](https://github.com/ast-grep/ast-grep/blob/6602aeb97d387b01e6ef4e49a6d07578dbf645cd/crates/lsp/src/lib.rs)).
- **License:** MIT.
- **Assessment:** it is the same approach as Option 3 (tree-sitter plus per-language rule data), with less control and fewer languages. Its languages still need per-language rules, so it does not remove per-language data. Its MIT YAML rules are useful reference material.

---

## Option 5: language-native tools

| Tool | Outline with ranges? | Source |
|---|---|---|
| `gopls symbols <file>` | Prints `Name Kind L:C-L:C` using **selectionRange** (the name), one level of children, sorted by name. No body end. | [`gopls/internal/cmd/symbols.go`](https://github.com/golang/tools/blob/master/gopls/internal/cmd/symbols.go) L93–113 |
| `go doc`, `go/ast` | `go doc` has no ranges. `go/ast` has full positions but needs a Go program we would compile and ship. | — |
| `rust-analyzer symbols` | Exists: "Parse stdin and print the list of symbols". Prints Rust `{:?}` of `StructureNode` with byte `node_range`, parent index, kind and detail. Full ranges, but in a debug format. | [`flags.rs` L47–48](https://github.com/rust-lang/rust-analyzer/blob/master/crates/rust-analyzer/src/cli/flags.rs), [`cli/symbols.rs`](https://github.com/rust-lang/rust-analyzer/blob/master/crates/rust-analyzer/src/cli/symbols.rs), [`file_structure.rs` L9–17](https://github.com/rust-lang/rust-analyzer/blob/master/crates/ide/src/file_structure.rs) |
| ruff | No symbols command. `ruff analyze graph` gives only the file import graph. | [`crates/ruff/src/args.rs` L189–192](https://github.com/astral-sh/ruff/blob/main/crates/ruff/src/args.rs) |
| TypeScript | tsserver `navtree` and `LanguageService.getNavigationTree` give spans. They need `typescript@≤6`; 7.x drops the JS language service from its exports. | [`src/server/protocol.ts`](https://github.com/microsoft/TypeScript/blob/release-6.0/src/server/protocol.ts) L3024, L3061–3066 |
| Python `ast` / `pyclbr` | `ast` nodes have `end_lineno` since 3.8. `pyclbr` has it in the source since 3.10, but it is undocumented. | [What's new 3.8](https://docs.python.org/3/whatsnew/3.8.html), [`Lib/pyclbr.py`](https://github.com/python/cpython/blob/main/Lib/pyclbr.py) |

**Why this puts per-language logic back:**
- Every tool is a different program with a different output format (text columns, Rust debug output, JSON, Python objects). Each needs its own parser in our code.
- Each needs a toolchain on the user's machine: Go, rustup, Python ≥3.8, a TS ≤6 install.
- Each covers exactly one language.
- It is Option 1 without the shared protocol, so it is strictly worse.

---

## Option 6: other approaches

- **difftastic** ([languages supported](https://difftastic.wilfred.me.uk/languages_supported.html); MIT): 53 programming languages and 10 text formats.
  - It compiles tree-sitter grammar crates, plus four vendored parsers, into its binary.
  - It has no outline output. It shows that bundling many grammars is routine; the per-language material in difftastic is a small config entry per language.
- **SCIP** ([scip.proto](https://github.com/scip-code/scip/blob/main/scip.proto) L742–804; Apache-2.0): `Occurrence.enclosing_range` for definitions is documented as "the entire definition AST node", with "Symbol outline" given as a use.
  - Indexers are per language (scip-typescript, scip-python, scip-go, scip-java, rust-analyzer, scip-clang, …). They usually need a build or type-check setup.
  - Which indexers actually fill `enclosing_range` is **unverified**.
  - Offline indexing in hooks is not realistic.
- **GitHub code navigation:** the current docs describe only the search-based, tree-sitter approach, for 21 languages ([docs source](https://github.com/github/docs/blob/main/content/repositories/working-with-files/using-files/navigating-code-on-github.md), [language list](https://github.com/github/docs/blob/main/data/reusables/search/code-nav-supported-languages.md)).
  - `github/semantic` and `github/stack-graphs` are both archived (`gh api repos/github/{semantic,stack-graphs} --jq .archived` → `true`).
  - The industry-standard "any language" answer at GitHub scale is tree-sitter plus per-language query files.
- **LLM segmentation:** ask a model to split the file.
  - Pros: any language, and it can follow intent.
  - Cons:
    - Not deterministic, which breaks key stability across machines and runs.
    - Needs network and tokens, so it doesn't fit an offline plugin.
    - Line ranges must be validated.
    - It is slow in a Stop hook.
  - Claude Code's `prompt` hooks return an allow/block decision, not structured output ([hooks](https://code.claude.com/docs/en/hooks)).
  - At most, a model could help **write** query files during development. It should not run at extraction time.

---

## Comparison

| | Names | Kinds | Nesting / receivers | Signatures | Imports | Exact ranges (incl. docs) | Languages | Runtime / install | Size | License | Deterministic across machines |
|---|---|---|---|---|---|---|---|---|---|---|---|
| **Today** (hand-written walkers) | ✔ | ✔ | ✔ `Store.Add`, `A.run` | ✔ | ✔ each | ✔ | 3 families (Go, TS/JS, Py) | in-process wasm, none to install | ~7 MB dist | MIT | ✔ |
| **LSP documentSymbol** | ✔ | ✔ (varies by server) | mostly ✔; Go `(*T).M` flat; clangd `Foo::f` sibling | some servers | ✘ in most | ranges ✔, docs usually ✘ | any with a server | user installs server + toolchain; 70 ms–1.3 s per process | 0 bundled | per server | ✘ |
| **Universal Ctags** | ✔ | ✔ | ✔ scope (Go generic receiver bug) | 36 langs | Go/Py as refs; ✘ TS | `end` in 55/127 langs; ✘ TS/JS/Rust | ~166 | user installs, or we ship a 4 MB GPL binary per platform | 4 MB/platform | GPL-2.0+ | ✘ if user-installed |
| **tree-sitter + upstream tags.scm** | ✔ | coarse | ✘ (containment only; no receivers) | ✘ | ✘ | ✔ | ~15 with files | in-process | grammar wasm | MIT | ✔ |
| **tree-sitter + our own outline queries** | ✔ | ✔ | ✔ via containment + `@context` | ✔ | ✔ | ✔ | every grammar we ship (~30 easy, 400+ possible) | in-process, nothing to install | +~1 MB per grammar avg (est.) | MIT (ours) + grammars' | ✔ |
| **ast-grep outline** | ✔ | ✔ | 2 levels; Go receivers flat | first line only | ✔ flag | ✔ | 14 | 51 MB CLI per platform | 51 MB | MIT | ✔ (if bundled) |
| **Native tools** | varies | varies | varies | varies | varies | varies | 1 each | toolchain per language | 0 | varies | ✘ |
| **LLM** | ~ | ~ | ~ | ~ | ~ | needs checking | any | network, tokens | 0 | — | ✘ |

---

## Recommendation (ranked by fit)

### 1. One generic tree-sitter engine plus our own per-language query files (recommended)

**Architecture:**
- **`languages/<id>/`** is pure data:
  - `lang.json`: file extensions and grammar file name.
  - the grammar `.wasm`: vendored at build time from the official npm tarball or release asset, or from @vscode.
  - `outline.scm`: the query.
- **`symbols.ts`** becomes one engine with no language names in it. It:
  1. runs the query;
  2. builds items from `@item` + `@name` captures, and nests them by range containment (as Zed and aerial do);
  3. derives qualified names from ancestors, e.g. `A.run` and `NS.inner`;
  4. computes `own`, `cmp`, `sig`, groups and keys with today's `Builder`. The `Builder` is already language-neutral (`symbols.ts` L90–123).
- **Capture vocabulary, informed by Zed but our own files:**
  - `@item`: the full span, including wrappers like `export_statement`, `decorated_definition`, `ambient_declaration`.
  - `@name`: repeatable, joined with `, ` for Go `a, b = …`.
  - `@scope`: overrides the qualifier. For a Go receiver's type identifier this gives `Store.Add` without language code.
  - `@key.prefix`: for example the `get`/`set` keyword, so accessors key apart.
  - `@body`: `sig` = item text before the body; otherwise the first line.
  - `@doc`: comment siblings. As a language-neutral fallback, the engine can attach contiguous preceding siblings whose node type contains `comment`.
  - `@group`: the wrapper node (`import (`, `const (`) whose leftover lines travel with its members.
  - Kind: via `#set! kind "method"`, mapped to key classes by today's `kindKey`.
- **Two generic engine rules replace today's special cases:**
  - **Ordinal members:** a `#set! ordinal` on a pattern means position within the `@group` is part of identity. That expresses Go's implicit-iota rule as data, using a `#match? @group "\\biota\\b"` predicate and a negated `!value` field. How well those predicates behave in the 0.25 runtime is **unverified**; build-time tests would settle it.
  - **Merge adjacent same-key signatures into the next item:** `#set! merge-into-next` expresses TS overload folding.
- **Whole-file fallback** for extensions with no language directory, exactly as today.

**What remains per-language:** only data. An extension list, one grammar file, and one query file, plus the test fixtures we'd write for them. There is no code.

**Fidelity versus today:**
- **Go, TS/JS, Python:** nothing is lost if the queries are ported from the current walkers and the engine has the features above. Specifically:
  - imports as individual symbols (Go `import_spec`, each TS `import_statement`, module-level Python imports anchored to `module`);
  - Go receivers via `@scope`;
  - Go `const (`/`import (` groups via `@group`;
  - iota via the ordinal rule;
  - TS `export`, `declare` and `namespace` wrappers via `@item` on the wrapper, with the `internal_module` pattern written as data;
  - `export {…}` clauses as items;
  - overload folding via the merge rule;
  - accessor keys via `@key.prefix`.
  - The risk is porting effort. The existing tests in `test/` should pass unchanged against the query-driven engine before the walkers are deleted.
- **New languages:** fidelity is whatever the query captures. Good starting points:
  - aerial.nvim (MIT, 61 languages, has `@receiver`);
  - the upstream MIT `tags.scm` files for definitions;
  - Helix `tags.scm`/`textobjects.scm` (MPL-2.0, keep them as separate MPL files).
  - Imports, receivers and groups will need writing per language. That is data work, a few dozen lines of `.scm` each.

**Grammar sourcing:**
- Start with the @vscode 16 grammars plus the official npm-published `.wasm`s: C, Scala, OCaml, Elixir, Lua, Haskell, Zig, YAML, TOML, JSON, HTML, CSS, and Kotlin and Swift from their releases. That is about 30 languages; all loaded on our runtime and on 0.27.
- Pin versions and check that every query compiles against every grammar in CI.
- Avoid `tree-sitter-wasms` (dead on runtimes ≥0.26).
- If a grammar has no prebuilt wasm, build it in our CI with `tree-sitter build --wasm`.

**Adjacent change:** the viewer's highlighting also knows only our languages. `hlLang` returns go, py, ts or plain (`symbols.ts` L19–22), and the Shiki bundle is trimmed to them (`scripts/build.mjs` L25). Per-language highlighting grammars would belong in the same `languages/<id>/` data directory.

### 2. The same, plus an opt-in external fallback (not recommended by default)

For extensions with no bundled grammar, Understand could call a user-installed Universal Ctags when that language's parser emits `end`. It would have to use `--output-format=json --fields=+neS` and detect BSD ctags first.

This adds languages without adding bundled size, but:
- the page and the decision matching would differ between machines that do and don't have ctags;
- 72 of 127 parsers give no end lines;
- we'd need ctags-specific normalization.

If used at all, it should be explicitly opt-in, and the page should say symbols came from ctags.

### 3. LSP documentSymbol when a server is available, else queries, else whole file (not recommended)

This is the hybrid in the question. It fails Understand's core invariant: the tier used, and so each symbol's key and name, depends on what is installed where the page is built.
- **Author's machine with gopls:** a decision recorded for `Store.Add` against a tier-1 `(*Store).Add` symbol can't be reconciled in CI, where tier 2 names it `Store.Add`. The same happens between typescript-language-server (alphabetical order, `get size` → Method) and TS 7 (`get size` → Property).
- **Content gaps** even when a server is present:
  - imports are missing in most servers;
  - doc comments are outside ranges;
  - there is no group or iota information.
  - We'd still need tree-sitter to fill those gaps, which means running both.
- **Cost:** 70–340 ms per server per hook process warm, over 1 s cold, and Stop runs every turn. There is no way to reuse Claude Code's running servers from a hook, and Codex has none.

LSP could still help as a **development aid**. Comparing its outline with our query output on a corpus would catch missing captures while writing a new language's query file.

### 4. ast-grep outline, native tools, SCIP, LLM (not recommended)

- **ast-grep:** 14 languages, alpha, and a 51 MB CLI per platform, for what Option 1 does in-process.
- **Native tools, SCIP:** per-language programs and toolchains.
- **LLM:** not deterministic and not offline.

---

## Measurements and scripts

All scripts are in the session scratchpad and are not part of the repo:
- **LSP client:** `lsp/lsp.mjs` and `lsp2.mjs` (the latter retries empty results). Samples: `lsp/s.go`, `s.py`, `s.ts`, `a.cpp`.
  - Servers: gopls v0.23.0 via `GOBIN=… go install`; pyright, typescript-language-server 6.0.1, typescript 5.x and 7.0.2 from npm into the scratchpad; Apple clangd 21.0.0.
- **In-process timing:** `tsparse.cjs`, using the @vscode runtime and `tree-sitter-go.wasm`.
- **ABI checks:** `abi.cjs`.
- **Ctags and ast-grep comparisons:** `ctags-vs-sg-samples/`. The `end`-field survey is `units.jsonl`, from the official ctags nightly `uctags-2026.09.23-macos-15.0-arm64`.

Not verified:
- Whether an `agent` hook's subagent can call Claude Code's LSP tool.
- jdtls and ruby-lsp range treatment of doc comments.
- Which SCIP indexers fill `enclosing_range`.
- Exact behaviour of `#match?` and negated-field predicates for the proposed iota rule in web-tree-sitter 0.25.
- The licenses of every individual grammar beyond the ones named.
