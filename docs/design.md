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
- It writes the range's explanation (`explanations/<range>.json` in the recording): a title, an intent paragraph, chapters (reading order), and for every changed symbol a summary and attention level, plus why / why-this-way / risk where useful. `understand check` requires a summary for every symbol. Risks recorded with decisions appear alongside, labelled by source.
- `understand render` produces the page; the agent adds a short review guide to the PR description with `gh pr edit` and gives the user the page's local path.

## Harnesses

The plugin runs in Claude Code and in the Codex CLI. Codex loads the same manifest and hooks, with differences handled in code: its edit tool is `apply_patch` (files are read from the patch text), shell commands see `CODEX_SESSION_ID`, plugin `bin/` isn't on its PATH (session start gives the agent the CLI's full path), it has no failure event (a failed tool's changes surface as unverified at the next checkpoint), it ignores `user-invocable: false`, and it runs a plugin's hooks only after the user approves them in `/hooks`.

## Output

A single self-contained HTML file (inline CSS, JS, and data). Publishing it where reviewers can open it comes later.

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
