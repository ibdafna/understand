import { FileDiff, parsePatchFiles } from "@pierre/diffs";
import { diffWordsWithSpace } from "diff";

/* global DATA: the page's data, a global declared before this script by render.ts */

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
/* prose from the explanation: escaped, with `code` spans */
const md = (s) => esc(s)
  .replace(/`([^`]+)`/g, '<code class="ic">$1</code>')
  .replace(/(^|[\s(+])(--?\w[\w-]*|\w+(?:-\w+){2,}|\w*\d\w*(?:-\w+)+)(?=[\s.,;:)]|$)/g, '$1<span class="nw">$2</span>'); // --due, YYYY-MM-DD stay whole
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const ICON = {
  comment: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  chevron: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>',
  check: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-label="Viewed"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  copy: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  search: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
};

const SYM = Object.fromEntries(DATA.symbols.map((s) => [s.id, s]));
const REF = Object.fromEntries(DATA.symbols.map((s) => [s.ref, s]));
const ORDER = Object.fromEntries(DATA.symbols.map((s, i) => [s.ref, i]));
const DEC = Object.fromEntries(DATA.decisions.map((d) => [d.id, d]));
const allDec = (s) => [...s.dec, ...s.later];
/* The decisions that shaped a symbol as it is: one replaced by another that also shaped it is left out. */
const liveDec = (s) => { const ids = allDec(s); return ids.map((id) => DEC[id]).filter((d) => d && !(d.supersededBy && ids.includes(d.supersededBy))); };
const unexplained = (s) => !s.explained;
const needsCare = (s) => s.attn === "careful" || unexplained(s);
const counts = (s) => ({ a: s.rows.filter((r) => r.t === "+").length, d: s.rows.filter((r) => r.t === "-").length });
const sumCounts = (list) => list.reduce((t, s) => { const c = counts(s); return { a: t.a + c.a, d: t.d + c.d }; }, { a: 0, d: 0 });
const pmHTML = ({ a, d }) => `<span class="num">${a ? `<span class="plus">+${a}</span>` : ""}${a && d ? " " : ""}${d ? `<span class="minus">−${d}</span>` : ""}</span>`;

const storeKey = "understand:" + DATA.branch + ":";
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(storeKey + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(storeKey + k, JSON.stringify(v)); } catch {} },
};
const state = {
  order: ["story", "files", "decisions"].includes(store.get("view")) ? store.get("view") : "story",
  q: "",
  quick: null, // "care" | "gap" | "commented" | "unviewed"
  focus: null,
  viewed: new Set(store.get("reviewed", []).filter((k) => DATA.symbols.some((s) => s.key === k))),
  fold: new Set(), // folded by hand
  unfold: new Set(), // unfolded by hand (viewed symbols fold by default)
  codeOpen: new Set(),
  current: null,
};
const viewed = (s) => state.viewed.has(s.key);
const folded = (s) => (state.fold.has(s.id) ? true : state.unfold.has(s.id) ? false : viewed(s));

/* ---------- theme: the system's, unless the reader picked light or dark (kept for every page) ---------- */
const THEME_KEY = "understand:theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");
function themePick() {
  try { const v = localStorage.getItem(THEME_KEY); return v === "light" || v === "dark" ? v : "system"; } catch { return "system"; }
}
const themeNow = () => (themePick() === "system" ? (systemDark.matches ? "dark" : "light") : themePick());
function applyTheme() {
  const pick = themePick(), t = themeNow();
  document.documentElement.dataset.theme = t;
  $$("[data-theme-pick]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.themePick === pick));
  for (const inst of mounted.values()) inst.setThemeType(t);
}
function setThemePick(pick) {
  try { pick === "system" ? localStorage.removeItem(THEME_KEY) : localStorage.setItem(THEME_KEY, pick); } catch {}
  applyTheme();
}
systemDark.addEventListener("change", applyTheme);
window.addEventListener("storage", (e) => { if (e.key === THEME_KEY) applyTheme(); }); // another open page changed it

/* ---------- zen: just the code and its reasons (kept for every page) ---------- */
function setZen(on) {
  document.body.classList.toggle("zen", on);
  $("[data-zen]").setAttribute("aria-pressed", String(on));
  try { on ? localStorage.setItem("understand:zen", "1") : localStorage.removeItem("understand:zen"); } catch {}
}

const GLYPH = { added: "+", removed: "−", modified: "~", moved: "→" };
const FLAG_TEXT = { o: "Not made by an observed agent tool (a manual edit or an unobserved program)", b: "Changed before recording started; no reason was captured", u: "No decision names this symbol for the edit that wrote this line" };
const base = (p) => String(p).split("/").pop();
const shortName = (s) => (s.kind === "file" ? base(s.file) : s.name);

/* ---------- comments ----------
 * Kept in this browser. Each targets a line range in one symbol's diff, a whole symbol, or a decision.
 * "Copy" turns them into one prompt, with where each applies, to paste into the agent. */
const comments = store.get("comments", []).filter((c) => c && c.key && c.target && typeof c.text === "string");
const editing = new Map(); // key -> text being written (a new comment, or an edit)
const saveComments = () => store.set("comments", comments);
const symbolLabel = (ref) => { const [f, k] = String(ref).split("#"); return k ? `${f}:${k.slice(k.indexOf(":") + 1)}` : ref; };
const lines = (t) => `${t.side === "old" ? "removed " : ""}line${t.to !== t.from ? `s ${t.from}–${t.to}` : ` ${t.from}`}`;
function whereText(t) {
  if (t.kind === "decision") return `decision ${t.decision}${DEC[t.decision] ? ` (${DEC[t.decision].title})` : ""}`;
  return t.kind === "symbol" ? symbolLabel(t.symbol) : `${symbolLabel(t.symbol)}, ${lines(t)}`;
}
const shortWhere = (t) => (t.kind === "decision" ? t.decision : `${REF[t.symbol] ? shortName(REF[t.symbol]) : symbolLabel(t.symbol)}${t.kind === "lines" ? ` · ${lines(t)}` : ""}`);

const rowText = (r) => r.t + r.s;
/* The lines a run of diff rows covers (new-side numbers when it has any), and where a comment on it sits. */
function span(slice) {
  const onNew = slice.some((r) => r.t !== "-");
  const nums = slice.filter((r) => !onNew || r.t !== "-").map((r) => (onNew ? r.n : r.o));
  const end = slice[slice.length - 1];
  return { side: onNew ? "new" : "old", from: Math.min(...nums), to: Math.max(...nums), at: { side: end.t === "-" ? "deletions" : "additions", line: end.t === "-" ? end.o : end.n } };
}
/* Where a comment's code is now. Line comments are found by the code they quote, so edits above them don't
 * strand them; null once that code is gone. */
function here(c) {
  const t = c.target;
  if (t.kind !== "lines") return t;
  const s = REF[t.symbol];
  if (!s || !t.quote) return null;
  const rows = s.rows.filter((r) => r.t !== "gap"), want = t.quote.split("\n");
  let best = null;
  for (let i = 0; i + want.length <= rows.length; i++) {
    if (!want.every((l, j) => rowText(rows[i + j]) === l)) continue;
    const found = { ...t, ...span(rows.slice(i, i + want.length)) };
    if (!best || found.to === t.to) best = found; // the same code twice: prefer the copy where it was
  }
  return best;
}
const anchored = (c) => !!here(c);

/* A selected range, possibly across removed and added lines, quoted exactly as selected. */
function linesTarget(s, side, from, endSide, to) {
  const find = (sd, line) => s.rows.findIndex((r) => (sd === "old" ? r.t === "-" && r.o === line : r.t !== "-" && r.t !== "gap" && r.n === line));
  const a = find(side, from), b = find(endSide, to);
  if (a < 0 || b < 0) return null;
  const slice = s.rows.slice(Math.min(a, b), Math.max(a, b) + 1).filter((r) => r.t !== "gap");
  const { at, ...where } = span(slice);
  return { kind: "lines", symbol: s.ref, ...where, quote: slice.map(rowText).join("\n") };
}

/* Focus a comment's box, caret at the end: at once, so the first keystrokes land in it, not on a shortcut. */
function focusComment(key) {
  const go = () => {
    const ta = $(`textarea[data-c="${key}"]`);
    if (ta) { ta.focus({ preventScroll: false }); ta.setSelectionRange(ta.value.length, ta.value.length); }
    return !!ta;
  };
  if (!go()) requestAnimationFrame(go);
}
function addComment(target) {
  const c = { key: Math.random().toString(36).slice(2, 10), target, text: "", ts: new Date().toISOString() };
  comments.push(c);
  editing.set(c.key, "");
  const s = target.kind === "decision" ? null : REF[target.symbol];
  if (s && folded(s)) setFold(s, false);
  refreshComments();
  focusComment(c.key);
}
function saveComment(key) {
  const c = comments.find((x) => x.key === key);
  if (!c) return;
  const text = (editing.get(key) ?? c.text).trim();
  editing.delete(key);
  if (text) c.text = text;
  else comments.splice(comments.indexOf(c), 1);
  saveComments();
  refreshComments();
}
function cancelComment(key) {
  const c = comments.find((x) => x.key === key);
  editing.delete(key);
  if (c && !c.text) comments.splice(comments.indexOf(c), 1);
  refreshComments();
}
function deleteComment(key) {
  const i = comments.findIndex((x) => x.key === key);
  if (i >= 0) comments.splice(i, 1);
  editing.delete(key);
  saveComments();
  refreshComments();
}

function commentHTML(c) {
  const t = here(c) ?? c.target;
  const where = t.kind === "lines" ? esc(lines(t)) : t.kind === "decision" ? esc(t.decision) : "";
  if (editing.has(c.key)) {
    return `<div class="cmt editing"><div class="c-top"><b>You</b><span>${where}</span></div>
      <textarea data-c="${c.key}" rows="3" placeholder="What should the agent change, or explain?" aria-label="Comment">${esc(editing.get(c.key))}</textarea>
      <div class="c-foot"><button class="btn primary" data-c-save="${c.key}">Save</button><button class="btn" data-c-cancel="${c.key}">Cancel</button><span class="hint"><kbd>⌘</kbd><kbd>↵</kbd></span></div></div>`;
  }
  return `<div class="cmt"><div class="c-top"><b>You</b><span>${where}</span><span class="spacer"></span><button class="link quiet" data-c-edit="${c.key}">Edit</button><button class="link quiet" data-c-delete="${c.key}">Delete</button></div>
    <div class="c-text">${esc(c.text)}</div></div>`;
}
const live = () => comments.filter((c) => c.text || editing.has(c.key));
const commentsFor = (pred) => comments.filter((c) => pred(c.target) && anchored(c)).map(commentHTML).join("");
const symComments = (s) => commentsFor((t) => t.kind === "symbol" && t.symbol === s.ref);
const commentCount = (s) => comments.filter((c) => c.text && c.target.kind !== "decision" && c.target.symbol === s.ref).length;

/* Comments in reading order: by symbol and line, then decisions. */
function inPageOrder(list) {
  const rank = (t) => (t.kind === "decision" ? [1e9, Number(String(t.decision).replace(/\D/g, "")) || 0] : [ORDER[t.symbol] ?? 1e8, t.kind === "lines" ? t.from : -1]);
  return [...list].sort((a, b) => { const [x1, y1] = rank(a.target), [x2, y2] = rank(b.target); return x1 - x2 || y1 - y2; });
}

function promptText(list) {
  const body = inPageOrder(list).map((c, i) => {
    const t = here(c) ?? c.target;
    const gone = here(c) ? "" : " (this code has changed since the comment)";
    const quote = t.kind === "lines" && t.quote ? "\n" + t.quote.split("\n").map((l) => `   > ${l}`).join("\n") : "";
    return `${i + 1}. ${whereText(t)}${gone}${quote}\n   ${c.text.replace(/\n/g, "\n   ")}`;
  }).join("\n\n");
  return `Review comments on ${DATA.branch} (${DATA.baseLabel} → ${DATA.headLabel}):\n\n${body}\n\nAddress each comment: change the code, or explain why it should stay as it is.`;
}

async function copyAll() {
  for (const key of [...editing.keys()]) saveComment(key); // unsaved text counts too
  const list = comments.filter((c) => c.text);
  if (!list.length) return;
  try {
    await navigator.clipboard.writeText(promptText(list));
    toast(`Copied ${plural(list.length, "comment")}. Paste them into your agent.`);
  } catch {
    toast("Couldn't copy to the clipboard.");
  }
}

/* ---------- code: each symbol's diff is a Pierre FileDiff, mounted when it nears the viewport ---------- */
function rowsToPatch(name, rows) {
  const segs = [[]];
  for (const r of rows) r.t === "gap" ? segs.push([]) : segs[segs.length - 1].push(r);
  let out = `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n`;
  let o = 0, n = 0; // the last line each side has reached
  for (const seg of segs) {
    if (!seg.length) continue;
    const olds = seg.filter((r) => r.t !== "+"), news = seg.filter((r) => r.t !== "-");
    // A side with no lines here is empty at the line before (the patch format's `+N,0`).
    const oStart = olds.length ? olds[0].o : o, nStart = news.length ? news[0].n : n;
    out += `@@ -${oStart},${olds.length} +${nStart},${news.length} @@\n`;
    for (const r of seg) out += (r.t === " " ? " " : r.t) + r.s + "\n";
    if (olds.length) o = olds.at(-1).o;
    if (news.length) n = news.at(-1).n;
  }
  return out;
}

const DIFF_CSS = `
:host { --diffs-light-bg: var(--panel); --diffs-dark-bg: var(--panel); --diffs-min-number-column-width: 3ch; --diffs-light-addition-color: #0f7546; --diffs-light-deletion-color: #c0262f; }
[data-prov] { box-shadow: inset 3px 0 0 var(--u-warn, #b54708); }
[data-line][data-prov]::after { content: "!"; position: absolute; right: 8px; font-weight: 700; color: var(--u-warn, #b54708); }
/* One column of numbers, the new file's: a removed line has none there. */
[data-column-number][data-line-type="change-deletion"] [data-line-number-content] { visibility: hidden; }
/* A wrapped line continues under its own indentation, so it doesn't read as a new line. */
[data-line] { padding-inline-start: calc(2ch + var(--hang, 0ch)); text-indent: calc(-1 * var(--hang, 0ch)); }
/* Skipped lines. */
[data-separator="simple"] { min-height: 12px; background: repeating-linear-gradient(-45deg, color-mix(in srgb, var(--dim) 45%, transparent) 0 1px, transparent 1px 6px); }
`;
const TAB = 2; // Pierre's tab-size

/**
 * The changed words of removed and added lines that are edits of each other. Pierre pairs lines by
 * position; here each removed line pairs with the most alike added line after the last pair in its
 * block, and lines less than half alike aren't paired: their colour already says they changed.
 */
function wordMarks(rows) {
  const marks = new Map(), size = (t) => t.replace(/\s/g, "").length;
  const trim = (line, a, b) => { while (a < b && /\s/.test(line[a])) a++; while (b > a && /\s/.test(line[b - 1])) b--; return a < b ? [[a, b]] : []; };
  for (let i = 0; i < rows.length; ) {
    const block = [];
    while (rows[i]?.t === "-" || rows[i]?.t === "+") block.push(rows[i++]);
    if (!block.length) { i++; continue; }
    const dels = block.filter((r) => r.t === "-"), adds = block.filter((r) => r.t === "+");
    let from = 0;
    for (const d of dels) {
      let best = null, score = 0.5, at = -1;
      for (let j = from; j < adds.length; j++) {
        const parts = diffWordsWithSpace(d.s, adds[j].s);
        const same = parts.filter((p) => !p.added && !p.removed).reduce((n, p) => n + size(p.value), 0) / Math.max(size(d.s), size(adds[j].s), 1);
        if (same > score) [best, score, at] = [parts, same, j];
      }
      if (!best) continue;
      from = at + 1;
      const dr = [], ar = [];
      let od = 0, oa = 0;
      for (const p of best) {
        if (p.removed) { dr.push(...trim(d.s, od, od + p.value.length)); od += p.value.length; }
        else if (p.added) { ar.push(...trim(adds[at].s, oa, oa + p.value.length)); oa += p.value.length; }
        else { od += p.value.length; oa += p.value.length; }
      }
      // Marks with only spaces (or a stray character or two the word diff happened to match) between
      // them read as one change: ", due" rather than "," and "due".
      const join = (line, rs) => rs.reduce((out, r) => { const last = out.at(-1); if (last && line.slice(last[1], r[0]).trim().length <= 2) last[1] = r[1]; else out.push([...r]); return out; }, []);
      if (dr.length) marks.set(`d${d.o}`, join(d.s, dr));
      if (ar.length) marks.set(`a${adds[at].n}`, join(adds[at].s, ar));
    }
  }
  return marks;
}

/**
 * A long line wraps the way code reads: it hangs under its own indentation (which stays with the first
 * word), breaks between tokens (after `(` or `,`, before a call chained on `)`), and never inside a
 * name, a flag like --due, a date, or `->`. Safe to run again on a line it already did.
 */
function wrapLikeCode(line) {
  const text = line.textContent, lead = /^[ \t]*/.exec(text)[0];
  const cols = [...lead].reduce((c, ch) => (ch === "\t" ? c + TAB - (c % TAB) : c + 1), 0);
  line.style.setProperty("--hang", `${cols + 2}ch`);
  const first = line.querySelector("span");
  if (lead && first && first.textContent.trim().length < 24) first.style.whiteSpace = "pre";
  for (const sp of line.querySelectorAll("span")) {
    if (sp.children.length) continue;
    const t = sp.textContent, prev = sp.previousSibling;
    if (text.length > 40 && prev?.nodeName !== "WBR" && ((/^\./.test(t) && /\)$/.test(prev?.textContent ?? "")) || /[(,]\s*$/.test(prev?.textContent ?? ""))) sp.before(document.createElement("wbr"));
    if (!/\S-\S|--\S|->/.test(t)) continue;
    if (!/\s/.test(t)) { if (t.length <= 32) sp.style.whiteSpace = "nowrap"; }
    else sp.innerHTML = esc(t).replace(/(--?\w[\w-]*|\w+(?:-\w+)+|\S*-&gt;\S*)/g, '<span style="white-space:nowrap">$1</span>');
  }
}

/** Wrap character ranges of a rendered line in Pierre's changed-word marker. */
function markWords(line, ranges) {
  const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT), nodes = [];
  for (let n; (n = walk.nextNode()); ) nodes.push(n);
  let pos = 0;
  for (const node of nodes) {
    const start = pos;
    pos += node.length;
    for (const [a, b] of [...ranges].reverse()) { // from the end, so the offsets stay valid as the text splits
      const x = Math.max(a, start), y = Math.min(b, pos);
      if (x >= y) continue;
      const mid = node.splitText(x - start);
      mid.splitText(y - x);
      const mark = document.createElement("span");
      mark.setAttribute("data-diff-span", "");
      mid.replaceWith(mark);
      mark.append(mid);
    }
  }
}

const mounted = new Map(); // symbol id -> FileDiff

const lineComments = (s) => comments.filter((c) => c.target.kind === "lines" && c.target.symbol === s.ref && anchored(c));
/* One annotation per line that has comments, keyed by what it shows (Pierre re-renders on a new key). */
function lineAnnotations(s) {
  const at = new Map();
  for (const c of lineComments(s)) {
    const { side, line } = here(c).at, k = `${side}:${line}`;
    at.set(k, { side, lineNumber: line, metadata: (at.get(k)?.metadata ?? "") + `${c.key}.${editing.has(c.key)}.${c.text.length};` });
  }
  return [...at.values()];
}

function mount(el) {
  const s = SYM[el.dataset.diff];
  if (!s || mounted.has(s.id)) return;
  const fileDiff = parsePatchFiles(rowsToPatch(s.file, s.rows), "u-" + s.id)[0].files[0];
  // Highlight with the grammar this page carries for the file's language, else as plain text.
  const lang = DATA.files[s.file]?.lang;
  fileDiff.lang = globalThis.UNDERSTAND_LANGS?.[lang] ? lang : "text";
  const flagged = s.rows.filter((r) => r.x && FLAG_TEXT[r.x]);
  const words = wordMarks(s.rows);
  const inst = new FileDiff({
    theme: { dark: "pierre-dark", light: "pierre-light" },
    themeType: themeNow(),
    diffStyle: "unified",
    overflow: "wrap",
    hunkSeparators: "simple",
    lineDiffType: "none", // changed words are marked below, on lines that are edits of each other
    disableFileHeader: true,
    enableLineSelection: true,
    enableGutterUtility: true,
    onGutterUtilityClick(range) {
      const side = (x) => (x === "deletions" ? "old" : "new");
      const t = linesTarget(s, side(range.side), range.start, side(range.endSide ?? range.side), range.end);
      if (!t) return;
      inst.setSelectedLines(null);
      addComment(t);
    },
    renderAnnotation(a) {
      const el = document.createElement("div");
      el.className = "cmts in-code";
      el.innerHTML = lineComments(s).filter((c) => here(c).at.side === a.side && here(c).at.line === a.lineNumber).map(commentHTML).join("");
      return el;
    },
    onPostRender(node, _i, phase) {
      if (phase === "unmount" || !node.shadowRoot) return;
      for (const line of node.shadowRoot.querySelectorAll("[data-line]")) {
        const key = { "change-deletion": "d", "change-addition": "a" }[line.dataset.lineType];
        if (key && words.has(key + line.dataset.line) && !line.querySelector("[data-diff-span]")) markWords(line, words.get(key + line.dataset.line));
        wrapLikeCode(line);
      }
      for (const r of flagged) {
        const sel = r.t === "+" ? `[data-line-type="change-addition"][data-line="${r.n}"]` : `[data-line-type="change-deletion"][data-line="${r.o}"]`;
        for (const line of node.shadowRoot.querySelectorAll(sel)) { line.setAttribute("data-prov", r.x); line.title = FLAG_TEXT[r.x]; }
      }
    },
    unsafeCSS: DIFF_CSS,
  });
  inst.render({ fileDiff, containerWrapper: el, lineAnnotations: lineAnnotations(s) });
  mounted.set(s.id, inst);
  el.style.minHeight = "";
}

/* Short code sticks beside a taller reasons panel; code taller than the screen scrolls as usual. */
const fits = new ResizeObserver((entries) => {
  for (const e of entries) {
    const col = e.target, reasons = col.nextElementSibling;
    col.classList.toggle("stick", !!reasons && col.offsetHeight < reasons.offsetHeight && col.offsetHeight < innerHeight - 140);
  }
});

/* A signature that wraps is only as wide as its longest line, so file:line sits right after it. */
const heads = new ResizeObserver((entries) => {
  for (const e of entries) {
    const sig = e.target.querySelector(".sig");
    if (!sig) continue;
    sig.style.width = "";
    const r = document.createRange();
    r.selectNodeContents(sig);
    const boxes = [...r.getClientRects()];
    if (new Set(boxes.map((b) => Math.round(b.top))).size < 2) continue;
    sig.style.width = `${Math.ceil(Math.max(...boxes.map((b) => b.right)) - Math.min(...boxes.map((b) => b.left))) + 1}px`;
  }
});

const near = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) { near.unobserve(e.target); mount(e.target); }
}, { rootMargin: "1200px 0px" });
function observeDiffs(root = document) {
  for (const el of $$(".code[data-diff]", root)) if (!mounted.has(el.dataset.diff)) near.observe(el);
  for (const col of $$(".code-col", root)) fits.observe(col);
  for (const h of $$("article.sym > .sym-head", root)) heads.observe(h);
}

/* ---------- symbols ---------- */
function chipHTML(id) {
  const d = DEC[id];
  if (!d) return "";
  return `<button class="chip${state.focus === id ? " active" : ""}" data-dec="${esc(id)}" title="${esc(d.title)}. ${showAll(d)}">${badge(d)}<span class="id">${esc(id)}</span><span class="ct">${esc(d.title)}</span></button>`;
}
const chipsHTML = (s) => liveDec(s).map((d) => chipHTML(d.id)).join("");

function gapText(s) {
  const parts = [];
  if (s.gaps.outside) parts.push("Some lines weren't written by an observed agent tool: a manual edit, or a program the recorder can't see.");
  if (s.gaps.before) parts.push("Some lines changed before recording started, so no reason was captured.");
  if (s.gaps.unlinked) parts.push("No decision names this symbol for some of the agent's edits to it.");
  return parts.join(" ") || "No recorded edit produced this change.";
}

const afterTag = `<span class="after" title="Not recorded while coding; written when the change was explained">written afterwards</span>`;
/* "option: why not", as recorded with --alt */
function altHTML(a) {
  const i = a.search(/:\s/);
  return `<li>${i > 0 ? `<b>${md(a.slice(0, i))}</b><span>${md(a.slice(i + 1).trim())}</span>` : `<span>${md(a)}</span>`}</li>`;
}
const badge = (d) => `<span class="badge ${d.who === "human" ? "human" : "agent"}">${d.who === "human" ? "You" : "Agent"}</span>`;
const shaped = (d) => DATA.symbols.filter((s) => allDec(s).includes(d.id)).length;
const showAll = (d) => `Show all ${plural(shaped(d), "change")} ${esc(d.id)} shaped`;
const decRef = (d) => `<button class="dref${state.focus === d.id ? " active" : ""}" data-dec="${esc(d.id)}" title="${showAll(d)}">${badge(d)}<span class="t">${md(d.title)}</span><span class="id">${esc(d.id)}</span><span class="hint"><span class="h-show">${showAll(d)} →</span><span class="h-on">Showing its changes · click to clear</span></span></button>`;

/* Beside the code: what it does, why, what was rejected, and the risks, from the decisions first. */
/*
 * A decision's full reasons (why, rejected, risks) show on the first card it shaped, in reading
 * order; later cards name it and link back. Decisions replaced by another on the same symbol are left out.
 */
const firstCard = new Map(); // decision id -> symbol id of the first card that shows it in full
/** The decisions this card shows in full: those no earlier card (or import row) did. */
const shownHere = (s) => liveDec(s).filter((d) => { if (!firstCard.has(d.id)) firstCard.set(d.id, s.id); return firstCard.get(d.id) === s.id; });
function reasonsHTML(s) {
  const decs = liveDec(s);
  const full = shownHere(s);
  const [lead, ...also] = decs;
  const home = (d) => (full.includes(d) ? null : firstCard.get(d.id));
  const seeAbove = (d) => { const t = SYM[home(d)]; return t ? `<a class="above" href="#sym-${t.id}" data-jump="${t.id}">Reasons with ${esc(nameIn(t, s))} ↑</a>` : ""; };
  const sec = (label, body, cls = "") => (body ? `<section class="${cls}"><h4>${label}</h4>${body}</section>` : "");
  const why = [
    lead ? `${decRef(lead)}${full.includes(lead) && lead.ctx ? `<p>${md(lead.ctx)}</p>` : seeAbove(lead)}` : "",
    s.why ? `<p>${md(s.why)} ${afterTag}</p>` : "",
    also.length ? `<div class="also"><span class="sub">Also shaped by</span>${also.map((d, i) => decRef(d) + (full.includes(d) ? (d.ctx ? `<p>${md(d.ctx)}</p>` : "") : home(d) === home(also[i + 1] ?? {}) ? "" : seeAbove(d))).join("")}</div>` : "",
  ].join("");
  const rejected = full.flatMap((d) => d.alts.map(altHTML)).join("");
  const way = (rejected ? `<ul class="rej">${rejected}</ul>` : "") + (s.how ? `<p>${md(s.how)} ${afterTag}</p>` : "");
  const shownRisks = s.risks.filter((r) => !r.from || full.some((d) => d.id === r.from));
  const risks = shownRisks.length ? `<ul class="risks">${shownRisks.map((r) => `<li><span>${md(r.text)} ${r.from ? `<span class="id">${esc(r.from)}</span>` : afterTag}</span></li>`).join("")}</ul>` : "";
  const attn = s.attn === "careful" ? "Needs care" : s.attn === "mechanical" ? "Mechanical" : "";
  return `<aside class="reasons">
    ${attn && s.attnWhy && !unexplained(s) ? `<section class="attn ${s.attn}"><h4>${attn}</h4><p>${md(s.attnWhy)}</p></section>` : ""}
    ${sec("What it does", `<p>${s.sum ? md(s.sum) : `<span class="unnarrated">Not explained yet.</span>`}</p>`)}
    ${unexplained(s) ? sec("Unexplained", `<p>${esc(gapText(s))}</p>`, "gap") : ""}
    ${sec("Why", why)}
    ${sec("Rejected", way)}
    ${sec("Risks", risks, "risk")}
    <div class="cmts" data-cmts="${s.id}">${symComments(s)}</div>
  </aside>`;
}

function symHTML(s) {
  const sig = s.kind === "file" ? `${base(s.file)} ${s.name}` : s.kind === "other" ? s.name : s.sig || s.name;
  const pill = unexplained(s) ? `<span class="pill gap">Unexplained</span>` : s.attn === "careful" ? `<span class="pill care" title="${esc(s.attnWhy ?? "")}">Needs care</span>` : s.attn === "mechanical" ? `<span class="pill mech" title="${esc(s.attnWhy ?? "")}">Mechanical</span>` : "";
  const n = s.rows.filter((r) => r.t !== "gap").length;
  const collapsed = !state.codeOpen.has(s.id) && (s.status === "moved" || s.status === "removed");
  const code = !s.rows.length
    ? `<div class="collapsed-bar">${esc(DATA.files[s.file]?.note ?? "No line content")}</div>`
    : collapsed
      ? `<button class="collapsed-bar" data-code="${s.id}">${ICON.chevron}Show the ${plural(n, s.status === "moved" ? "unchanged line" : "deleted line")}</button>`
      : `<div class="code" data-diff="${s.id}" style="min-height:${Math.min(s.rows.length, 400) * 20}px"></div>`;
  const cls = ["sym", folded(s) ? "folded" : "", state.current === s.id ? "current" : ""].join(" ");
  return `<article class="${cls}" id="sym-${s.id}" data-id="${s.id}" tabindex="-1">
    <div class="sym-head">
      <button class="chev" data-fold="${s.id}" aria-label="Fold" aria-expanded="${!folded(s)}">${ICON.chevron}</button>
      <span class="glyph ${s.status}" title="${s.status}">${GLYPH[s.status]}</span>
      <code class="sig" title="${esc(sig)}">${esc(sig).replace(/-&gt;|=&gt;/g, '<span class="nw">$&</span>').replace(/([(,]\s*)([^(),<]{1,40}?)(?=[,)])/g, '$1<span class="nw">$2</span>')}</code>
      ${s.kind === "file" ? "" : s.status === "removed" ? `<span class="path" title="${esc(s.file)}, was at line ${esc(s.line)}">${esc(base(s.file))}</span>` : `<span class="path" title="${esc(s.file)}">${esc(base(s.file))}:${esc(s.line)}</span>`}
      ${pmHTML(counts(s))}
      ${s.moved ? `<span class="tag">moved from ${esc(s.moved)}</span>` : ""}
      ${s.note ? `<span class="tag warn">${esc(s.note)}</span>` : ""}
      ${pill}
      <span class="spacer"></span>
      <button class="btn" data-comment="${s.id}" title="Comment on this symbol (c)">${ICON.comment}Comment</button>
      <label class="btn view" title="Mark viewed (x)"><input type="checkbox" data-rev="${s.id}"${viewed(s) ? " checked" : ""}><span class="off">Mark viewed</span><span class="on">Viewed</span></label>
    </div>
    <div class="body"><div class="code-col">${code}</div>${reasonsHTML(s)}</div>
  </article>`;
}

function importRowHTML(s) {
  const changed = s.rows.filter((r) => r.t === "+" || r.t === "-");
  const cls = ["imp", state.current === s.id ? "current" : ""].join(" ");
  return `<div class="${cls}" id="sym-${s.id}" data-id="${s.id}" tabindex="-1">
    <span class="glyph ${s.status}">${GLYPH[s.status]}</span>
    <span class="imp-code">${(changed.length ? changed : [{ t: "", s: s.name }]).map((r) => `<code class="${r.t === "-" ? "minus" : r.t === "+" ? "plus" : ""}">${esc(r.s.trim()).replace(/\./g, ".<wbr>")}</code>`).join("")}</span>
    <span class="sum">${s.sum ? md(s.sum) : `<span class="unnarrated">Not explained yet.</span>`}</span>
    <span class="acts">${unexplained(s) ? `<span class="pill gap">Unexplained</span>` : chipsHTML(s)}<button class="btn small icon" data-comment="${s.id}" title="Comment on this import (c)" aria-label="Comment">${ICON.comment}</button><label class="btn view" style="height: 24px" title="Mark viewed (x)"><input type="checkbox" data-rev="${s.id}"${viewed(s) ? " checked" : ""}><span class="off">Mark viewed</span><span class="on">Viewed</span></label></span>
    ${impReasons(s)}
    <div class="cmts" data-cmts="${s.id}">${symComments(s)}</div>
  </div>`;
}

/* A decision met first on an import (say, which library to use) has its reasons shown there. */
function impReasons(s) {
  const own = shownHere(s);
  if (!own.length) return "";
  return `<div class="imp-reasons reasons">${own.map((d) => `<div class="imp-dec">${decRef(d)}${d.ctx ? `<p>${md(d.ctx)}</p>` : ""}${d.alts.length ? `<ul class="rej">${d.alts.map(altHTML).join("")}</ul>` : ""}${d.risks.length ? `<ul class="risks">${d.risks.map((r) => `<li><span>${md(r)}</span></li>`).join("")}</ul>` : ""}</div>`).join("")}</div>`;
}

function groups() {
  if (state.order !== "files") {
    return DATA.chapters.map((c, i) => ({ num: String(i + 1).padStart(2, "0"), title: c.title, sum: c.sum, syms: c.syms.map((id) => SYM[id]).filter(Boolean) }));
  }
  return Object.keys(DATA.files).sort().map((f) => ({
    num: "", title: f, sum: null, file: true,
    syms: DATA.symbols.filter((s) => s.file === f).sort((a, b) => a.line - b.line),
  })).filter((g) => g.syms.length);
}

/* consecutive imports from one file render as one compact block */
function symsHTML(list) {
  let out = "";
  for (let i = 0; i < list.length; ) {
    const s = list[i];
    if (s.kind !== "import") { out += symHTML(s); i++; continue; }
    let j = i;
    while (j < list.length && list[j].kind === "import" && list[j].file === s.file) j++;
    const run = list.slice(i, j);
    out += `<section class="sym imports"><div class="sym-head"><span style="width: 24px"></span><span class="sig">Imports</span><span class="path" title="${esc(s.file)}">${esc(base(s.file))}</span>${pmHTML(sumCounts(run))}</div>${run.map(importRowHTML).join("")}</section>`;
    i = j;
  }
  return out;
}

function renderMain() {
  firstCard.clear();
  for (const inst of mounted.values()) inst.cleanUp();
  mounted.clear();
  near.disconnect();
  if (!DATA.symbols.length) {
    $("#chapters").innerHTML = `<p class="empty" style="padding: 24px">No changes in this range.</p>`;
    return;
  }
  $("#chapters").innerHTML = groups().map((g) => `<section class="chapter">
      <div class="chapter-head">${g.num ? `<span class="n">${g.num}</span>` : ""}<h2 class="${g.file ? "mono" : ""}">${md(g.title)}</h2>${g.sum ? `<p>${md(g.sum)}</p>` : ""}</div>
      ${symsHTML(g.syms)}
    </section>`).join("");
  applyFilters();
  observeDiffs();
}

/* ---------- filters ---------- */
function matches(s) {
  const q = state.q.trim().toLowerCase();
  if (q && !`${s.name} ${s.file}`.toLowerCase().includes(q)) return false;
  if (state.quick === "care") return s.attn === "careful";
  if (state.quick === "gap") return unexplained(s);
  if (state.quick === "commented") return commentCount(s) > 0;
  if (state.quick === "unviewed") return !viewed(s);
  return true;
}

function applyFilters() {
  for (const el of $$("#chapters [data-id]")) {
    const s = SYM[el.dataset.id];
    el.classList.toggle("hidden", !matches(s));
    el.classList.toggle("dim", !!state.focus && !allDec(s).includes(state.focus));
  }
  for (const el of $$("#chapters .imports")) el.style.display = $$(".imp:not(.hidden)", el).length ? "" : "none";
  for (const el of $$("#chapters .chapter")) el.style.display = $$("[data-id]:not(.hidden)", el).length ? "" : "none";
  for (const el of $$("#tree .t-row")) {
    const s = SYM[el.dataset.jump];
    el.style.display = matches(s) ? "" : "none";
    el.classList.toggle("dim", !!state.focus && !allDec(s).includes(state.focus));
  }
  for (const el of $$("#tree .t-group")) {
    let n = el.nextElementSibling, any = false;
    while (n && n.classList.contains("t-row")) { if (n.style.display !== "none") any = true; n = n.nextElementSibling; }
    el.style.display = any ? "" : "none";
  }
}

/* ---------- sidebar ---------- */
function renderSideShell() {
  $("#side").innerHTML = `
    <div class="seg" role="group" aria-label="Order">
      <button data-order="story" aria-pressed="${state.order === "story"}">Story</button>
      <button data-order="files" aria-pressed="${state.order === "files"}">Files</button>
      <button data-order="decisions" aria-pressed="${state.order === "decisions"}">Decisions</button>
    </div>
    <label class="filter">${ICON.search}<input id="q" placeholder="Filter symbols" aria-label="Filter symbols" value="${esc(state.q)}"><kbd>/</kbd></label>
    <div class="quick" id="quick"></div>
    <div id="tree"></div>`;
}

function renderQuick() {
  const n = { care: DATA.symbols.filter((s) => s.attn === "careful").length, gap: DATA.symbols.filter(unexplained).length, commented: DATA.symbols.filter((s) => commentCount(s) > 0).length, unviewed: DATA.symbols.filter((s) => !viewed(s)).length };
  const b = (k, text, cls = "") => `<button class="${cls}" data-quick="${k}" aria-pressed="${state.quick === k}"${n[k] || state.quick === k ? "" : " disabled"}>${text} ${n[k]}</button>`;
  $("#quick").innerHTML = b("care", "Needs care", "care") + (n.gap ? b("gap", "Unexplained", "gap") : "") + b("commented", "Commented") + b("unviewed", "Not viewed");
}

/* Symbols sharing a name within a file (overloads, prototype and definition) are told apart by signature. */
const TWINS = (() => {
  const seen = new Map();
  for (const s of DATA.symbols) { const k = s.file + "\0" + shortName(s); seen.set(k, (seen.get(k) ?? 0) + 1); }
  return new Set(DATA.symbols.filter((s) => seen.get(s.file + "\0" + shortName(s)) > 1).map((s) => s.id));
})();
/* An overload's signature from its own name on: `add(String title, String due)`, not `public Todo add(Strin…`. */
const fromName = (s) => { const last = shortName(s).split(/::|\./).at(-1), i = s.sig.indexOf(last + "("); return i > 0 ? s.sig.slice(i) : s.sig; };
/* A name that also appears in another file shows its file. */
const ELSEWHERE = (() => {
  const files = new Map();
  for (const s of DATA.symbols) files.set(shortName(s), new Set([...(files.get(shortName(s)) ?? []), s.file]));
  return new Set(DATA.symbols.filter((s) => files.get(shortName(s)).size > 1).map((s) => s.id));
})();

/** A symbol's name as seen from another card: with its file when the name alone could mean another symbol. */
const nameIn = (t, from) => shortName(t) + (TWINS.has(t.id) || ELSEWHERE.has(t.id) || shortName(t) === shortName(from) ? ` in ${base(t.file)}` : "");

/* Overloads show their parameters whole (they differ at the end); a long qualified name loses its start, not its member. */
function treeName(s) {
  if (TWINS.has(s.id)) return `<span class="t twin">${esc(s.sig ? fromName(s) : shortName(s))}</span>`;
  return /::|\./.test(shortName(s)) && !shortName(s).includes("(") ? `<span class="t lead"><bdi>${esc(shortName(s))}</bdi></span>` : `<span class="t">${esc(shortName(s))}</span>`;
}

function treeRow(s) {
  const c = commentCount(s);
  const marks = `<span class="marks">${unexplained(s) ? `<span class="dot gap" title="Unexplained"></span>` : s.attn === "careful" ? `<span class="dot" title="Needs care"></span>` : ""}${c ? `<span class="cc" title="${plural(c, "comment")}">${c}</span>` : ""}${pmHTML(counts(s))}</span>`;
  const lead = viewed(s) ? `<span class="glyph added">${ICON.check}</span>` : `<span class="glyph ${s.status}">${GLYPH[s.status]}</span>`;
  return `<a class="t-row${viewed(s) ? " viewed" : ""}${state.current === s.id ? " current" : ""}" href="#sym-${s.id}" data-jump="${s.id}">${lead}<span class="nm" title="${esc(s.file + ": " + (s.sig || shortName(s)))}">${treeName(s)}${ELSEWHERE.has(s.id) ? `<span class="in">${esc(base(s.file))}</span>` : ""}</span>${marks}</a>`;
}

function renderTree() {
  if (state.order === "decisions") {
    $("#tree").innerHTML = DATA.decisions.length ? DATA.decisions.map((d) => {
      const n = shaped(d);
      const c = comments.filter((x) => x.text && x.target.kind === "decision" && x.target.decision === d.id).length;
      return `<div class="d-row${state.focus === d.id ? " active" : ""}${d.supersededBy ? " superseded" : ""}" data-dec="${esc(d.id)}" title="${showAll(d)}">
        <div class="d-top"><span class="id">${esc(d.id)}</span><span>${md(d.title)}</span></div>
        <div class="d-meta">${badge(d)}<span>${plural(n, "symbol")}</span>${d.supersededBy ? `<span>replaced by ${esc(d.supersededBy)}</span>` : ""}${d.mechanical ? "<span>mechanical</span>" : ""}${c ? `<span class="cc">${c}</span>` : ""}<span class="spacer"></span><button class="link quiet" data-comment-dec="${esc(d.id)}">Comment</button></div>
      </div>`;
    }).join("") : `<p class="empty">No decisions were recorded.</p>`;
  } else {
    $("#tree").innerHTML = groups().map((g) => `<div class="t-group${g.file ? " file" : ""}">${g.num ? `<span class="n">${g.num}</span>` : ""}<span>${esc(g.title)}</span></div>${g.syms.map(treeRow).join("")}`).join("");
  }
  renderQuick();
  applyFilters();
}

/* ---------- review rail ---------- */
/* The next change to review: the first one that needs care and isn't viewed, else the first not viewed. */
function nextUp() {
  const order = groups().flatMap((g) => g.syms);
  return order.find((s) => needsCare(s) && !viewed(s)) ?? order.find((s) => !viewed(s)) ?? null;
}

function renderRail() {
  const total = DATA.symbols.length, seen = DATA.symbols.filter(viewed).length;
  const careLeft = groups().flatMap((g) => g.syms).filter((s) => needsCare(s) && !viewed(s));
  const next = nextUp();
  const n = comments.filter((c) => c.text).length;
  const list = inPageOrder(live());
  const item = (c) => {
    const t = c.target, s = t.kind === "decision" ? null : REF[t.symbol];
    if (t.kind === "decision" || !anchored(c) || !s) {
      return `<div class="r-item"><span class="r-where">${esc(whereText(t))}</span>${t.kind === "lines" ? `<span class="r-stale">The code it quotes has changed since.</span>${t.quote ? `<pre class="r-quote">${esc(t.quote)}</pre>` : ""}` : ""}${commentHTML(c)}</div>`;
    }
    return `<a class="r-item" href="#sym-${s.id}" data-jump="${s.id}"><span class="r-where">${esc(shortWhere(here(c)))}${editing.has(c.key) ? " · draft" : ""}</span><span class="r-text">${esc(editing.has(c.key) ? editing.get(c.key) || "…" : c.text)}</span></a>`;
  };
  const why = (s) => (unexplained(s) ? "Unexplained" : s.attnWhy || (needsCare(s) ? "Needs care" : ""));
  const nextCard = next
    ? `<div class="next">
        <span class="k">${needsCare(next) ? `Next · ${[careLeft.filter((x) => !unexplained(x)).length, careLeft.filter(unexplained).length].map((k, i) => (k ? `${k} ${i ? "unexplained" : k === 1 ? "needs care" : "need care"}` : "")).filter(Boolean).join(" · ")}` : `Next · ${total - seen} not viewed`}</span>
        <b class="mono">${esc(nameIn(next, {}))}</b>
        ${why(next) ? `<span class="why${needsCare(next) ? " care" : ""}">${esc(why(next))}</span>` : ""}
        <button class="btn primary" data-jump="${next.id}">Review it <kbd>n</kbd></button>
      </div>`
    : `<div class="next done"><span class="k">Review complete</span><b>You've viewed all ${plural(total, "change")}.</b>
        ${n ? `<button class="btn primary" data-copy>${ICON.copy}Copy ${plural(n, "comment")} as a prompt</button><span class="why">Paste them into your agent.</span>` : `<span class="why">No comments to send.</span>`}</div>`;
  const later = careLeft.filter((s) => s !== next);
  $("#rail").innerHTML = `
    <div class="rail-body">
      ${nextCard}
      ${later.length ? `<h3>Also needs care</h3><div class="r-care">${later.map((s) => `<a href="#sym-${s.id}" data-jump="${s.id}"><span class="mono">${esc(nameIn(s, {}))}</span><span>${esc(why(s))}</span></a>`).join("")}</div>` : ""}
      <h3>Your comments${n ? ` · ${n}` : ""}</h3>
      ${list.length ? list.map(item).join("") : `<p class="empty" style="padding: 0">Click <b>+</b> beside a line (drag it to cover several), or Comment on a symbol or decision.</p>`}
    </div>
    ${n && next ? `<div class="rail-foot"><button class="btn primary" data-copy>${ICON.copy}Copy ${plural(n, "comment")} as a prompt</button><div class="row"><span>Paste into your agent</span><button class="link quiet" data-clear-all>Delete all</button></div></div>` : ""}`;
}

function renderTop() {
  $("#range").innerHTML = `<span>${esc(DATA.branch)}</span><span class="base">${esc(DATA.baseLabel)} → ${esc(DATA.headLabel)}</span>`;
  $("#range").title = `${DATA.branch}: ${DATA.baseLabel} → ${DATA.headLabel}`;
  $("#totals").innerHTML = `${pmHTML(sumCounts(DATA.symbols))}<span class="meta-txt">${plural(Object.keys(DATA.files).length, "file")} · ${plural(DATA.symbols.length, "symbol")} · ${plural(DATA.decisions.length, "decision")}</span>`;
  renderProgress();
  renderCopy();
}
function renderProgress() {
  const n = DATA.symbols.filter(viewed).length, t = DATA.symbols.length;
  $("#prog-text").textContent = `${n} of ${t} viewed`;
  $("#prog-bar").style.width = t ? `${(100 * n) / t}%` : "0";
}
function renderCopy() {
  const n = comments.filter((c) => c.text).length;
  const b = $("#copy-top");
  b.innerHTML = `${ICON.copy}<span class="lbl">Copy ${plural(n, "comment")}</span>`;
  b.title = `Copy ${plural(n, "comment")} as a prompt`;
  b.hidden = !n;
  b.disabled = !n;
}

function renderHead() {
  const s = DATA.symbols;
  const human = DATA.decisions.filter((d) => d.who === "human" && !d.supersededBy).length;
  const gaps = s.filter(unexplained).length, care = s.filter((x) => x.attn === "careful").length;
  $("#title").innerHTML = md(DATA.title);
  $("#intent").innerHTML = md(DATA.intent);
  $("#intent").hidden = !DATA.intent;
  $("#meta").innerHTML = [
    `<span>${plural(DATA.decisions.length, "decision")}${human ? `, ${human} made by you` : ""}</span>`,
    care ? `<span class="care">${care} need care</span>` : "",
    gaps ? `<span class="gap">${plural(gaps, "symbol")} unexplained</span>` : s.length ? `<span class="ok">Every change explained</span>` : "",
    DATA.sessions ? `<span>${plural(DATA.sessions, "session")}</span>` : "",
  ].join("");
  const banners = [];
  if (DATA.byName) banners.push("Built from the checked-in decision log (<code>.decisions/</code>), which matches decisions to symbols by name. Line-by-line provenance is only available where the work was recorded.");
  if (DATA.ignoredWrites.length) banners.push(`The agent also wrote ${plural(DATA.ignoredWrites.length, "file")} that git ignores, so ${DATA.ignoredWrites.length === 1 ? "it isn't" : "they aren't"} shown: ${DATA.ignoredWrites.map((f) => `<code>${esc(f)}</code>`).join(", ")}`);
  for (const w of DATA.warnings) banners.push(esc(w));
  $("#banners").innerHTML = banners.map((b) => `<div class="banner">${b}</div>`).join("");
}

function renderFocus() {
  const el = $("#focus"), d = state.focus && DEC[state.focus];
  el.hidden = !d;
  if (!d) return;
  const n = shaped(d);
  el.innerHTML = `<div class="d-top"><span class="id">${esc(d.id)}</span><b>${md(d.title)}</b>${badge(d)}<span class="spacer"></span><button class="btn" data-comment-dec="${esc(d.id)}">${ICON.comment}Comment</button><button class="btn" data-clear>Clear <kbd>esc</kbd></button></div>
    ${d.ctx ? `<div>${md(d.ctx)}</div>` : ""}
    ${d.alts.length ? `<ul>${d.alts.map((a) => `<li>Rejected: ${md(a)}</li>`).join("")}</ul>` : ""}
    ${d.risks.length ? `<ul>${d.risks.map((r) => `<li>Risk: ${md(r)}</li>`).join("")}</ul>` : ""}
    <div class="d-meta">Shaped ${plural(n, "symbol")}${d.supersedes ? ` · revises ${esc(d.supersedes)}` : ""}${d.supersededBy ? ` · replaced by ${esc(d.supersededBy)}` : ""}</div>`;
}

/* ---------- state changes ---------- */
function refreshComments() {
  for (const [id, inst] of mounted) { inst.setLineAnnotations(lineAnnotations(SYM[id])); inst.rerender(); }
  for (const el of $$("[data-cmts]")) el.innerHTML = symComments(SYM[el.dataset.cmts]);
  renderTree(); renderRail(); renderCopy();
}

function setFold(s, fold) {
  state.fold.delete(s.id); state.unfold.delete(s.id);
  if (fold !== viewed(s)) (fold ? state.fold : state.unfold).add(s.id);
  const el = $("#sym-" + s.id);
  if (el?.classList.contains("sym")) { el.classList.toggle("folded", fold); $(".chev", el)?.setAttribute("aria-expanded", String(!fold)); }
}

function setViewed(s, on) {
  on ? state.viewed.add(s.key) : state.viewed.delete(s.key);
  store.set("reviewed", [...state.viewed]);
  setFold(s, on);
  for (const cb of $$(`[data-rev="${s.id}"]`)) cb.checked = on;
  renderProgress(); renderTree(); renderRail();
}

function setFocus(id) {
  state.focus = state.focus === id ? null : id;
  renderFocus(); renderTree(); applyFilters();
  for (const c of $$(".chip, .dref")) c.classList.toggle("active", c.dataset.dec === state.focus);
  if (state.focus) $$("#chapters [data-id]:not(.dim):not(.hidden)")[0]?.scrollIntoView({ behavior: "smooth", block: "start" });
}

/* The symbol the keys act on. Keyboard moves ring it; scrolling only follows along in the tree. */
function setCurrent(id, scroll = true, ring = true) {
  if (!id) return;
  state.current = id;
  $$("#chapters .current").forEach((e) => e.classList.remove("current"));
  $$("#tree .t-row.current").forEach((e) => e.classList.remove("current"));
  $(`#tree .t-row[data-jump="${id}"]`)?.classList.add("current");
  const el = $("#sym-" + id);
  if (!el) return;
  if (ring) el.classList.add("current");
  if (scroll) el.scrollIntoView({ behavior: "smooth", block: "start" });
}

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("on");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("on"), 3500);
}

/* Show a moved or deleted symbol's collapsed code. */
function openCode(id) {
  const bar = $(`#sym-${id} [data-code]`);
  if (!bar) return;
  state.codeOpen.add(id);
  bar.outerHTML = `<div class="code" data-diff="${id}"></div>`;
  observeDiffs($("#sym-" + id));
}

/* ---------- events ---------- */
document.addEventListener("click", (e) => {
  if (!e.target.closest("#keys, [data-keys]")) { $("#keys").hidden = true; $("[data-keys]").setAttribute("aria-expanded", "false"); }
  const t = e.target.closest("[data-zen],[data-theme-pick],[data-keys],[data-rail],[data-comment],[data-comment-dec],[data-c-save],[data-c-cancel],[data-c-edit],[data-c-delete],[data-copy],[data-clear-all],[data-order],[data-quick],[data-fold],[data-code],[data-dec],[data-jump],[data-clear]");
  if (!t || t.disabled) return;
  const d = t.dataset;
  if (d.zen !== undefined) setZen(!document.body.classList.contains("zen"));
  else if (d.themePick) setThemePick(d.themePick);
  else if (d.keys !== undefined) { const k = $("#keys"); k.hidden = !k.hidden; t.setAttribute("aria-expanded", String(!k.hidden)); }
  else if (d.rail !== undefined) document.body.classList.toggle("rail-open");
  else if (d.comment) addComment({ kind: "symbol", symbol: SYM[d.comment].ref });
  else if (d.commentDec) { addComment({ kind: "decision", decision: d.commentDec }); document.body.classList.add("rail-open"); }
  else if (d.cSave) saveComment(d.cSave);
  else if (d.cCancel) cancelComment(d.cCancel);
  else if (d.cEdit) { editing.set(d.cEdit, comments.find((c) => c.key === d.cEdit)?.text ?? ""); refreshComments(); focusComment(d.cEdit); }
  else if (d.cDelete) deleteComment(d.cDelete);
  else if (d.copy !== undefined) copyAll();
  else if (d.clearAll !== undefined) {
    if (!confirm(`Delete all ${plural(comments.length, "comment")}?`)) return;
    comments.length = 0; editing.clear(); saveComments(); refreshComments();
  } else if (d.order) {
    state.order = d.order; store.set("view", state.order);
    $$("[data-order]").forEach((b) => b.setAttribute("aria-pressed", b.dataset.order === state.order));
    renderMain(); renderTree(); renderRail();
  } else if (d.quick) { state.quick = state.quick === d.quick ? null : d.quick; renderQuick(); applyFilters(); }
  else if (d.fold) { const s = SYM[d.fold]; setFold(s, !folded(s)); }
  else if (d.code) openCode(d.code); else if (d.dec) { if (!e.target.closest(".cmts, .link")) setFocus(d.dec); }
  else if (d.jump) {
    e.preventDefault();
    const s = SYM[d.jump];
    if (!matches(s)) { state.q = ""; state.quick = null; $("#q").value = ""; renderQuick(); applyFilters(); }
    if (folded(s)) setFold(s, false);
    if (lineComments(s).length) openCode(s.id); // so its line comments can show
    document.body.classList.remove("rail-open");
    setCurrent(d.jump);
  } else if (d.clear !== undefined) setFocus(state.focus);
});

document.addEventListener("input", (e) => {
  if (e.target.id === "q") { state.q = e.target.value; applyFilters(); return; }
  const key = e.target.dataset?.c;
  if (key && editing.has(key)) {
    editing.set(key, e.target.value);
    for (const other of $$(`textarea[data-c="${key}"]`)) if (other !== e.target) other.value = e.target.value;
  }
});

document.addEventListener("change", (e) => {
  const id = e.target.dataset?.rev;
  if (id) setViewed(SYM[id], e.target.checked);
});

document.addEventListener("keydown", (e) => {
  if (e.target.matches("textarea[data-c]")) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveComment(e.target.dataset.c); }
    else if (e.key === "Escape") { e.preventDefault(); cancelComment(e.target.dataset.c); }
    return;
  }
  if (e.target.id === "q" && e.key === "Escape") { e.target.blur(); return; }
  if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
  const vis = $$("#chapters [data-id]:not(.hidden)").map((el) => el.dataset.id);
  const i = vis.indexOf(state.current);
  const cur = state.current && vis.includes(state.current) ? SYM[state.current] : null;
  if (e.key === "j") setCurrent(vis[Math.min(vis.length - 1, i + 1)]);
  else if (e.key === "k") setCurrent(vis[Math.max(0, i - 1)]);
  else if (e.key === "x" && cur) setViewed(cur, !viewed(cur));
  else if (e.key === "c" && cur) addComment({ kind: "symbol", symbol: cur.ref });
  else if (e.key === "o" && cur) setFold(cur, !folded(cur));
  else if (e.key === "e" && cur) openCode(cur.id);
  else if (e.key === "n") { const s = nextUp(); if (s) $(`[data-jump="${s.id}"]`)?.click(); }
  else if (e.key === "z") setZen(!document.body.classList.contains("zen"));
  else if (e.key === "/") { if (document.body.classList.contains("zen")) setZen(false); $("#q").focus(); }
  else if (e.key === "?") $("[data-keys]").click();
  else if (e.key === "Escape") { if (state.focus) setFocus(state.focus); $("#keys").hidden = true; document.body.classList.remove("rail-open"); }
  else return;
  e.preventDefault();
});

/* scrollspy: the symbol under the reading line is the current one in the tree */
let spyTimer;
window.addEventListener("scroll", () => {
  clearTimeout(spyTimer);
  spyTimer = setTimeout(() => {
    const all = $$("#chapters [data-id]:not(.hidden)");
    let cur = all[0]?.dataset.id ?? null;
    for (const el of all) { if (el.getBoundingClientRect().top <= 140) cur = el.dataset.id; else break; }
    if (innerHeight + scrollY >= document.body.scrollHeight - 4) cur = all.at(-1)?.dataset.id ?? cur; // the end of the page
    if (!cur || cur === state.current) return;
    setCurrent(cur, false, false); // the keys act on what you're reading
    const row = $(`#tree .t-row[data-jump="${cur}"]`);
    row?.scrollIntoView({ block: "nearest" });
    if (row?.previousElementSibling?.classList.contains("t-group")) row.previousElementSibling.scrollIntoView({ block: "nearest" }); // with its chapter heading
  }, 60);
}, { passive: true });

/* ---------- init ---------- */
applyTheme();
setZen((() => { try { return localStorage.getItem("understand:zen") === "1"; } catch { return false; } })());
renderTop(); renderHead(); renderSideShell(); renderMain(); renderTree(); renderRail();
