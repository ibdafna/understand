---
name: explain
description: Write the review page that explains every changed symbol (imports, functions, methods, classes) from Understand's decision log. Use after opening a pull request, when the user asks to explain or review the changes, or when a hook asks for it.
---

# Explain the change

You write what a reviewer reads beside each changed symbol. Every *why* must trace to the decision log or to this conversation; where it can't, the page says so. A plausible story made up afterwards is worse than a visible gap.

## 1. Decide what to explain

If a pull request prompted this, explain the PR. Otherwise, unless the user already said, ask them which of these they want, and use the same range flag for every command below:

| They want | Flag |
| --- | --- |
| a pull request | `--pr <ref>`: the PR's base as a local ref. Find the base with `gh pr view --json baseRefName,url`, use the remote for the repository the PR targets (`git remote -v`; a fork's PR targets the upstream), `git fetch` it so it's current, and fall back to the local `<base>` branch. |
| everything on this branch, committed or not | `--branch` |
| what's staged | `--staged` |
| uncommitted changes | `--uncommitted` |
| a commit, or a range of commits | `--commits <sha>` or `--commits <a>..<b>` |

## 2. Read what changed

```
understand extract <range>   # every changed symbol, its decisions, its gaps, and where to write the explanation
understand decisions         # the decision log: reasons, alternatives, risks
```

Each symbol lists its decisions (`[D1,D3]`) and any gaps: `UNEXPLAINED` (an agent edit no decision names), `OUTSIDE` (lines no observed agent tool wrote), `BEFORE-RECORDING` (changed before recording started). The extract file it prints has every symbol's code and per-line provenance (`rows[].p` is the edit id). To read the reasoning around an edit from an earlier session, look the id up in the recording's `edits.jsonl` (next to the extract file): it has the session `transcript` path and `toolUseId`. With no local recording (someone else's work, or CI), it reads the decision log checked into `.decisions/` and matches decisions to symbols by name; the page says so.

## 3. Write the explanation where `extract` said

```json
{
  "title": "Short name of the change",
  "intent": "2-3 sentences: what the change achieves and why, for someone who wasn't there.",
  "chapters": [{ "title": "…", "summary": "What this group accomplishes.", "symbols": ["<symbol id>"] }],
  "symbols": {
    "<symbol id>": {
      "summary": "One line, mostly why and a little what.",
      "attention": "careful | skim | mechanical",
      "why": "optional: why this exists at all",
      "how": "optional: why this approach over the alternatives",
      "risk": "optional: a risk you notice now (recorded risks already appear from the log)",
      "decisions": ["optional: decisions to link beyond what the log records"],
      "related": ["optional: other symbol ids"]
    }
  }
}
```

**Chapters** are the reading order: usually the new core first, then its callers, then removals, then tests. Every symbol goes in exactly one chapter.

**Summary**, for every symbol, imports included: lead with the reason. "Needed by sleepCtx, which moved here" beats "Adds context import". Mechanical symbols get short summaries; spend depth on `careful` ones.

**Attention** tells the reviewer where to spend time; it never hides code or gaps:
- `careful`: changes behavior on a real path; concurrency, security, money, data loss, error handling; anything uncertain
- `skim`: straightforward code that follows directly from a decision
- `mechanical`: imports, renames, moves, formatting, generated code

**Risk**: be relentless and specific: unhandled inputs, unverified assumptions, callers you didn't check.

**For symbols with gaps**, describe what changed. If a recorded decision explains it, list it in `decisions`; the page shows it as linked afterwards and still flags the gap. Otherwise write "No recorded reason".

## 4. Check, render, share

```
understand check <range>              # until it prints OK
understand render <range> --open      # prints the page's path
```

Give the user the page's path. For a PR, also add a short review guide to its description with `gh pr edit`: the intent, which symbols are marked careful, and how many are unexplained. The page itself is a local file for now, so leave its path out of the PR (reviewers can't open it).
