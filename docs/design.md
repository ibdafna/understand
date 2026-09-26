# Understand: design

## Goal

Someone installs the plugin and nothing else. Every agent session keeps a decision log; when a pull request is opened, a self-contained HTML page explains every changed symbol of the PR's diff: why it changed, which decision it came from, who made that decision, and where the explanation has gaps.

## Principles

1. **The decision log is the product.** Specific decisions (the choice, the reason, rejected alternatives, risks, who decided, and what it shaped) captured when they're made.
2. **Capture automatically; ask the agent only for what only it knows.** Hooks capture every change; the agent writes decisions, not prose about each symbol, until the explain step.
3. **Gaps stay visible.** A line no observed agent tool wrote, or an agent edit no decision names, is flagged. Text written afterwards never clears a flag.
4. **Simple.** Every mechanism must earn its place; when two designs give the same result, pick the one with fewer moving parts.

## Capture (every session, every git repo)

- **SessionStart** (startup, resume, clear, and after compaction) injects the decision-log rules. The `record` skill holds the details and isn't user-invocable.
- **PreToolUse** snapshots the worktree before Edit/Write/MultiEdit/NotebookEdit/Bash; changes found there weren't made by an agent tool and are recorded as unverified. **PostToolUse** and **PostToolUseFailure** snapshot after the tool: that transition is the tool's edit (for file tools, only the file they name; anything else is a side effect, unverified).
- **A recording** starts at the first tool call. One per feature branch, across sessions; one per session on the default branch; one per session and commit on a detached HEAD. A command that creates or renames the branch (`git switch -c`, `git branch -m`, judged by the branch's reflog) carries the recording along, so decisions made on `main` follow the work to its new branch. A switch to other existing code starts that recording from its committed state and is never an edit.
- **State lives outside the repo** in `~/.claude/understand/repos/<repo>/`: recordings, a private index, and a private object store that snapshots are written to. Nothing is written to the working tree, `.git`, or refs.
- **`understand decide --for <file>[:<Symbol>]`** records a decision right after its edits. It explains only what it names, and only among this turn's edits that already exist. A line is explained when a decision named the symbol it belonged to when it was written, so renaming a symbol later doesn't unexplain it. A short name (`run`) matches only when no other changed symbol in the file shares it; blank lines never need a reason of their own. Run from a person's terminal rather than an agent's command, `decide` never credits outstanding changes to the agent. `understand link D<n> --for …` names more for a decision recorded earlier. `--risk` and `--alt` capture risks and rejected options.
- **Stop** checks this turn's changed symbols. If non-trivial ones aren't named by any decision, it blocks once and lists them. Whatever remains is flagged on the page.
- Each captured edit keeps a pointer into the session transcript (local only), so a later explain pass can read the reasoning around it.
- **The shared decision log**: every `decide`/`link` rewrites `.decisions/<recording>.tsv` in the repo (one row per decision: id, date, who, title, why, what it shaped, rejected alternatives, risks, what it revises). The pre-tool hook stages it when the agent runs `git commit`, so each commit carries its reasons. It's excluded from the diffs Understand explains, and `git config understand.share false` turns it off. One file per recording, so branches never conflict.

## Explain

- **After `gh pr create`**, PostToolUse asks the agent to run the `explain` skill for the PR. `/understand:explain` works any time; without a PR, it asks what to explain.
- **Any range**: `--pr <ref>` (merge-base → committed HEAD, exactly the PR's diff), `--branch` (merge-base with trunk → working tree), `--staged`, `--uncommitted`, `--commits <a..b>`. Provenance is replayed through the recording regardless of the range; whatever the recording didn't see is "before recording" or "outside". Each range has its own explanation file, so one never describes another's code.
- **Without a local recording** (a reviewer's checkout, CI), the page is built from the checked-in `.decisions/` logs: symbols are matched to the decisions that name them, and the page says there's no line-level provenance.
- It writes the range's explanation (`explanations/<range>.json` in the recording): a title, an intent paragraph, chapters (reading order), and for every changed symbol a summary and attention level (with a one-line reason for careful and mechanical). `understand check` requires both.
- Beside each symbol's code the page shows why it is the way it is, from the decisions recorded while it was written: the reason, the rejected options, the risks. The explanation adds why / why-this-way / risk only where no decision says it; the page marks those as written afterwards, and the agent raises them with the user in the session. The work of explaining belongs in the coding session; hindsight only fills gaps.
- `understand render` produces the page; the agent adds a short review guide to the PR description with `gh pr edit` and gives the user the page's local path.

## Languages

- **Symbols come from one engine that knows no language.** Each language is a folder in `languages/`: `lang.json` (file extensions, the tree-sitter grammar, the Shiki grammar for the page, and a few node-type lists: wrappers like `export`, leading attributes, transparent blocks like `#ifdef`) and `outline.scm`, a tree-sitter query. Its captures name the item, its name and key, a qualifying scope (a Go receiver, a Rust `impl` type), its body (the signature is what precedes it), and a group of declarations sharing wrapper lines; `#set!` properties declare the kind and the few rules some languages need (a container of members, a block of one collapsing to its member, Go's iota ordinals, TypeScript overloads folding into their implementation).
- **Nesting is containment.** A container's members are what sits directly in its body; anything else nested (a function in a function) isn't a symbol. When two patterns find the same item, the earlier wins, so specific patterns come first.
- **A language is found by file name, then extension, then the `#!` line**, so `Makefile` and an extensionless `bin/todo` script are recognised. A folder with no tree-sitter grammar (shell, Make, JSON, YAML, TOML, CSS, HTML, SQL, Markdown, Dockerfile) only highlights: its files are whole-file changes. Rust and C++ name members with `::` (`lang.json` `separator`); a decision may name them with `.` or `::`, or by a qualified tail (`Store::due` for `todo::Store::due`).
- The engine replaced hand-written walkers for Go, TypeScript/JavaScript, and Python, checked symbol for symbol on 4,400 real files. Files in a language with no folder are one whole-file change. Why tree-sitter queries and not language servers, ctags, or per-language tools: `docs/research/polyglot-symbols.md`.

## Review comments

- On the page, a comment targets a line range in one symbol's diff (with the lines it quotes), a whole symbol, or a decision. Comments are kept in the browser, per branch, and can be edited or deleted.
- "Copy all as a prompt" gathers them in reading order, each with where it applies and its quoted code, for the user to paste into any agent. There's deliberately no channel back from the page: the agent answers in the session, and its changes and decisions show up on the next render.
- A line comment stays beside the code only while the lines it quotes are still there; otherwise it's listed with its quote and marked as changed.
- Diffs are drawn by `@pierre/diffs` (pinned), bundled with Shiki's JavaScript regex engine and inlined into the page (about 0.6 MB). Syntax grammars are separate: the build compiles each language's into `dist/highlight/`, and a page carries only those for the languages in its diff. Provenance flags are painted onto its lines after each render, as are the reading aids: the gutter numbers only the new file (a removed line is marked, not numbered, so numbers never run backwards), wrapped lines hang under their own indentation and break between tokens, and word highlights that cover most of a line are dropped (they only repeat that the line changed). The build brings every syntax colour of both themes to 4.5:1 against every background it can land on: context, added and removed rows, and the changed-word boxes.

## Harnesses

The plugin runs in Claude Code and in the Codex CLI. Codex loads the same manifest and hooks, with differences handled in code: its edit tool is `apply_patch` (files are read from the patch text), shell commands see `CODEX_SESSION_ID`, plugin `bin/` isn't on its PATH (session start gives the agent the CLI's full path), it has no failure event (a failed tool's changes surface as unverified at the next checkpoint), it ignores `user-invocable: false`, and it runs a plugin's hooks only after the user approves them in `/hooks`.

## Output

A single self-contained HTML file (inline CSS, JS, and data), with the notices of the software bundled into it. It follows the system's light or dark setting; a reader's override (System, Light, Dark in the top bar) is kept in the browser for every page and applied before the first paint. Publishing it where reviewers can open it comes later.

## Known trade-offs

- Every tool call costs two worktree snapshots (about 0.13 s each on a 20k-file repo); a long-lived recording makes each Stop check slower, since it re-derives provenance for the whole recording.
- `--by human` is the agent's claim, not verified.
- Subagents don't receive the rules; the main agent's stop check asks it to record decisions for their edits.
- Parallel tool calls in one worktree can be credited to the wrong call (still the agent's), and changes staged without touching the worktree (`git apply --cached`) aren't captured.
- PRs opened outside the agent aren't detected.
- History rewrites (reset, rebase) aren't tracked; a deleted and re-created branch reuses the old recording.
- A short name (`run`) is judged ambiguous against the final diff, not against the symbols that existed when the decision was recorded.
- Two symbols on one physical line share that line's provenance.
- Sparse checkouts can show files entering the sparse cone as added; Git LFS clean filters write to `.git/lfs` during snapshots.
- Trunk is detected in order: `git config understand.trunk`, a remote's HEAD, `init.defaultBranch`, a common name (`main`, `master`, `trunk`, `develop`), then (in small repos) the branch the most others descend from.
- If a PreToolUse hook fails, changes before that tool call can't be separated from the tool's own.
- Locking relies on POSIX directory renames; Windows isn't supported yet.
- Renamed files with edits appear as removal + addition.
