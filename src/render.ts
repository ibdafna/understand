import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Extract } from "./extract/index.js";
import type { Narration } from "./narration.js";

const ATTN = new Set(["careful", "skim", "mechanical"]);
const STATUS = new Set(["added", "removed", "modified", "moved"]);

/** Shape consumed by viewer/viewer.html. Keep in sync with the viewer's render code. */
export function viewerData(x: Extract, n: Narration | null) {
  const sessionNo = new Map(x.sessions.map((s, i) => [s, i + 1]));
  const domId = new Map(x.symbols.map((s, i) => [s.id, `s${i}`]));
  const decIds = new Set(x.decisions.map((d) => d.id));
  const supersededBy = new Map(x.decisions.filter((d) => d.supersedes).map((d) => [d.supersedes!, d.id]));

  const placed = new Set<string>();
  const chapters = (n?.chapters ?? []).map((c, i) => {
    const syms = c.symbols.filter((id) => domId.has(id) && !placed.has(id));
    syms.forEach((id) => placed.add(id));
    return { id: `c${i}`, title: String(c.title), sum: String(c.summary ?? ""), syms: syms.map((id) => domId.get(id)!) };
  });
  const rest = x.symbols.filter((s) => !placed.has(s.id));
  if (rest.length) {
    chapters.push({
      id: "c-rest",
      title: n ? "Not placed in the story" : "Changes",
      sum: n ? "The narration didn't cover these symbols. They're listed so nothing is hidden." : "No narration yet. Run the narrate skill to explain these changes.",
      syms: rest.map((s) => domId.get(s.id)!),
    });
  }

  const symbols = x.symbols.map((s) => {
    const note = n?.symbols?.[s.id];
    const later = [...new Set([...s.later, ...(note?.decisions ?? [])])].filter((d) => decIds.has(d) && !s.decisions.includes(d));
    const unlinked = new Set(s.gaps.unlinked);
    const rows = s.rows.map((r) => {
      const flag = r.t === "+" || r.t === "-" ? (r.p === "outside" ? "o" : r.p === "before" ? "b" : r.p && unlinked.has(r.p) ? "u" : undefined) : undefined;
      return { t: r.t, o: r.o, n: r.n, s: r.s, ...(flag ? { x: flag } : {}) };
    });
    const mechanicalOnly = s.decisions.length > 0 && s.decisions.every((d) => x.decisions.find((z) => z.id === d)?.mechanical);
    const attn = note?.attention && ATTN.has(note.attention) ? note.attention : mechanicalOnly ? "mechanical" : "skim";
    // Review marks are tied to exactly what the reviewer saw: diff, provenance, and explanation.
    const shown = [...s.decisions, ...later].map((d) => x.decisions.find((z) => z.id === d)).map((d) => d && [d.id, d.title, d.why, d.alternatives]);
    const fp = createHash("sha1").update(JSON.stringify([s.rows, s.gaps, later, shown, note ?? null])).digest("hex").slice(0, 10);
    return {
      id: domId.get(s.id)!,
      key: `${s.id}@${fp}`,
      file: s.file,
      kind: s.kind,
      name: s.name,
      sig: s.sig,
      status: STATUS.has(s.status) ? s.status : "modified",
      moved: s.movedFrom,
      note: s.note,
      rows,
      dec: s.decisions,
      later,
      gaps: { outside: s.gaps.outside, before: s.gaps.before, unlinked: s.gaps.unlinked.length },
      explained: s.explained,
      attn,
      sum: note?.summary ?? null,
      why: note?.why,
      how: note?.how,
      risk: note?.risk,
      rel: (note?.related ?? []).map((r) => domId.get(r)).filter(Boolean),
    };
  });

  return {
    title: n?.title ?? "Unnarrated changes",
    intent: n?.intent ?? "",
    branch: x.branch,
    startedOn: x.startedOn,
    base: x.base.slice(0, 8),
    generatedAt: x.generatedAt,
    sessions: x.sessions.length,
    span: x.span,
    files: x.files,
    ignoredWrites: x.ignoredWrites,
    warnings: x.warnings,
    decisions: x.decisions.map((d) => ({
      id: d.id,
      who: d.by === "human" ? "human" : "agent",
      title: d.title,
      ctx: d.why,
      alts: d.alternatives,
      supersedes: d.supersedes,
      supersededBy: supersededBy.get(d.id),
      mechanical: !!d.mechanical,
      session: d.session ? sessionNo.get(d.session) ?? null : null,
    })),
    chapters,
    symbols,
  };
}

export function renderHtml(x: Extract, n: Narration | null): string {
  const tpl = readFileSync(fileURLToPath(new URL("./viewer.html", import.meta.url)), "utf8");
  const json = JSON.stringify(viewerData(x, n)).replace(/[<\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
  const title = (n?.title ?? "Changes").replace(/[<>&`"]/g, "");
  return tpl.replace("/*__UNDERSTAND_DATA__*/null", () => json).replace("<title>Understand</title>", () => `<title>Understand · ${title}</title>`);
}
