// Release: bump the patch version everywhere it lives, build, test, commit, tag, push.
// Plugin managers (Claude Code, Codex) detect updates by version, so every push to main goes through here.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], ...opts }).trim();
const json = (f) => JSON.parse(readFileSync(f, "utf8"));
const save = (f, d) => writeFileSync(f, JSON.stringify(d, null, 2) + "\n");

if (sh("git", ["rev-parse", "--abbrev-ref", "HEAD"]) !== "main") throw new Error("ship from main");
if (sh("git", ["status", "--porcelain"])) throw new Error("commit or stash your changes first");

const plugin = json(".claude-plugin/plugin.json");
const [major, minor, patch] = plugin.version.split(".").map(Number);
const version = `${major}.${minor}.${patch + 1}`;

plugin.version = version;
save(".claude-plugin/plugin.json", plugin);
const market = json(".claude-plugin/marketplace.json");
market.plugins.find((p) => p.name === plugin.name).version = version;
save(".claude-plugin/marketplace.json", market);
const pkg = json("package.json");
pkg.version = version;
save("package.json", pkg);

execFileSync("npm", ["test"], { stdio: "inherit" }); // also rebuilds dist/
sh("git", ["add", "-A"]);
sh("git", ["commit", "-m", `Release v${version}`]);
execFileSync("claude", ["plugin", "tag", "."], { stdio: "inherit" }); // validates manifests, tags understand--v<version>
sh("git", ["push", "--follow-tags", "origin", "main"]);
console.log(`Shipped v${version}.`);
