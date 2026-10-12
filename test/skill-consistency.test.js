import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

const skill = readFileSync(new URL("../.agents/skills/halloween-checkin/SKILL.md", import.meta.url), "utf8");
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const root = new URL("../", import.meta.url);

test("every npm script and CLI subcommand named by the skill exists", () => {
  for (const script of skill.match(/npm run ([a-z:]+)/g).map((m) => m.replace("npm run ", ""))) {
    assert.ok(pkg.scripts[script], `package.json has no script '${script}'`);
  }
  const cli = readFileSync(new URL("scripts/hc.mjs", root), "utf8");
  for (const sub of ["review", "submit", "approve", "publish", "status"]) {
    assert.match(skill, new RegExp(`hc -- ${sub}`));
    assert.match(cli, new RegExp(`case "${sub}"`));
  }
});

test("skill references exist and the skill never asks for or prints the token", () => {
  assert.ok(existsSync(new URL(".agents/skills/halloween-checkin/references/prompts.md", root)));
  assert.match(skill, /Never ask for the token in chat/);
  assert.doesNotMatch(skill, /HC_TOKEN=\S+/);
});

test("skill states the publication boundary and the attestation limit", () => {
  assert.match(skill, /Then \*\*stop\*\*/);
  assert.match(skill, /trusted-agent-attestation/);
  assert.match(skill, /two generation attempts per stage/);
});
