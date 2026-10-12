import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { createApp, TOKEN } from "../testkit/harness.js";
import { createClient } from "../pipeline/client.js";
import { syntheticPair } from "../pipeline/synthetic.js";
import { approveReviewed, prepareReview, publishApproved, renderReviewMarkdown, submitForReview } from "../pipeline/workflow.js";

async function workspace(t, theme = "normal") {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hc-flow-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const pair = await syntheticPair({ theme });
  await writeFile(path.join(dir, "in-day.png"), pair.day);
  await writeFile(path.join(dir, "in-night.png"), pair.night);
  return { dir, pair };
}

const clientFor = (app) => createClient({ baseUrl: "https://test.invalid", token: TOKEN, fetchImpl: app.fetch });

test("full skill workflow: review → submit → (stop) → approve → publish → verified", async (t) => {
  const app = createApp();
  const { dir } = await workspace(t);
  const out = path.join(dir, "ws");
  const prep = await prepareReview({
    dayPath: path.join(dir, "in-day.png"), nightPath: path.join(dir, "in-night.png"), outDir: out,
    meta: { theme: "normal", text: "at the synthetic cafe", place: { name: "Synthetic Cafe" }, capturedAt: null, capturedAtSource: null, companions: [], differences: ["synthetic demo building"] },
  });
  assert.equal(prep.ok, true);
  for (const f of ["day.png", "night.png", "preview-day-360.png", "preview-night-240.png", "report.json", "submission.json"]) {
    await assert.doesNotReject(readFile(path.join(out, f)));
  }

  const client = clientFor(app);
  const review = await submitForReview({ client, dir: out });
  assert.equal(review.state, "review_ready");
  assert.equal((await app.call("GET", "/api/checkins", { auth: null })).data.checkins.length, 0, "submitting for review publishes nothing");
  const md = renderReviewMarkdown(review, prep.report);
  assert.match(md, /Payload hash/);
  assert.match(md, /Captured: unknown/);
  assert.match(md, /not_performed/);

  await approveReviewed({ client, dir: out });
  const { result, verification } = await publishApproved({ client, dir: out });
  assert.equal(result.state, "published");
  assert.deepEqual(verification.problems, []);
  assert.equal(verification.ok, true);

  // a retry after a crash reuses the persisted idempotency key
  const state = JSON.parse(await readFile(path.join(out, "state.json"), "utf8"));
  assert.match(state.idempotencyKey, /^hc-/);
  const again = await publishApproved({ client, dir: out });
  assert.equal(again.result.replay, true);
  assert.equal(app.db.sqlite.prepare("SELECT COUNT(*) AS n FROM hc_checkins").get().n, 1);
});

test("prepare refuses a pair that fails validation and writes no submission", async (t) => {
  const { dir, pair } = await workspace(t);
  await writeFile(path.join(dir, "in-day.png"), new TextEncoder().encode("not an image"));
  const out = path.join(dir, "ws");
  const prep = await prepareReview({ dayPath: path.join(dir, "in-day.png"), nightPath: path.join(dir, "in-night.png"), outDir: out, meta: { text: "x" } });
  assert.equal(prep.ok, false);
  await assert.rejects(readFile(path.join(out, "submission.json")));
  void pair;
});

test("submit detects images changed after validation", async (t) => {
  const app = createApp();
  const { dir, pair } = await workspace(t);
  const out = path.join(dir, "ws");
  await prepareReview({ dayPath: path.join(dir, "in-day.png"), nightPath: path.join(dir, "in-night.png"), outDir: out, meta: { text: "at x" } });
  await writeFile(path.join(out, "day.png"), pair.night); // swapped after review
  await assert.rejects(submitForReview({ client: clientFor(app), dir: out }), /changed after validation/);
});

test("approve and publish refuse to run out of order", async (t) => {
  const app = createApp();
  const { dir } = await workspace(t);
  const out = path.join(dir, "ws");
  await prepareReview({ dayPath: path.join(dir, "in-day.png"), nightPath: path.join(dir, "in-night.png"), outDir: out, meta: { text: "at x" } });
  const client = clientFor(app);
  await assert.rejects(approveReviewed({ client, dir: out }), /cannot approve/);
  await assert.rejects(publishApproved({ client, dir: out }), /cannot publish/);
  await submitForReview({ client, dir: out });
  await assert.rejects(publishApproved({ client, dir: out }), /cannot publish/, "no publish without approval step");
});

test("client refuses to run without configuration and never echoes the token", () => {
  assert.throws(() => createClient({ baseUrl: "", token: "x" }), /HC_API_URL/);
  assert.throws(() => createClient({ baseUrl: "https://x", token: "" }), /HC_TOKEN/);
});

test("cli review reports validation failures with a non-zero exit code", async (t) => {
  const { dir } = await workspace(t);
  await writeFile(path.join(dir, "bad.png"), "nope");
  const run = spawnSync(process.execPath, ["scripts/hc.mjs", "review", "--day", path.join(dir, "bad.png"), "--night", path.join(dir, "in-night.png"), "--text", "at x", "--out", path.join(dir, "o")], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /Validation FAILED/);
});

test("cli review succeeds on a valid pair and submit refuses without credentials", async (t) => {
  const { dir } = await workspace(t);
  const out = path.join(dir, "o");
  const ok = spawnSync(process.execPath, ["scripts/hc.mjs", "review", "--day", path.join(dir, "in-day.png"), "--night", path.join(dir, "in-night.png"), "--text", "at x", "--theme", "halloween", "--difference", "pumpkin added", "--out", out], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stderr);
  const sub = JSON.parse(await readFile(path.join(out, "submission.json"), "utf8"));
  assert.equal(sub.theme, "halloween");
  assert.deepEqual(sub.differences, ["pumpkin added"]);
  const env = { ...process.env };
  delete env.HC_API_URL; delete env.HC_TOKEN;
  const noCreds = spawnSync(process.execPath, ["scripts/hc.mjs", "submit", "--dir", out], { encoding: "utf8", env });
  assert.equal(noCreds.status, 1);
  assert.match(noCreds.stderr, /HC_API_URL/);
});
