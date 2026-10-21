import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { TOOLS } from "../worker/halloween/mcp.js";

const skill = readFileSync(new URL("../chatgpt-skill/halloween-checkin/SKILL.md", import.meta.url), "utf8");
const script = readFileSync(new URL("../chatgpt-skill/halloween-checkin/scripts/prepare.py", import.meta.url), "utf8");

test("the ChatGPT skill names only tools the MCP server provides, and every required argument", () => {
  const names = TOOLS.map((t) => t.name);
  for (const used of skill.match(/`(submit_checkin_for_review|publish_checkin|get_checkin_status|list_checkins|[a-z]+_checkin[a-z_]*)`/g).filter((m) => !/link_/.test(m)).map((m) => m.slice(1, -1))) {
    assert.ok(names.includes(used), `skill mentions unknown tool ${used}`);
  }
  const submit = TOOLS.find((t) => t.name === "submit_checkin_for_review");
  for (const field of ["link_revision_id", "link_checkin_id", "validator_version", "differences"]) {
    assert.ok(field in submit.inputSchema.properties, field);
    assert.match(skill, new RegExp(field));
  }
});

test("the skill's prompt files exist and night prompts never take the photo", () => {
  const day = readFileSync(new URL("../chatgpt-skill/halloween-checkin/references/day-prompt.md", import.meta.url), "utf8");
  const night = readFileSync(new URL("../chatgpt-skill/halloween-checkin/references/night-prompt.md", import.meta.url), "utf8");
  assert.match(skill, /references\/day-prompt\.md/);
  assert.match(skill, /references\/night-prompt\.md/);
  assert.match(day, /#FF00FF/);
  assert.match(night, /never the original\s+photo/);
  for (const text of [day, night]) assert.ok(!/check-in card|打卡卡片/.test(text));
});

test("the Halloween edition is an edit of the normal day and shares one transform with it", () => {
  const day = readFileSync(new URL("../chatgpt-skill/halloween-checkin/references/day-prompt.md", import.meta.url), "utf8");
  const halloween = day.slice(day.indexOf("## halloween-day"));
  assert.match(halloween, /Image input: the accepted normal-day image only/);
  assert.match(halloween, /do not redraw or widen the building/);
  assert.match(skill, /--halloween-day halloween-day\.png --halloween-night halloween-night\.png/);
  assert.match(script, /--halloween-day/);
  assert.match(script, /halloween_redrawn/);
});

test("the skill keeps the publication boundary and the prepare script keeps the site's geometry", () => {
  assert.match(skill, /stop and wait/i);
  assert.match(skill, /normal\*\* revision first/);
  assert.match(script, /CANVAS, BASELINE, TOP_MARGIN = 720, 651, 28/);
  assert.match(script, /sys\.exit\(2\)/);
  assert.ok(!/requests|urllib|http\.client|socket/.test(script), "the sandbox script must not use the network");
});
