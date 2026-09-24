# Understand

Agents write more code than anyone reads. Understand records **why** each change was made while the agent works. Afterwards it renders a review page that explains every changed import, function, method, and class next to its diff.

- **Record:** while working, the agent logs each decision with `understand decide`: the choice, the reason, who made it (you or the agent), the alternatives it rejected, and which symbols it shaped. Hooks snapshot the worktree around every tool call, so each change is captured exactly, including ones made through the shell.
- **Narrate:** at the end, the agent turns the log into per-symbol explanations. It orders them as a story, marks how much attention each one needs, and lists the risks.
- **Stay honest:** every changed line is traced back to the tool call that wrote it. Lines no observed agent tool wrote (your own edits, other programs), agent edits with no decision behind them, and changes made before recording began are marked line by line and flagged **unexplained**. Nothing the narrator writes afterwards can clear that flag.
- **Review:** a single self-contained HTML file. You can read in story or file order, see the rationale beside the code or on hover, focus on one decision to see everything it touched, and track review progress with `j`/`k`/`x`.

See [`examples/todo-due-dates.html`](examples/todo-due-dates.html) for a report produced by a real Claude Code session.

## Use it with Claude Code

```sh
claude --plugin-dir /path/to/understand          # try it for one session
# or install it:
claude plugin marketplace add /path/to/understand
claude plugin install understand@understand-local
```

In a git repo:

1. `/understand:record` (or `understand init`) starts recording from the current worktree. Use `understand init --base main` to explain a whole branch.
2. Work as usual. The agent records decisions right after the edits they explain (`understand link D<n>` covers a decision it recorded earlier). If it ends a turn with edits it hasn't explained, the stop hook asks once; anything still unexplained when the turn ends stays that way.
3. `/understand:narrate` writes the explanation and opens the review page (`.understand/reports/latest.html`).

Recording is opt-in per repo, and hooks do nothing where `understand init` hasn't run. Everything lives in `.understand/`, which is added to `.git/info/exclude` and never committed.

Requires Node 20+ and git. Each tool call costs two worktree snapshots (about 0.13 s each on a 20,000-file repo).

## Development

```sh
npm install
npm test          # builds dist/ and runs the end-to-end test
```

`dist/` is committed so the plugin runs without an install step. Rebuild with `npm run build` after changing `src/` or `viewer/`.

| Path | What it is |
| --- | --- |
| `src/cli.ts` | `understand` commands |
| `src/hook.ts`, `src/capture.ts` | Claude Code hooks; each tool call becomes a snapshot → snapshot transition |
| `src/store.ts` | the log in `.understand/`: locked, append-only, per-session turns |
| `src/extract/` | tree-sitter symbols (Go, TS/JS, Python), symbol-level diff, per-line provenance |
| `src/narration.ts` | narration format and `understand check` |
| `viewer/viewer.html` | the review page template |
| `skills/` | `record` and `narrate` skills |
| `mockup/viewer.html` | the original design mockup, with hand-written data |
