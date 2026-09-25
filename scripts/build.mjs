// Bundles the CLI and the viewer into dist/ with everything they need at runtime, so the plugin
// works without `npm install`.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";

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

// The viewer: @pierre/diffs renders the diffs, trimmed to our five languages and one theme pair,
// highlighting with Shiki's JavaScript regex engine (no WebAssembly), all inlined into one page.
const THEMES = new Set(["pierre-dark", "pierre-light"]);
const trim = {
  name: "trim",
  setup(b) {
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

// .cjs: the runtime is UMD and must not be treated as ESM under this package's "type": "module".
copyFileSync(WASM + "tree-sitter.js", "dist/wasm/tree-sitter.cjs");
copyFileSync(WASM + "tree-sitter.wasm", "dist/wasm/tree-sitter.wasm");
for (const l of LANGS) {
  copyFileSync(l.grammar, "dist/wasm/" + basename(l.grammar));
  mkdirSync(`dist/languages/${l.id}`, { recursive: true });
  for (const f of readdirSync(`languages/${l.id}`)) copyFileSync(`languages/${l.id}/${f}`, `dist/languages/${l.id}/${f}`);
}

const mit = (holder) => `MIT License\n\nCopyright (c) ${holder}\n\n${readFileSync("LICENSE", "utf8").split("\n").slice(4).join("\n").trim()}\n`;
const treeSitter = [
  ["tree-sitter (runtime, dist/wasm/tree-sitter.*)", "https://github.com/tree-sitter/tree-sitter", "2018 Max Brunsfeld"],
  ["tree-sitter-go", "https://github.com/tree-sitter/tree-sitter-go", "2014 Max Brunsfeld"],
  ["tree-sitter-javascript", "https://github.com/tree-sitter/tree-sitter-javascript", "2014 Max Brunsfeld"],
  ["tree-sitter-typescript (typescript, tsx)", "https://github.com/tree-sitter/tree-sitter-typescript", "2017 Max Brunsfeld"],
  ["tree-sitter-python", "https://github.com/tree-sitter/tree-sitter-python", "2016 Max Brunsfeld"],
];
writeFileSync("dist/THIRD_PARTY_NOTICES.md", "# Third-party notices\n\nThe built plugin in this folder includes the following software.\n\n" +
  "## Bundled into dist/understand.mjs\n\n" + notices(cli.metafile) +
  "\n## Bundled into dist/viewer.html (and every page rendered from it)\n\n" + viewerNotices + "\n" +
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

