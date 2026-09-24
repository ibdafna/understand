// Bundles the CLI into dist/ with everything it needs at runtime, so the plugin works without `npm install`.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

const WASM = "node_modules/@vscode/tree-sitter-wasm/wasm/";
const GRAMMARS = ["go", "typescript", "tsx", "javascript", "python"];

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/wasm", { recursive: true });

await build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/understand.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  legalComments: "none",
});

// .cjs: the runtime is UMD and must not be treated as ESM under this package's "type": "module".
copyFileSync(WASM + "tree-sitter.js", "dist/wasm/tree-sitter.cjs");
for (const f of ["tree-sitter.wasm", ...GRAMMARS.map((g) => `tree-sitter-${g}.wasm`)]) copyFileSync(WASM + f, "dist/wasm/" + f);
copyFileSync("viewer/viewer.html", "dist/viewer.html");

// dist/ ships other people's code; their licenses require keeping these notices with it.
const mit = (holder) => `MIT License\n\nCopyright (c) ${holder}\n\n${readFileSync("LICENSE", "utf8").split("\n").slice(4).join("\n").trim()}\n`;
const treeSitter = [
  ["tree-sitter (runtime, dist/wasm/tree-sitter.*)", "https://github.com/tree-sitter/tree-sitter", "2018 Max Brunsfeld"],
  ["tree-sitter-go", "https://github.com/tree-sitter/tree-sitter-go", "2014 Max Brunsfeld"],
  ["tree-sitter-javascript", "https://github.com/tree-sitter/tree-sitter-javascript", "2014 Max Brunsfeld"],
  ["tree-sitter-typescript (typescript, tsx)", "https://github.com/tree-sitter/tree-sitter-typescript", "2017 Max Brunsfeld"],
  ["tree-sitter-python", "https://github.com/tree-sitter/tree-sitter-python", "2016 Max Brunsfeld"],
];
const sections = [
  ["diff (bundled into dist/understand.mjs)", "https://github.com/kpdecker/jsdiff", readFileSync("node_modules/diff/LICENSE", "utf8")],
  ["@vscode/tree-sitter-wasm (the WebAssembly builds in dist/wasm/)", "https://github.com/microsoft/vscode-tree-sitter-wasm", readFileSync("node_modules/@vscode/tree-sitter-wasm/LICENSE", "utf8")],
  ...treeSitter.map(([name, url, holder]) => [name, url, mit(holder)]),
];
writeFileSync("dist/THIRD_PARTY_NOTICES.md", "# Third-party notices\n\nThe built plugin in this folder includes the following software.\n\n" +
  sections.map(([name, url, text]) => `## ${name}\n\n${url}\n\n\`\`\`\n${text.trim()}\n\`\`\`\n`).join("\n"));
console.log("built dist/");
