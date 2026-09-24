import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "bin", "understand");

/** A throwaway git repo driven the way Claude Code drives the plugin. */
export function repo() {
  const dir = mkdtempSync(join(tmpdir(), "understand-test-"));
  const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: dir, encoding: "utf8", ...opts });
  const u = (...args) => execFileSync(CLI, args, { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "sess-1" } });
  const uFail = (...args) => spawnSync(CLI, args, { cwd: dir, encoding: "utf8", env: { ...process.env, CLAUDE_CODE_SESSION_ID: "sess-1" } });
  const hook = (event, payload = {}) => execFileSync(CLI, ["hook", event], { cwd: dir, encoding: "utf8", input: JSON.stringify({ session_id: "sess-1", cwd: dir, ...payload }) });
  const write = (rel, text) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), text); };
  const read = (rel) => readFileSync(join(dir, rel), "utf8");

  /** A tool call as Claude Code runs it, firing exactly the hooks the plugin manifest registers. */
  const tool = (name, input, apply) => {
    for (const cmd of manifestCommands("PreToolUse", name)) hook(cmd, { tool_name: name, tool_input: input });
    apply();
    for (const cmd of manifestCommands("PostToolUse", name)) hook(cmd, { tool_name: name, tool_input: input });
  };
  const edit = (rel, oldS, newS) => {
    const cur = read(rel);
    assert.ok(cur.includes(oldS), `fixture edit: ${JSON.stringify(oldS)} not in ${rel}`);
    tool("Edit", { file_path: join(dir, rel), old_string: oldS, new_string: newS }, () => write(rel, cur.replace(oldS, newS)));
  };
  const writeTool = (rel, content) => tool("Write", { file_path: join(dir, rel), content }, () => write(rel, content));
  const bash = (command, fn) => tool("Bash", { command }, fn);
  const extract = () => { u("extract"); return JSON.parse(read(".understand/extract.json")); };

  sh("git", ["init", "-q"]);
  sh("git", ["config", "user.email", "t@t"]);
  sh("git", ["config", "user.name", "t"]);
  const commit = () => { sh("git", ["add", "-A"]); sh("git", ["commit", "-qm", "c", "--allow-empty"]); };
  return { dir, sh, u, uFail, hook, write, read, edit, writeTool, bash, tool, extract, commit, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const MANIFEST = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "hooks", "hooks.json"), "utf8")).hooks;

/** Hook events (`understand hook <event>`) the manifest runs for this tool. */
export function manifestCommands(event, toolName) {
  return (MANIFEST[event] ?? [])
    .filter((m) => !m.matcher || new RegExp(`^(?:${m.matcher})$`).test(toolName))
    .flatMap((m) => m.hooks.map((h) => /hook (\S+)$/.exec(h.command)?.[1]).filter(Boolean));
}

export function symbolFinder(x) {
  return (id) => x.symbols.find((s) => s.id === id) ?? assert.fail(`missing symbol ${id}\nhave: ${x.symbols.map((s) => s.id).join(", ")}`);
}
