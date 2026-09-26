// Bundles the CLI and the viewer into dist/ with everything they need at runtime, so the plugin
// works without `npm install`.
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WASM = "node_modules/@vscode/tree-sitter-wasm/wasm/";
// Each language is data: languages/<id>/lang.json names its grammar; outline.scm is its query.
const LANGS = readdirSync("languages").map((id) => ({ id, ...JSON.parse(readFileSync(`languages/${id}/lang.json`, "utf8")) }));

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/wasm", { recursive: true });

const cli = await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/understand.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
  metafile: true,
});

// The viewer: @pierre/diffs renders the diffs with one theme pair, highlighting with Shiki's
// JavaScript regex engine (no WebAssembly), all inlined into one page. Grammars aren't in it: each
// language's is its own script in dist/highlight/, and a page carries only those its diff uses.
const THEMES = new Set(["pierre-dark", "pierre-light"]);
// Token colours must read on everything they land on: context, added and removed rows, and the
// stronger boxes marking the changed words (WCAG AA, 4.5:1).
const ROWS = { "pierre-light": ["#ffffff", "#e7f4ec", "#fce9ea", "#c8e7d8", "#f3cac8"], "pierre-dark": ["#16171a", "#1f352d", "#3a1d1f", "#19513e", "#5b2126"] };
const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const mix = (hex, to, t) => "#" + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * (1 - t) + to * t).toString(16).padStart(2, "0")).join("");
function readable(hex, rows, dark) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  for (let t = 0; t <= 1; t += 0.02) {
    const c = mix(hex, dark ? 255 : 0, t);
    if (rows.every((bg) => ratio(c, bg) >= 4.5)) return c;
  }
  return hex;
}
const trim = {
  name: "trim",
  setup(b) {
    b.onLoad({ filter: /[\\/]pierre-(light|dark)\.mjs$/ }, async (a) => {
      const name = a.path.match(/(pierre-(?:light|dark))\.mjs$/)[1];
      const theme = structuredClone((await import(pathToFileURL(a.path).href)).default);
      for (const r of theme.tokenColors ?? []) if (r.settings?.foreground) r.settings.foreground = readable(r.settings.foreground.slice(0, 7), ROWS[name], name.endsWith("dark"));
      return { contents: `export default ${JSON.stringify(theme)}`, loader: "js" };
    });
    b.onResolve({ filter: /^shiki$/ }, () => ({ path: resolve("viewer/shiki-lite.mjs") }));
    b.onResolve({ filter: /^shiki\/wasm$|^@shikijs\/themes\/|^react(-dom)?(\/.*)?$/ }, (a) => ({ path: a.path, namespace: "stub" }));
    b.onResolve({ filter: /^@pierre\/theme\// }, (a) => (THEMES.has(a.path.split("/").pop()) ? undefined : { path: a.path, namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "export default {}", loader: "js" }));
  },
};
const viewer = await build({
  entryPoints: ["viewer/app.js"],
  bundle: true,
  minify: true,
  format: "iife",
  target: "es2022",
  write: false,
  legalComments: "none",
  metafile: true,
  plugins: [trim],
});

// dist/ ships other people's code; their licenses require keeping these notices with it.
const viewerNotices = notices(viewer.metafile);
const app = `/*! Understand viewer. Includes third-party software:\n${viewerNotices.replaceAll("*/", "* /")}\n*/\n${viewer.outputFiles[0].text}`;
const shell = readFileSync("viewer/viewer.html", "utf8");
if (shell.split("/*__UNDERSTAND_APP__*/").length !== 2) throw new Error("viewer/viewer.html must hold the app placeholder exactly once");
const page = shell.replace("/*__UNDERSTAND_APP__*/", () => app.replace(/<\/script/gi, "<\\/script"));
writeFileSync("dist/viewer.html", page);

mkdirSync("dist/highlight", { recursive: true });
const highlightInputs = {};
for (const id of new Set(LANGS.map((l) => l.highlight).filter(Boolean))) {
  const grammar = await build({
    stdin: { contents: `import g from "@shikijs/langs/${id}"; (globalThis.UNDERSTAND_LANGS ??= {})[${JSON.stringify(id)}] = g;`, resolveDir: ".", loader: "js" },
    bundle: true, minify: true, format: "iife", target: "es2022", write: false, legalComments: "none", metafile: true,
  });
  writeFileSync(`dist/highlight/${id}.js`, grammar.outputFiles[0].text.replace(/<\/script/gi, "<\\/script"));
  Object.assign(highlightInputs, grammar.metafile.inputs);
}

// .cjs: the runtime is UMD and must not be treated as ESM under this package's "type": "module".
copyFileSync(WASM + "tree-sitter.js", "dist/wasm/tree-sitter.cjs");
copyFileSync(WASM + "tree-sitter.wasm", "dist/wasm/tree-sitter.wasm");
for (const l of LANGS) {
  if (l.grammar) copyFileSync(l.grammar, "dist/wasm/" + basename(l.grammar));
  mkdirSync(`dist/languages/${l.id}`, { recursive: true });
  for (const f of ["lang.json", "outline.scm"]) if (existsSync(`languages/${l.id}/${f}`)) copyFileSync(`languages/${l.id}/${f}`, `dist/languages/${l.id}/${f}`);
}

const mit = (holder) => `MIT License\n\nCopyright (c) ${holder}\n\n${readFileSync("LICENSE", "utf8").split("\n").slice(4).join("\n").trim()}\n`;
// The runtime, then each grammar once (tsx shares typescript's), from the languages' own data.
const treeSitter = [["tree-sitter (runtime, dist/wasm/tree-sitter.*)", "https://github.com/tree-sitter/tree-sitter", "2018 Max Brunsfeld"]];
for (const l of LANGS) if (l.license && !treeSitter.some(([, url]) => url === l.license.source)) treeSitter.push([`${basename(l.license.source)} (dist/wasm/${basename(l.grammar)})`, l.license.source, l.license.copyright]);
writeFileSync("dist/THIRD_PARTY_NOTICES.md", "# Third-party notices\n\nThe built plugin in this folder includes the following software.\n\n" +
  "## Bundled into dist/understand.mjs\n\n" + notices(cli.metafile) +
  "\n## Bundled into dist/viewer.html (and every page rendered from it)\n\n" + viewerNotices + "\n" +
  "## Syntax grammars in dist/highlight/ (a page carries those for the languages it shows)\n\n" + notices({ inputs: highlightInputs }) + "\n" +
  section("@vscode/tree-sitter-wasm (the WebAssembly builds in dist/wasm/)", "https://github.com/microsoft/vscode-tree-sitter-wasm", readFileSync("node_modules/@vscode/tree-sitter-wasm/LICENSE", "utf8")) +
  treeSitter.map(([name, url, holder]) => section(name, url, mit(holder))).join(""));
console.log(`built dist/ (viewer ${(page.length / 1024 / 1024).toFixed(2)} MiB)`);

function section(name, url, text) {
  return `### ${name}\n\n${url}\n\n\`\`\`\n${text.trim()}\n\`\`\`\n\n`;
}

/** One section per npm package the bundle took code from, with its license (and NOTICE) text. */
function notices(metafile) {
  const dirs = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const m = input.match(/^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//);
    if (m) dirs.add(m[1]);
  }
  return [...dirs].sort().map((dir) => {
    const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
    const files = readdirSync(dir).filter((f) => /^(licen[cs]e|notice)/i.test(f)).sort();
    if (!files.some((f) => /^licen[cs]e/i.test(f))) throw new Error(`no license file in ${dir}`);
    const url = String(pkg.repository?.url ?? pkg.repository ?? pkg.homepage ?? `https://www.npmjs.com/package/${pkg.name}`).replace(/^git\+/, "").replace(/\.git$/, "");
    return section(`${pkg.name} ${pkg.version} (${pkg.license})`, url, files.map((f) => readFileSync(`${dir}/${f}`, "utf8").trim()).join("\n\n"));
  }).join("");
}

