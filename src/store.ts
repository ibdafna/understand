import { join } from "node:path";
import { appendJsonl, nextNumber, readJson, readJsonl, writeJson } from "./fsutil.js";
import type { Home } from "./home.js";

/** One recording: a feature branch across sessions, or a single session on trunk. */
export interface Config {
  scope: string;
  branch: string | null;
  session: string | null;
  /** The worktree (as a tree in the private store) when recording started: the "before". */
  baseTree: string;
  createdAt: string;
  /** Name of this recording's shared log under `.decisions/`. */
  logFile: string;
}

export type Decider = "human" | "agent";

/** A decision-log entry: a choice recorded while working. Append-only; `supersedes` revises one. */
export interface Decision {
  id: string;
  ts: string;
  session: string | null;
  title: string;
  why: string;
  by: Decider;
  alternatives: string[];
  /** Risks and assumptions known when the decision was made. */
  risks?: string[];
  supersedes?: string;
  mechanical?: boolean;
  /** What it shaped: "path" or "path:Symbol". A decision explains only what it names. */
  for: string[];
  /** Edits it can explain: this turn's edits that existed when it was recorded. */
  claimable: string[];
}

/** `understand link`: a decision recorded earlier also explains what it names among this turn's edits. */
export interface Link {
  decision: string;
  for: string[];
  claimable: string[];
}

/**
 * One captured change: the worktree went from tree `from` to tree `to`.
 * `unverified` changes weren't made by an observed agent tool (a person's editor, another program).
 */
export interface Edit {
  id: string;
  ts: string;
  session: string | null;
  turn: number;
  tool: string;
  from: string;
  to: string;
  files: string[];
  command?: string;
  unverified?: boolean;
  /** Where in the session transcript this happened (stays local; used to explain edits later). */
  transcript?: string;
  toolUseId?: string;
}

export interface RecState {
  /** Worktree tree hash as of the last capture; anything after it hasn't been attributed yet. */
  lastTree: string;
}

export interface Claim {
  decision: string;
  spec: string;
  /** The only edits this claim can explain. */
  edits: Set<string>;
}

export class Store {
  readonly dir: string;
  constructor(readonly home: Home, readonly id: string) {
    this.dir = home.path("recordings", id);
  }

  path(...parts: string[]) {
    return join(this.dir, ...parts);
  }

  config(): Config {
    return readJson<Config>(this.path("config.json"), null as unknown as Config);
  }
  writeConfig(c: Config) {
    writeJson(this.path("config.json"), c);
  }
  state(): RecState {
    return readJson<RecState>(this.path("state.json"), null as unknown as RecState);
  }
  writeState(s: RecState) {
    writeJson(this.path("state.json"), s);
  }

  decisions(): Decision[] {
    return readJsonl<Decision>(this.path("decision_log.jsonl")).filter((d) => /^D\d+$/.test(d.id));
  }
  edits(): Edit[] {
    return readJsonl<Edit>(this.path("edits.jsonl")).filter((e) => /^E\d+$/.test(e.id));
  }
  linkRecords(): Link[] {
    return readJsonl<Link>(this.path("links.jsonl")).filter((l) => /^D\d+$/.test(l.decision));
  }
  ignoredWrites(): { file: string }[] {
    return readJsonl(this.path("ignored.jsonl"));
  }

  addDecision(d: Omit<Decision, "id">): Decision {
    return this.home.withLock(() => {
      const rec = { id: `D${nextNumber(this.decisions().map((x) => x.id))}`, ...d };
      appendJsonl(this.path("decision_log.jsonl"), rec);
      return rec;
    });
  }
  addEdit(e: Omit<Edit, "id">): Edit {
    return this.home.withLock(() => {
      const rec = { id: `E${nextNumber(this.edits().map((x) => x.id))}`, ...e };
      appendJsonl(this.path("edits.jsonl"), rec);
      return rec;
    });
  }
  addLink(l: Link) {
    this.home.withLock(() => appendJsonl(this.path("links.jsonl"), l));
  }
  addIgnoredWrite(file: string) {
    this.home.withLock(() => appendJsonl(this.path("ignored.jsonl"), { file }));
  }

  claims(): Claim[] {
    const out: Claim[] = [];
    for (const r of [...this.decisions().map((d) => ({ ...d, decision: d.id })), ...this.linkRecords()]) {
      const edits = new Set(r.claimable ?? []);
      for (const spec of r.for ?? []) out.push({ decision: r.decision, spec, edits });
    }
    return out;
  }

  /** Agent edits from this session's current turn, explained or not. */
  turnEdits(session: string | null): Edit[] {
    const turn = this.home.turn(session);
    return this.edits().filter((e) => !e.unverified && e.session === session && e.turn === turn);
  }
}
