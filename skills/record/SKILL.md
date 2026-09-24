---
name: record
description: Record the decisions behind code changes while working, so they can be reviewed later with understand:narrate. Use when the user asks to record, track, or explain a session with Understand, or when a hook says Understand is recording this repo.
---

# Record decisions

Every code change should trace back to a **decision**: a choice you or the user made, captured at the moment it was made. Hooks capture *what* changed; only you can capture *why*. The review page later shows each changed symbol next to the decisions behind it, and flags changes with none as **unexplained**.

## Start

If `understand status` says it isn't recording, run `understand init`. The baseline is the current worktree, so only changes from here on are explained. `understand init --base <ref>` (e.g. `--base main`) widens the diff to the whole branch, but commits made before recording have no captured reasons: they show as "before recording", never as explained.

## While working

Run `understand decide` for each decision right after the edits it explains: it explains every edit made since the previous decision. If you recorded a decision before acting on it, run `understand link D<n> --for …` after those edits instead.

```
understand decide --by agent|human --title "<the choice, as a short imperative>" \
  --why "<the reason in the moment: the constraint, evidence, or preference that drove it>" \
  --for <file>:<Symbol>                  # repeat for every function, method, type, or import it shaped
  --alt "<rejected option>: <why not>"   # repeat per alternative
```

`--for` is the link a reviewer sees: each changed symbol shows the decisions that name it. Name symbols as they appear in code (`store/store.go:Store.Due`, `web/api.ts:fetchJSON`, `main.go:main`, an import path like `main.go:strconv`); a bare file (`--for main.go`) covers every symbol in it. Name the specific symbols each decision shaped, especially when one command implemented several decisions at once: record them one after another, each naming its own symbols. `--for` only binds to edits from the current turn; it can't retroactively explain older edits.

What counts as a decision:
- choosing between approaches, libraries, data shapes, or where code lives
- a constraint or preference the user stated, or a proposal of yours the user approved or rejected (`--by human`)
- deleting or replacing existing code, or adding a dependency
- a failed test, error, or discovery that changed course: record it with `--supersedes D<n>` when it revises an earlier decision
- mechanical batches (renames, formatting, moves, regenerated files): `understand decide --mechanical --title "…"`

One decision per distinct choice, not per edit or per file. `--why` is a paraphrase in your words; the review page is shared, so the user's words never appear verbatim.

`--by human` means the user made the call: they stated it, picked between options you offered, or approved your proposal. Everything you chose on your own is `--by agent`.

## When the stop hook blocks

A message like "Understand: N edits … have no recorded decision" means you finished a turn with edits nothing explains. Record the decisions behind them (or `understand link D<n>` if an earlier decision covers them), then finish your reply. If you truly don't know why an edit was made, say so in the reply and leave it; it will show as unexplained, and that is honest.

## Without hooks

In agents without Claude Code hooks, `understand decide` snapshots the worktree itself and explains everything that changed since the last decision, so the same rule holds: record each decision right after its edits.

`understand decisions` lists everything recorded so far, including earlier sessions.
