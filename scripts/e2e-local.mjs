#!/usr/bin/env node
// End-to-end check against the real Workers runtime (workerd) in LOCAL mode.
// D1 and R2 are simulated on disk in a temp directory; nothing is sent to Cloudflare.
// Uses synthetic images only. Requires `npm run build` first (serves ./dist).
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { unstable_dev } from "wrangler";

import { createClient } from "../pipeline/client.js";
import { syntheticRaw } from "../pipeline/synthetic.js";
import { preparePair } from "../pipeline/prepare.js";
import { approveReviewed, prepareReview, publishApproved, submitForReview } from "../pipeline/workflow.js";

process.env.WRANGLER_SEND_METRICS = "false";
const TOKEN = "e2e-local-token-not-a-secret-0001";
const tmp = await mkdtemp(path.join(os.tmpdir(), "hc-e2e-"));
const persist = path.join(tmp, "state");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

let worker;
try {
  const migrate = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc", "--persist-to", persist, "--file", "migrations/0002_halloween_checkin.sql"],
    { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
  );
  check("local D1 migration applies", migrate.status === 0, migrate.status === 0 ? "" : (migrate.stderr || migrate.stdout).slice(-300));
  if (migrate.status !== 0) throw new Error("migration failed");

  worker = await unstable_dev("worker/halloween/index.js", {
    config: "wrangler.local.jsonc",
    local: true,
    persistTo: persist,
    vars: { OWNER_TOKEN: TOKEN, PROJECT_ID: "halloween-checkin-local" },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    logLevel: "error",
  });
  const base = `http://${worker.address}:${worker.port}`;

  const page = await worker.fetch("/");
  const html = await page.text();
  check("static site is served", page.status === 200 && html.includes("Halloween Check-in") && html.includes("data-stage"));
  check("anonymous write is rejected", (await worker.fetch("/api/revisions", { method: "POST", body: "{}" })).status === 401);
  const empty = await (await worker.fetch("/api/checkins")).json();
  check("public list starts empty", Array.isArray(empty.checkins) && empty.checkins.length === 0);

  const client = createClient({ baseUrl: base, token: TOKEN });
  const published = [];
  for (const theme of ["normal", "halloween"]) {
    const dir = path.join(tmp, theme);
    // Raw "generator output" on a magenta backdrop, prepared exactly as the skill does.
    const pair = await preparePair({ day: await syntheticRaw({ lighting: "day", theme }), night: await syntheticRaw({ lighting: "night", theme }) });
    await writeFile(path.join(tmp, `${theme}-day.png`), pair.day);
    await writeFile(path.join(tmp, `${theme}-night.png`), pair.night);
    const link = published[0]?.checkinId;
    const prep = await prepareReview({
      dayPath: path.join(tmp, `${theme}-day.png`), nightPath: path.join(tmp, `${theme}-night.png`), outDir: dir,
      meta: { theme, text: "at the synthetic cafe", place: { name: "Synthetic Cafe (demo)" }, capturedAt: null, capturedAtSource: null, companions: [],
        differences: theme === "halloween" ? ["pumpkin added (creative decoration)"] : ["synthetic demo building"], ...(link ? { linkCheckinId: link } : {}) },
    });
    check(`${theme}: pair validates`, prep.ok);
    const review = await submitForReview({ client, dir });
    check(`${theme}: review package is ready and nothing is public yet`, review.state === "review_ready" && (await client.listPublic()).filter((c) => c.variants.some((v) => v.theme === theme)).length === 0);
    await approveReviewed({ client, dir });
    const { result, verification } = await publishApproved({ client, dir });
    check(`${theme}: published and public media verified`, result.state === "published" && verification.ok, verification.problems.join("; "));
    const replay = await publishApproved({ client, dir });
    check(`${theme}: repeated publish is a replay`, replay.result.replay === true && replay.result.checkinId === result.checkinId);
    published.push(result);
  }
  const list = await client.listPublic();
  check("one check-in with two independent editions", list.length === 1 && list[0].variants.length === 2, JSON.stringify(list.map((c) => c.variants.map((v) => v.theme))));
  const leaked = JSON.stringify(list);
  check("public projection has no private fields", !/owner|media\/|payloadHash|validator|approval/i.test(leaked.replace(/\/media\//g, "")));
} catch (error) {
  check("e2e run completed", false, error.message);
} finally {
  await worker?.stop();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
