import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Extract } from "./extract/index.js";
import type { Explanation } from "./explanation.js";


const ATTN = new Set(["careful", "skim", "mechanical"]);

/** Shape consumed by viewer/app.js. Keep in sync with the viewer's render code. */
export function viewerData(x: Extract, n: Explanation | null) {
  const sessionNo = new Map(x.sessions.map((s, i) => [s, i + 1]));
  const domId = new Map(x.symbols.map((s, i) => [s.id, `s${i}`]));
  const decById = new Map(x.decisions.map((d) => [d.id, d]));
  const supersededBy = new Map(x.decisions.filter((d) => d.supersedes).map((d) => [d.supersedes!, d.id]));

  const chapters = n?.chapters?.length ? explicitChapters(x, n, domId) : decisionChapters(x, domId);

  const symbols = x.symbols.map((s) => {
    const note = n?.symbols?.[s.id];
    const later = s.later.filter((d) => decById.has(d) && !s.decisions.includes(d));
    const unlinked = new Set(s.gaps.unlinked);
    const rows = showable(s.rows).map((r) => {
      const flag = r.t === "+" || r.t === "-" ? (r.p === "outside" ? "o" : r.p === "before" ? "b" : r.p && unlinked.has(r.p) ? "u" : undefined) : undefined;
      return { t: r.t, o: r.o, n: r.n, s: r.s, ...(flag ? { x: flag } : {}) };
    });
    const decs = s.decisions.map((d) => decById.get(d)!).filter(Boolean);
    const mechanicalOnly = decs.length > 0 && decs.every((d) => d.mechanical);
    const attn = note?.attention && ATTN.has(note.attention) ? note.attention : mechanicalOnly ? "mechanical" : "skim";
    // Risks the decisions recorded at the time, then any the explanation found.
    const risks = [
      ...[...decs, ...later.map((d) => decById.get(d)!)]
        .filter((d, _, all) => !all.some((o) => o.supersedes === d.id)) // replaced on this same symbol
        .flatMap((d) => (d.risks ?? []).map((text) => ({ text, from: d.id }))),
      ...(note?.risk ? [{ text: note.risk, from: null }] : []),
    ];
    // Review marks are tied to exactly what the reviewer saw: diff, provenance, and explanation.
    const shown = [...s.decisions, ...later].map((d) => decById.get(d)).map((d) => d && [d.id, d.title, d.why, d.alternatives, d.risks]);
    const fp = createHash("sha1").update(JSON.stringify([s.rows, s.gaps, later, shown, note ?? null])).digest("hex").slice(0, 10);
    return {
      id: domId.get(s.id)!,
      ref: s.id,
      key: `${s.id}@${fp}`,
      file: s.file,
      kind: s.kind,
      name: s.kind === "other" && /^lines? /.test(s.name) ? linesName(rows) ?? s.name : s.name,
      line: s.line ?? (s.kind === "other" ? changedLines(rows)[0] : rows.find((r) => r.n != null)?.n ?? rows.find((r) => r.o != null)?.o) ?? 0,
      sig: s.sig,
      status: s.status,
      moved: s.movedFrom,
      note: s.note,
      rows,
      dec: s.decisions,
      later,
      sum: note?.summary ?? null,
      why: note?.why,
      how: note?.how,
      risks,
      gaps: { outside: s.gaps.outside, before: s.gaps.before, unlinked: s.gaps.unlinked.length },
      explained: s.explained,
      attn,
      attnWhy: note?.attentionReason ?? null,
    };
  }).filter((s) => {
    // A container whose own lines didn't change (only its members did, or blank lines between them) has nothing to show.
    const changed = s.rows.some((r) => (r.t === "+" || r.t === "-") && r.s.trim());
    return changed || s.status !== "modified" || !!s.moved || !!s.note;
  });

  return {
    title: n?.title || `Changes on ${x.startedOn}`,
    intent: n?.intent ?? "",
    branch: x.branch,
    startedOn: x.startedOn,
    baseLabel: x.baseLabel,
    headLabel: x.headLabel,
    generatedAt: x.generatedAt,
    sessions: x.sessions.length,
    span: x.span,
    files: x.files,
    ignoredWrites: x.ignoredWrites,
    byName: x.byName,
    warnings: x.warnings,
    decisions: x.decisions.map((d) => ({
      id: d.id,
      who: d.by === "human" ? "human" : "agent",
      title: d.title,
      ctx: d.why,
      alts: d.alternatives,
      risks: d.risks ?? [],
      supersedes: d.supersedes,
      supersededBy: supersededBy.get(d.id),
      mechanical: !!d.mechanical,
      session: d.session ? sessionNo.get(d.session) ?? null : null,
    })),
    chapters,
    symbols,
  };
}

/**
 * The rows worth showing. A symbol's own lines can skip (a container's lines skip its members), so a
 * jump in line numbers is a gap. A stretch that is only blank lines, and blank lines at either end,
 * aren't worth showing; keep them when they're all there is.
 */
function showable<R extends { t: string; s?: string; o?: number; n?: number }>(rows: R[]): R[] {
  const segs: R[][] = [[]];
  let o: number | undefined, n: number | undefined;
  for (const r of rows) {
    const jump = (r.n != null && n != null && r.n !== n + 1) || (r.o != null && o != null && r.o !== o + 1);
    if (r.t === "gap" || jump) { segs.push([]); o = n = undefined; } // the gap stands for what both sides skipped
    if (r.t !== "gap") segs.at(-1)!.push(r);
    if (r.n != null) n = r.n;
    if (r.o != null) o = r.o;
  }
  const blank = (r: R) => !(r.s ?? "").trim();
  const kept = segs
    .map((seg) => {
      let a = 0, z = seg.length;
      while (a < z && blank(seg[a])) a++;
      while (z > a && blank(seg[z - 1])) z--;
      return seg.slice(a, z);
    })
    .filter((seg) => seg.length);
  if (!kept.some((seg) => seg.some((r) => r.t === "+" || r.t === "-"))) return rows;
  return kept.flatMap((seg, i) => (i ? [{ t: "gap", s: "" } as R, ...seg] : seg));
}

/** The changed lines' numbers, sorted: in the new file when any are there, else in the old. */
function changedLines(rows: { t: string; o?: number; n?: number }[]): number[] {
  const changed = rows.filter((r) => r.t === "+" || r.t === "-");
  const inNew = changed.some((r) => r.n != null);
  return changed.map((r) => (inNew ? r.n : r.o)).filter((x): x is number => x != null).sort((a, b) => a - b);
}

/** A name for changes outside any symbol, from the lines actually shown: the line itself when it's one, else "lines 3–9". */
function linesName(rows: { t: string; o?: number; n?: number; s: string }[]): string | null {
  const nums = changedLines(rows);
  if (!nums.length) return null;
  const texts = new Set(rows.filter((r) => (r.t === "+" || r.t === "-") && r.s.trim()).map((r) => r.s.trim()));
  if (texts.size === 1) { const t = [...texts][0]; return t.length > 48 ? t.slice(0, 47) + "…" : t; }
  const a = nums[0], z = nums.at(-1)!;
  return a === z ? `line ${a}` : `lines ${a}–${z}`;
}

type Chapter = { title: string; sum: string; syms: string[] };

function explicitChapters(x: Extract, n: Explanation, domId: Map<string, string>): Chapter[] {
  const placed = new Set<string>();
  const out: Chapter[] = (n.chapters ?? []).map((c) => {
    const syms = c.symbols.filter((id) => domId.has(id) && !placed.has(id));
    syms.forEach((id) => placed.add(id));
    return { title: String(c.title), sum: String(c.summary ?? ""), syms: syms.map((id) => domId.get(id)!) };
  });
  const rest = x.symbols.filter((s) => !placed.has(s.id));
  if (rest.length) out.push({ title: "Not placed in the reading order", sum: "The explanation didn't place these. They're listed so nothing is hidden.", syms: rest.map((s) => domId.get(s.id)!) });
  return out;
}

/**
 * Default reading order: one chapter per decision, in the order they were made. A symbol shaped by
 * several decisions sits under the latest one, so a revised choice is read in its final form.
 */
function decisionChapters(x: Extract, domId: Map<string, string>): Chapter[] {
  const order = new Map(x.decisions.map((d, i) => [d.id, i]));
  const next = new Map(x.decisions.filter((d) => d.supersedes).map((d) => [d.supersedes!, d.id]));
  const final = (id: string) => { const seen = new Set<string>(); while (next.has(id) && !seen.has(id)) { seen.add(id); id = next.get(id)!; } return id; };
  const home = new Map(x.symbols.filter((s) => s.decisions.length).map((s) => [s.id, s.decisions.map(final).reduce((a, b) => (order.get(b)! > order.get(a)! ? b : a))]));
  const out: Chapter[] = [];
  for (const d of x.decisions) {
    const syms = x.symbols.filter((s) => home.get(s.id) === d.id);
    if (syms.length) out.push({ title: d.title, sum: d.why, syms: syms.map((s) => domId.get(s.id)!) });
  }
  const placed = new Set(home.keys());
  const rest = x.symbols.filter((s) => !placed.has(s.id));
  if (rest.length) out.push({ title: "Not explained by a recorded decision", sum: "No decision in the log covers these changes.", syms: rest.map((s) => domId.get(s.id)!) });
  return out;
}

export function renderHtml(x: Extract, n: Explanation | null): string {
  const tpl = readFileSync(fileURLToPath(new URL("./viewer.html", import.meta.url)), "utf8");
  const json = JSON.stringify(viewerData(x, n)).replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const title = (n?.title || `Changes on ${x.startedOn}`).replace(/[<>&`"]/g, "");
  // Syntax grammars for just the languages this diff shows.
  const grammars = [...new Set(Object.values(x.files).map((f) => f.lang))]
    .map((id) => fileURLToPath(new URL(`./highlight/${id}.js`, import.meta.url)))
    .filter((f) => existsSync(f))
    .map((f) => readFileSync(f, "utf8"))
    .join("\n");
  return tpl
    .replace("/*__UNDERSTAND_LANGS__*/", () => grammars)
    .replace("/*__UNDERSTAND_DATA__*/null", () => json)
    .replace("<title>Understand</title>", () => `<title>Understand · ${title}</title>`);
}
