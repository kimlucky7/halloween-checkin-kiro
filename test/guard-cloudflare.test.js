import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { classify } from "../scripts/guard-cloudflare.mjs";

test("remote-capable wrangler commands require confirmation", () => {
  for (const cmd of [
    "npx wrangler deploy",
    "wrangler secret put OWNER_TOKEN",
    "npx wrangler d1 create halloween",
    "npx wrangler d1 execute DB --remote --file x.sql",
    "wrangler r2 bucket create media",
    "wrangler d1 migrations apply DB",
  ]) assert.ok(classify(JSON.stringify({ command: cmd })), cmd);
});

test("local, dry-run and read-only wrangler usage and non-wrangler commands pass", () => {
  for (const cmd of [
    "npx wrangler d1 execute DB --local --file x.sql",
    "npx wrangler deploy --dry-run --outdir /tmp/x",
    "npx wrangler whoami",
    "npm test",
    "git push",
  ]) assert.equal(classify(JSON.stringify({ command: cmd })), null, cmd);
});

test("the script prints an ask decision for a risky command and nothing otherwise", () => {
  const run = (cmd) => spawnSync(process.execPath, ["scripts/guard-cloudflare.mjs"], { input: JSON.stringify({ tool_input: { command: cmd } }), encoding: "utf8" });
  const risky = run("npx wrangler deploy");
  assert.equal(risky.status, 0);
  assert.equal(JSON.parse(risky.stdout).hookSpecificOutput.permissionDecision, "ask");
  assert.equal(run("npm test").stdout, "");
});
