---
name: record
description: How to keep Understand's decision log while changing code. Use whenever you edit code in a repo where Understand is recording (the session-start context says so), or when a stop hook reports edits no decision names.
user-invocable: false
---

# Keep the decision log

Every change should trace to a **decision**: a choice you or the user made, recorded when it was made. Hooks capture *what* changed; only you can capture *why*. The review page shows each changed symbol next to the decisions that name it, and flags anything no decision names as **unexplained**.

## Record each decision right after its edits

```
understand decide --by agent|human --title "<the choice, as a short imperative>" \
  --why "<the reason in the moment: the constraint, evidence, or preference that drove it>" \
  --for <file>:<Symbol>                  # repeat for every function, method, type, and import it shaped
  --alt "<rejected option>: <why not>"   # repeat per alternative
  --risk "<assumption you made, or what could break>"
```

A decision explains only what `--for` names: `<file>:<Symbol>` with the symbol as it appears in code (`store/store.go:Store.Due`, `web/api.ts:fetchJSON`, `main.go:strconv` or `src/io.ts:node:fs` for an import); a bare file (`--for main.go`) covers the whole file. Qualify methods with their type (`A.run`, not `run`) when two types in the file share the name. When one command implemented several decisions, record each and name its own symbols.

What counts as a decision:
- choosing between approaches, libraries, data shapes, or where code lives
- a constraint or preference the user stated, or a proposal of yours the user approved or rejected (`--by human`)
- deleting or replacing existing code, or adding a dependency
- a failed test, error, or discovery that changed course (`--supersedes D<n>` when it revises one)
- mechanical batches (renames, formatting, moves, regenerated files): `understand decide --mechanical --title "…" --for …`

The review page shows these fields beside the code as the change's explanation, so fill them as you decide: `--why` says why the code exists and why this way; `--alt` is required whenever there was a real alternative (each with why not); `--risk` whenever you assumed something or something could break. What isn't captured now can only be reconstructed afterwards.

One decision per distinct choice. `--why` is a paraphrase in your words, never the user's verbatim. Decisions are also written to `.decisions/` in the repo and committed along with your commits (that's how they travel with the code), so keep them free of secrets, credentials, and anything private. `--by human` means the user made the call: they stated it, picked between options, or approved your proposal.

If you recorded a decision before making its edits, name them afterwards: `understand link D<n> --for <file>:<Symbol>`.

## When the stop hook blocks

"Edits this turn to … aren't named by any decision" means you finished a turn with unexplained changes. Record or link the decisions behind them, then finish your reply. If you truly don't know why an edit was made, say so; it stays flagged, and that is honest.
