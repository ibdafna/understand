import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Decision, Store } from "./store.js";

/**
 * The shareable decision log: `.decisions/<recording>.tsv` in the repo, one row per decision.
 * It carries the *why* (not provenance, transcripts, or snapshots) so it can travel with the code,
 * show up in pull requests, and rebuild a review page anywhere. One file per recording, so parallel
 * branches never conflict.
 */
export const LOG_DIR = ".decisions";
const COLUMNS = ["id", "recorded", "by", "title", "why", "shaped", "rejected", "risks", "revises", "mechanical"] as const;

export function sharing(root: string): boolean {
  try {
    return execFileSync("git", ["-C", root, "config", "--get", "understand.share"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !== "false";
  } catch {
    return true;
  }
}

export function isLogPath(path: string): boolean {
  return path === LOG_DIR || path.startsWith(LOG_DIR + "/");
}

const cell = (s: string | undefined) => (s ?? "").replace(/[\t\r\n]+/g, " ").trim();
const list = (xs: string[] | undefined) => (xs ?? []).map(cell).filter(Boolean).join("; ");

/** Rewrite the recording's shared log from its local decision log. */
export function writeLog(rec: Store): string | null {
  const root = rec.home.root;
  if (!sharing(root)) return null;
  const c = rec.config();
  if (!rec.decisions().length) return null;
  const file = join(root, LOG_DIR, c.logFile);
  const named = new Map<string, string[]>();
  for (const l of rec.linkRecords()) named.set(l.decision, [...(named.get(l.decision) ?? []), ...l.for]);
  const rows = rec.decisions().map((d) => [
    d.id, d.ts.slice(0, 10), d.by === "human" ? "user" : "agent", cell(d.title), cell(d.why),
    list([...d.for, ...(named.get(d.id) ?? [])]), list(d.alternatives), list(d.risks), cell(d.supersedes), d.mechanical ? "yes" : "",
  ].join("\t"));
  mkdirSync(join(root, LOG_DIR), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, [COLUMNS.join("\t"), ...rows].join("\n") + "\n");
  renameSync(tmp, file);
  return join(LOG_DIR, c.logFile);
}

/** Decisions from every shared log in the working tree, for building a page without a local recording. */
export function readLogs(root: string): Decision[] {
  const dir = join(root, LOG_DIR);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".tsv")).sort();
  const out: Decision[] = [];
  files.forEach((f, i) => {
    const [header, ...lines] = readFileSync(join(dir, f), "utf8").split("\n").filter((l) => l.trim());
    const cols = header.split("\t");
    const at = (row: string[], name: string) => row[cols.indexOf(name)] ?? "";
    const split = (s: string) => s.split(/;\s*/).filter(Boolean);
    // Several logs (branches merged over time) reuse D1, D2…; prefix to keep ids distinct.
    const prefix = files.length > 1 ? `${String.fromCharCode(65 + (i % 26))}` : "";
    for (const line of lines) {
      const row = line.split("\t");
      const id = at(row, "id");
      if (!/^D\d+$/.test(id)) continue;
      out.push({
        id: prefix + id,
        ts: at(row, "recorded"),
        session: null,
        title: at(row, "title"),
        why: at(row, "why"),
        by: at(row, "by") === "user" ? "human" : "agent",
        alternatives: split(at(row, "rejected")),
        risks: split(at(row, "risks")),
        ...(at(row, "revises") ? { supersedes: prefix + at(row, "revises") } : {}),
        ...(at(row, "mechanical") === "yes" ? { mechanical: true } : {}),
        for: split(at(row, "shaped")),
        claimable: [],
      });
    }
  });
  return out;
}
