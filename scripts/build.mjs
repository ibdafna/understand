// Bundles the CLI into dist/ with everything it needs at runtime, so the plugin works without `npm install`.
import { build } from "esbuild";
import { copyFileSync, mkdirSync, rmSync } from "node:fs";

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
console.log("built dist/");
