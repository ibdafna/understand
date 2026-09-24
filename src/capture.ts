import { changedFiles, snapshot } from "./git.js";
import type { Edit, Store } from "./store.js";

export interface CaptureOpts {
  session: string | null;
  tool: string;
  command?: string;
  /** No observed tool made these changes (found by a checkpoint while hooks are active). */
  unverified?: boolean;
  /** For tools that name the file they change: other files in the same transition are unverified. */
  only?: string;
}

/** Record everything that changed since the last capture as edits over one tree → tree transition. */
export function capture(s: Store, o: CaptureOpts): Edit | null {
  return s.withLock(() => {
    const st = s.state();
    const tree = snapshot(s);
    if (tree === st.lastTree) return null;
    const files = changedFiles(s.root, st.lastTree, tree).map((c) => c.path);
    const mine = o.only ? files.filter((f) => f === o.only) : files;
    const others = o.only ? files.filter((f) => f !== o.only) : [];
    const rec = (fs: string[], unverified: boolean) => s.addEdit({
      ts: new Date().toISOString(),
      session: o.session,
      turn: s.session(st, o.session).turn,
      tool: unverified && !o.unverified ? "side effect" : o.tool,
      from: st.lastTree,
      to: tree,
      files: fs,
      ...(o.command ? { command: o.command.slice(0, 2000) } : {}),
      ...(unverified ? { unverified: true } : {}),
    });
    const edit = mine.length ? rec(mine, !!o.unverified) : null;
    // A watcher or formatter that rewrote other files during an Edit isn't the agent's stated change.
    if (others.length) rec(others, true);
    st.lastTree = tree;
    s.writeState(st);
    return edit;
  });
}
