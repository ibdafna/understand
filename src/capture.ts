import { isLogPath } from "./decisionlog.js";
import { changedFiles } from "./git.js";
import type { Store } from "./store.js";

interface CaptureOpts {
  session: string | null;
  tool: string;
  command?: string;
  /** No observed agent tool made these changes. */
  unverified?: boolean;
  /** For tools that name the files they change: other files in the same transition are unverified. */
  only?: string[];
  transcript?: string;
  toolUseId?: string;
}

/** Record everything that changed since the recording's last capture, as edits over one tree → tree transition. */
export function capture(s: Store, o: CaptureOpts): void {
  s.home.withLock(() => {
    const st = s.state();
    const tree = s.home.snapshot();
    if (tree === st.lastTree) return;
    // The shared decision log is Understand's own output, never an edit to explain.
    const files = changedFiles(s.home.root, st.lastTree, tree, s.home.readEnv()).map((c) => c.path).filter((p) => !isLogPath(p));
    const mine = o.only ? files.filter((f) => o.only!.includes(f)) : files;
    const others = o.only ? files.filter((f) => !o.only!.includes(f)) : [];
    const turn = s.home.turn(o.session);
    const rec = (fs: string[], unverified: boolean) => s.addEdit({
      ts: new Date().toISOString(),
      session: o.session,
      turn,
      tool: unverified && !o.unverified ? "side effect" : o.tool,
      from: st.lastTree,
      to: tree,
      files: fs,
      ...(o.command ? { command: o.command.slice(0, 2000) } : {}),
      ...(unverified ? { unverified: true } : {}),
      ...(o.transcript && !unverified ? { transcript: o.transcript, toolUseId: o.toolUseId } : {}),
    });
    if (mine.length) rec(mine, !!o.unverified);
    // A watcher or formatter that rewrote other files during an Edit isn't the agent's stated change.
    if (others.length) rec(others, true);
    s.writeState({ lastTree: tree });
  });
}
