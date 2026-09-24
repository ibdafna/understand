// End-to-end: fixture repo → simulated Claude Code hooks → decisions → extract → narration → render.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, repo, symbolFinder } from "./helpers.mjs";

const GO_CLIENT = `package client

import (
	"fmt"
	"net/http"
)

// Client talks to the upstream API.
type Client struct {
	http    *http.Client
	retries int
}

func (c *Client) Do(req *http.Request) (*http.Response, error) {
	return c.http.Do(req)
}

func (c *Client) logf(format string, args ...any) {
	fmt.Printf("client: "+format, args...)
}
`;

const GO_LEGACY = `package client

import "time"

const legacyDelay = time.Second

func sleepFor(d time.Duration) {
	time.Sleep(d)
}
`;

const TS_FETCH = `import { HttpError } from "./errors";

export class Fetcher {
  base: string;

  constructor(base: string) {
    this.base = base;
  }

  async get(path: string): Promise<unknown> {
    const res = await fetch(this.base + path);
    if (!res.ok) throw new HttpError(res.status);
    return res.json();
  }
}
`;

const PY_UTIL = `import os


def env(name):
    return os.environ[name]


def flag_a():
    return False


def flag_b():
    return False
`;

test("records sessions and explains exactly what the recording supports", () => {
  const t = repo();
  try {
    t.write("client/client.go", GO_CLIENT);
    t.write("client/legacy.go", GO_LEGACY);
    t.write("web/fetch.ts", TS_FETCH);
    t.write("tools/util.py", PY_UTIL);
    t.commit();

    assert.match(t.u("init"), /Recording in/);
    assert.ok(t.read(".git/info/exclude").includes(".understand/"));
    const ctx = JSON.parse(t.hook("session-start"));
    assert.match(ctx.hookSpecificOutput.additionalContext, /understand decide/);

    // Turn 0: several edits, then one decision that explains them.
    t.edit("client/client.go", "\treturn c.http.Do(req)\n}", `\tif req.Method == http.MethodPost {
		return c.http.Do(req)
	}
	for i := 0; i < c.retries; i++ {
		resp, err := c.http.Do(req)
		if err == nil && resp.StatusCode != 503 {
			return resp, nil
		}
		sleepFor(backoff(i))
	}
	return c.http.Do(req)
}`);
    t.edit("client/client.go", '\t"net/http"\n)', '\t"net/http"\n\t"time"\n)');
    t.writeTool("client/retry.go", `package client

import "time"

// backoff doubles the delay each attempt.
func backoff(attempt int) time.Duration {
	return time.Duration(1<<attempt) * 100 * time.Millisecond
}

func sleepFor(d time.Duration) {
	time.Sleep(d)
}
`);
    t.bash("rm client/legacy.go", () => t.sh("rm", ["client/legacy.go"]));
    // A token-level edit (Edit replaces just "False"), which line-text matching used to miss.
    t.edit("tools/util.py", "def flag_a():\n    return False", "def flag_a():\n    return True");
    assert.match(t.u("decide", "--by", "human", "--title", "Never retry POST", "--why", "User said duplicate charges are worse than failures", "--alt", "Idempotency keys: unsupported upstream"), /explains 5 edits/);
    assert.equal(t.hook("stop"), "", "everything is explained, so stop is not blocked");

    // Turn 1: edit first, stop blocks, decision adopts it.
    t.edit("web/fetch.ts", "  async get(path: string): Promise<unknown> {\n    const res = await fetch(this.base + path);", "  async get(path: string, retries = 1): Promise<unknown> {\n    const res = await fetch(this.base + path, { headers: { \"X-Retries\": String(retries) } });");
    const block = JSON.parse(t.hook("stop"));
    assert.equal(block.decision, "block");
    assert.match(block.reason, /web\/fetch\.ts/);
    assert.match(t.u("decide", "--title", "Tell the server how many retries are allowed", "--why", "Server-side retry budget needs the client's intent"), /explains 1 edit/);
    assert.equal(t.hook("stop"), "");

    // Turn 2: an edit the agent never explains (the stop hook already fired once).
    t.edit("client/client.go", 'fmt.Printf("client: "+format', 'fmt.Printf("[client] "+format');
    t.hook("stop", { stop_hook_active: true });

    // A person edits files while no tool runs: one line inside an agent-edited function, and the same
    // text change the agent made in flag_a, in flag_b.
    t.write("client/client.go", t.read("client/client.go").replace("resp.StatusCode != 503", "resp.StatusCode < 500"));
    t.write("tools/util.py", t.read("tools/util.py").replace("def flag_b():\n    return False", "def flag_b():\n    return True"));

    // Turn 3: a claim naming an old unexplained symbol must not explain it; a same-turn claim does.
    t.edit("client/retry.go", "100 * time.Millisecond", "200 * time.Millisecond");
    t.u("decide", "--title", "Slower backoff base", "--why", "Upstream asked for 200ms", "--for", "client/retry.go:backoff", "--for", "client/client.go:Client.logf");

    const x = t.extract();
    const by = symbolFinder(x);
    const listing = t.u("extract");
    assert.equal((listing.match(/UNEXPLAINED/g) ?? []).length, 1, "only Client.logf has an unexplained agent edit");

    const doM = by("client/client.go#method:Client.Do");
    assert.deepEqual(doM.decisions, ["D1"]);
    assert.equal(doM.gaps.outside, true, "the manual line inside Do is not hidden by D1");
    assert.equal(doM.explained, false);
    assert.ok(doM.rows.some((r) => r.t === "+" && r.p === "outside" && r.s.includes("< 500")));
    assert.ok(doM.rows.some((r) => r.t === "+" && r.p !== "outside" && r.s.includes("MethodPost")));

    assert.deepEqual(by("client/client.go#import:time").decisions, ["D1"]);
    assert.equal(by("client/client.go#import:time").explained, true);

    const flagA = by("tools/util.py#func:flag_a"), flagB = by("tools/util.py#func:flag_b");
    assert.equal(flagA.explained, true, "a token-level Edit is attributed");
    assert.equal(flagB.gaps.outside, true, "the same text change made by hand is not credited to the agent");
    assert.deepEqual(flagB.decisions, []);

    const moved = by("client/retry.go#func:sleepFor");
    assert.equal(moved.status, "moved");
    assert.equal(moved.movedFrom, "client/legacy.go");
    assert.deepEqual(moved.decisions, ["D1"]);
    assert.ok(!x.symbols.some((s) => s.id === "client/legacy.go#func:sleepFor"));
    assert.deepEqual(by("client/legacy.go#var:legacyDelay").decisions, ["D1"]);

    const backoff = by("client/retry.go#func:backoff");
    assert.deepEqual([...backoff.decisions].sort(), ["D1", "D3"]);
    assert.equal(backoff.explained, true);

    assert.deepEqual(by("web/fetch.ts#method:Fetcher.get").decisions, ["D2"]);

    const logf = by("client/client.go#method:Client.logf");
    assert.deepEqual(logf.decisions, []);
    assert.equal(logf.gaps.unlinked.length, 1);
    assert.deepEqual(logf.later, ["D3"], "a claim from a later turn is shown but doesn't explain");
    assert.equal(logf.explained, false);

    assert.ok(!x.symbols.some((s) => s.file === "client/client.go" && s.kind === "other"), "import wrapper lines don't produce noise");

    // Narration: a narrator link never clears "unexplained"; invalid narration is refused.
    const narration = {
      title: "Retry idempotent requests",
      intent: "Retry non-POST requests with backoff.",
      chapters: [{ title: "Retry loop", summary: "The loop.", symbols: ["client/client.go#method:Client.Do", "client/client.go#method:Client.logf"] }],
      symbols: {
        "client/client.go#method:Client.Do": { summary: "Retries non-POST requests.", attention: "careful" },
        "client/client.go#method:Client.logf": { summary: "Log prefix.", attention: "mechanical", decisions: ["D2"] },
      },
    };
    writeFileSync(join(t.dir, ".understand/narration.json"), JSON.stringify(narration));
    const chk = t.uFail("check");
    assert.equal(chk.status, 1);
    assert.match(chk.stdout, /not narrated or not in a chapter/);

    const out = t.u("render").trim();
    const html = readFileSync(out, "utf8");
    assert.ok(!html.includes("/*__UNDERSTAND_DATA__*/"));
    const data = JSON.parse(html.match(/const DATA = (.*?);\n/)[1]);
    const logfView = data.symbols.find((s) => s.name === "Client.logf");
    assert.equal(logfView.explained, false);
    assert.deepEqual([...logfView.later].sort(), ["D2", "D3"]);
    assert.match(html, /Not placed in the story/);

    narration.symbols["client/client.go#method:Client.Do"].attention = 'careful"><img src=x onerror=alert(1)>';
    writeFileSync(join(t.dir, ".understand/narration.json"), JSON.stringify(narration));
    const bad = t.uFail("render");
    assert.equal(bad.status, 1, "invalid narration is refused");
    assert.match(bad.stderr, /attention must be/);
  } finally {
    t.cleanup();
  }
});

test("init refuses a symlinked log dir and never touches the real index", () => {
  const t = repo();
  try {
    t.write("a.txt", "a\n");
    t.commit();
    t.write("u.txt", "untracked\n");
    symlinkSync(".git", join(t.dir, ".understand"));
    const r = t.uFail("init");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /symlink/);
    assert.ok(!/^A /m.test(t.sh("git", ["status", "--short"])), "nothing was staged in the real index");
  } finally {
    t.cleanup();
  }
});

test("a failed init --force keeps the existing recording", () => {
  const t = repo();
  try {
    t.write("a.txt", "a\n");
    t.commit();
    t.u("init");
    const r = t.uFail("init", "--force", "--base", "does-not-exist");
    assert.equal(r.status, 1);
    assert.match(t.u("status"), /Recording since/);
  } finally {
    t.cleanup();
  }
});

test("each recording pins its own baseline ref", () => {
  const t = repo();
  try {
    t.write("a.txt", "a\n");
    t.commit();
    t.u("init");
    t.u("init", "--force");
    const refs = t.sh("git", ["for-each-ref", "refs/understand/"]).trim().split("\n");
    assert.equal(refs.length, 2);
    assert.ok(existsSync(join(t.dir, ".understand/archive")));
  } finally {
    t.cleanup();
  }
});

test("flags are parsed strictly", () => {
  const t = repo();
  try {
    t.write("a.txt", "a\n");
    t.commit();
    t.u("init");
    assert.match(t.uFail("init", "--force=false").stderr, /takes no value/);
    assert.match(t.uFail("decide", "--title", "X", "--why=").stderr, /--why is required/);
    assert.match(t.uFail("decide", "--title", "X", "--why", "--looks-like-a-flag").stdout, /D1 recorded/);
    assert.match(t.uFail("decide", "--bogus", "x").stderr, /unknown option/);
  } finally {
    t.cleanup();
  }
});

test("concurrent decisions get distinct ids", async () => {
  const t = repo();
  try {
    t.write("a.txt", "a\n");
    t.commit();
    t.u("init");
    await Promise.all(Array.from({ length: 6 }, (_, i) => new Promise((res) => {
      spawn(CLI, ["decide", "--title", `T${i}`, "--why", "w"], { cwd: t.dir, stdio: "ignore" }).on("exit", res);
    })));
    const ids = readFileSync(join(t.dir, ".understand/decisions.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).id);
    assert.equal(new Set(ids).size, 6, ids.join(","));
  } finally {
    t.cleanup();
  }
});
