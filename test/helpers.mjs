import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "understand");
const MANIFEST = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "hooks.json"), "utf8")).hooks;

/** Hook events (`understand hook <event>`) the manifest runs for this tool. */
export function manifestCommands(event, toolName) {
  return (MANIFEST[event] ?? [])
    .filter((m) => !m.matcher || new RegExp(`^(?:${m.matcher})$`).test(toolName))
    .flatMap((m) => m.hooks.map((h) => /hook (\S+)$/.exec(h.command)?.[1]).filter(Boolean));
}

let calls = 0;

/** A throwaway git repo and Understand home, driven the way Claude Code drives the plugin. */
export function repo() {
  const dir = mkdtempSync(join(tmpdir(), "understand-test-"));
  const uhome = mkdtempSync(join(tmpdir(), "understand-home-"));
  const env = { ...process.env, UNDERSTAND_HOME: uhome, CLAUDE_CODE_SESSION_ID: "sess-1" };
  const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: dir, encoding: "utf8", env, ...opts });
  const u = (...args) => execFileSync(CLI, args, { cwd: dir, encoding: "utf8", env });
  const uFail = (...args) => spawnSync(CLI, args, { cwd: dir, encoding: "utf8", env });
  const hook = (event, payload = {}) => execFileSync(CLI, ["hook", event], { cwd: dir, encoding: "utf8", env, input: JSON.stringify({ session_id: "sess-1", cwd: dir, ...payload }) });
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const read = (rel) => readFileSync(join(dir, rel), "utf8");

  /** A tool call as Claude Code runs it, firing exactly the hooks the plugin manifest registers. */
  const tool = (name, input, apply) => {
    const payload = { tool_name: name, tool_input: input, tool_use_id: `toolu_${++calls}` };
    for (const cmd of manifestCommands("PreToolUse", name)) hook(cmd, { ...payload, hook_event_name: "PreToolUse" });
    let error = null;
    try { apply(); } catch (e) { error = e; }
    const event = error ? "PostToolUseFailure" : "PostToolUse";
    let out = "";
    for (const cmd of manifestCommands(event, name)) out += hook(cmd, { ...payload, hook_event_name: event });
    if (error) throw error;
    return out;
  };
  const edit = (rel, oldS, newS) => {
    const cur = read(rel);
    assert.ok(cur.includes(oldS), `fixture edit: ${JSON.stringify(oldS)} not in ${rel}`);
    return tool("Edit", { file_path: join(dir, rel), old_string: oldS, new_string: newS }, () => write(rel, cur.replace(oldS, newS)));
  };
  const bash = (command, fn = () => {}) => tool("Bash", { command }, fn);
  const recDir = () => u("where").trim();
  const extract = (...args) => { u("extract", ...args); return JSON.parse(readFileSync(join(recDir(), "extract.json"), "utf8")); };

  sh("git", ["init", "-q", "-b", "main"]);
  sh("git", ["config", "user.email", "t@t"]);
  sh("git", ["config", "user.name", "t"]);
  const commit = (msg = "c") => { sh("git", ["add", "-A"]); sh("git", ["commit", "-qm", msg, "--allow-empty"]); };
  return {
    dir, uhome, env, sh, u, uFail, hook, write, read, edit, bash, tool, extract, commit, recDir,
    cleanup: () => { rmSync(dir, { recursive: true, force: true }); rmSync(uhome, { recursive: true, force: true }); },
  };
}

/** A repo with `files` committed on main, checked out on `branch` (null: stay on main), with a session started. */
export function started(files, { branch = "feature" } = {}) {
  const t = repo();
  for (const [p, text] of Object.entries(files)) t.write(p, text);
  t.commit("base");
  if (branch) t.sh("git", ["checkout", "-q", "-b", branch]);
  JSON.parse(t.hook("session-start"));
  return t;
}

export function symbolFinder(x) {
  return (id) => x.symbols.find((s) => s.id === id) ?? assert.fail(`missing symbol ${id}\nhave: ${x.symbols.map((s) => s.id).join(", ")}`);
}
