import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Extract } from "./extract/index.js";
import type { Explanation } from "./explanation.js";

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
    const attn = note?.attention ?? (mechanicalOnly ? "mechanical" : "skim"); // validated by check() before rendering
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
      name: s.name,
      line: s.line ?? 0,
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
 * The rows worth showing: blank lines at either end of a stretch (between gaps), and stretches of only
 * blank lines, aren't; they're kept when they're all there is.
 */
function showable<R extends { t: string; s: string }>(rows: R[]): R[] {
  const segs: R[][] = [[]];
  for (const r of rows) r.t === "gap" ? segs.push([]) : segs.at(-1)!.push(r);
  const blank = (r: R) => !r.s.trim();
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
