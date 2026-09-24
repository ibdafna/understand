// Compare the richness of two Understand review pages: `node scripts/compare.mjs a.html b.html`.
import { readFileSync } from "node:fs";

const load = (f) => JSON.parse(readFileSync(f, "utf8").match(/const DATA = (.*?);\n/)[1]);
const words = (s) => (s ? String(s).split(/\s+/).filter(Boolean).length : 0);
const avg = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);

function metrics(d) {
  const s = d.symbols;
  const risks = s.flatMap((x) => x.risks ?? (x.risk ? [{ text: x.risk }] : []));
  return {
    "changed symbols": s.length,
    "with a summary": s.filter((x) => x.sum).length,
    "avg summary words": avg(s.filter((x) => x.sum).map((x) => words(x.sum))),
    "with why": s.filter((x) => x.why).length,
    "with why-this-way": s.filter((x) => x.how).length,
    "symbol risks shown": risks.length,
    "careful": s.filter((x) => x.attn === "careful").length,
    "explained by a decision": s.filter((x) => (x.explained ?? x.dec?.length > 0)).length,
    "unexplained": s.filter((x) => !(x.explained ?? x.dec?.length > 0)).length,
    "decisions": d.decisions.length,
    "…made by the user": d.decisions.filter((x) => x.who === "human").length,
    "…with rejected alternatives": d.decisions.filter((x) => x.alts?.length).length,
    "…with recorded risks": d.decisions.filter((x) => x.risks?.length).length,
    "chapters": d.chapters.length,
    "intent words": words(d.intent),
  };
}

const [a, b] = process.argv.slice(2).map(load);
const ma = metrics(a), mb = metrics(b);
const w = Math.max(...Object.keys(ma).map((k) => k.length));
console.log(`${"".padEnd(w)}  ${"before".padStart(8)}  ${"after".padStart(8)}`);
for (const k of Object.keys(ma)) console.log(`${k.padEnd(w)}  ${String(ma[k]).padStart(8)}  ${String(mb[k]).padStart(8)}`);
