---
name: narrate
description: Turn recorded decisions into an HTML review page that explains every changed symbol (imports, functions, methods, classes). Use when the user asks to narrate, explain, or review the changes recorded by Understand.
---

# Narrate the change

You write the explanation a reviewer reads beside each changed symbol. Every sentence of *why* must trace to a recorded decision or to this conversation; where it can't, the page says so. That constraint is the whole point: a plausible story made up afterwards is worse than a visible gap.

## 1. Read what changed

```
understand extract      # every changed symbol, with the decisions linked to it
understand decisions    # every decision, with its reasons and rejected alternatives
```

Each symbol line ends in its recorded decisions (`[D1,D3]`) and any gaps: `UNEXPLAINED` (an agent edit with no decision), `OUTSIDE` (lines no observed agent tool wrote: a manual edit or another program), `BEFORE-RECORDING` (changed before `understand init`). Code and per-line provenance for every symbol are in `.understand/extract.json` under `symbols[].rows` (`p` is the edit id, `outside`, or `before`).

## 2. Write `.understand/narration.json`

```json
{
  "title": "Short name of the change",
  "intent": "2-3 sentences: what the change achieves and why, for someone who wasn't there.",
  "chapters": [
    { "title": "…", "summary": "One or two sentences: what this group accomplishes.", "symbols": ["<symbol id>", "…"] }
  ],
  "symbols": {
    "<symbol id>": {
      "summary": "One line, mostly why and a little what.",
      "attention": "careful | skim | mechanical",
      "why": "optional: why this exists at all",
      "how": "optional: why this approach over the alternatives",
      "risk": "optional: assumptions, untested paths, what could break",
      "decisions": ["optional: D-ids to link beyond the recorded ones"],
      "related": ["optional: other symbol ids"]
    }
  }
}
```

**Chapters** are the story: the order a reviewer should read the change to understand it. That's usually the new core first, then its callers, then removals, then tests, and rarely file order. Every symbol id goes in exactly one chapter.

**Summary**: a reviewer reads only this line for most symbols, so lead with the reason. "Needed by sleepCtx, which moved here" beats "Adds context import". Give imports their reason too.

**Attention** tells the reviewer where to spend their time. It never hides code; unexplained symbols stay visible whatever you choose:
- `careful`: changes behavior on a real path; touches concurrency, security, money, data loss, or error handling; or anything you were unsure about
- `skim`: straightforward code that follows directly from a decision
- `mechanical`: imports, renames, moves, formatting, generated or boilerplate code

**Risk**: be relentless and specific. Unhandled inputs, assumptions you didn't verify, callers you didn't check. This is where the page earns its keep.

**For symbols with gaps**, the summary describes what changed. If you made the change for a recorded decision, list it in `decisions`: the page shows it as linked afterwards, and the symbol still counts as unexplained. If no decision explains it, write "No recorded reason". The gap staying visible is the point.

## 3. Check

Run `understand check`. You're done when it prints `OK`: every symbol narrated and placed, every reference resolving.

## 4. Render

Run `understand render --open`, then give the user the printed path. Mention the counts of careful and unexplained symbols, which tell them where to look first.
