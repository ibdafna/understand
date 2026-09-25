# Understand

Agents write more code than anyone reads. Understand keeps a **decision log** while the agent works, and when a pull request is opened it produces a review page that explains every changed import, function, method, and class next to its diff.

- **Just works:** install the plugin and use Claude Code as usual. Hooks remind the agent to keep the log, capture every change (including ones made through the shell), and ask for the review page when the agent opens a PR.
- **Decision log:** each decision records the choice, the reason, who made it (you or the agent), the rejected alternatives, known risks, and exactly which files and symbols it shaped. A decision explains only what it names.
- **Explain:** the agent turns the log into a note for every changed symbol, puts them in reading order, marks what deserves a careful look, and calls out risks. The page covers the PR's diff: its merge-base to the committed HEAD.
- **Honest gaps:** every changed line is traced to the tool call that wrote it. Lines no agent tool wrote (your own edits, other programs), agent edits no decision names, and changes from before recording are flagged, line by line. Nothing written afterwards clears a flag.
- **Review:** one self-contained HTML file. Read in story or file order, with the reason beside the code; focus on a decision to see everything it shaped, and track progress with `j`/`k`/`x`.
- **Comments:** comment on any line range (the **+** beside a line), a symbol, or a decision; edit or delete them as you go. "Copy all as a prompt" gathers them, each with where it applies and the code it quotes, to paste into your agent.

**[ibdafna.github.io/understand](https://ibdafna.github.io/understand)** has live example pages from real sessions in Claude Code and Codex.

## Install

**Claude Code**

```sh
claude plugin marketplace add ibdafna/understand
claude plugin install understand@understand
```

**Codex**

```sh
codex plugin marketplace add ibdafna/understand
codex plugin add understand@understand
```

Then, in Codex, open `/hooks` and trust Understand's hooks: Codex runs a plugin's hooks only after you approve them.

That's all. `/understand:explain` (in Codex, `$explain`) produces a page any time, for whatever you pick: the branch, staged or uncommitted changes, a commit range, or a PR. `understand off` stops recording in a repo (`--everywhere` for all).

## Update

**Claude Code:** `claude plugin marketplace update understand && claude plugin update understand@understand`, then start a new session.

**Codex:** `codex plugin marketplace upgrade understand && codex plugin add understand@understand`, then re-trust the hooks in `/hooks` if the release changed them.

## Good to know

**What lands in your repo:** only the decision log, `.decisions/<recording>.tsv`, one row per decision, committed along with the agent's commits so the reasons travel with the code (and anyone can build a page from them). Turn that off with `git config understand.share false`. Everything else (snapshots, provenance, pages) stays in `~/.claude/understand/`.

**Trunk:** Understand treats the default branch as trunk (one recording per session there, one per branch elsewhere). If it guesses wrong, set it: `git config understand.trunk <branch>`.

Requires Node 20+ and git. Each tool call that can change files costs two worktree snapshots (about 0.13 s each on a 20,000-file repo).

## Development

```sh
npm install
npm test          # builds dist/ and runs the tests
npm run ship      # release: bump the version, build, test, commit, tag, push to main
```

`dist/` is committed so the plugin runs without an install step; CI fails if it doesn't match the source. Plugin managers only update on a version change, so every push to `main` goes through `npm run ship` (CI fails a push that didn't bump the version). [`docs/design.md`](docs/design.md) explains how it works and why.

| Path | What it is |
| --- | --- |
| `hooks/hooks.json` | the hooks that make it automatic |
| `src/hook.ts`, `src/capture.ts` | hook handlers; each tool call becomes a snapshot → snapshot transition |
| `src/home.ts`, `src/store.ts` | per-repo state outside the repo; recordings and the decision log |
| `src/extract/` | tree-sitter symbols (Go, TS/JS, Python), symbol-level diff, per-line provenance |
| `src/decisionlog.ts` | the shared `.decisions/*.tsv` log |
| `src/explanation.ts`, `src/render.ts`, `viewer/` | the explanation format, its checks, and the page (diffs drawn by [@pierre/diffs](https://www.npmjs.com/package/@pierre/diffs), trimmed to our languages) |
| `skills/record`, `skills/explain` | keeping the log (internal) and writing the page |
| `site/`, `examples/` | the GitHub Pages site (deployed by CI) and the example pages it shows |

## License

MIT. See [LICENSE](LICENSE).

The built plugin in `dist/` includes third-party software; see [dist/THIRD_PARTY_NOTICES.md](dist/THIRD_PARTY_NOTICES.md).
