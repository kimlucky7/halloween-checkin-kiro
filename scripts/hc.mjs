#!/usr/bin/env node
// Halloween Check-in CLI used by the skill.
//   hc review  --day D --night N --text T [--theme normal|halloween] [--place-name X]
//              [--captured-at ISO --captured-at-source exif|user] [--companion X]...
//              [--difference X]... [--link CHECKIN_ID] --out DIR     (offline validation)
//   hc submit  --dir DIR      register + upload; prints the review package
//   hc approve --dir DIR      ONLY after the user clearly asked to publish this package
//   hc publish --dir DIR      publish with a persisted idempotency key, then verify
//   hc status  --dir DIR
// Environment: HC_API_URL, HC_TOKEN (never printed).
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { createClient } from "../pipeline/client.js";
import { approveReviewed, prepareReview, publishApproved, renderReviewMarkdown, submitForReview } from "../pipeline/workflow.js";

function parse(argv) {
  const [command, ...rest] = argv;
  const opts = { companion: [], difference: [] };
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag?.startsWith("--") || value === undefined) throw new Error(`bad argument near '${flag ?? ""}'`);
    const key = flag.slice(2);
    if (Array.isArray(opts[key])) opts[key].push(value);
    else opts[key] = value;
  }
  return { command, opts };
}

function need(opts, ...keys) {
  for (const k of keys) if (!opts[k]) throw new Error(`--${k} is required`);
}

const client = () => createClient({ baseUrl: process.env.HC_API_URL, token: process.env.HC_TOKEN });

async function main() {
  const { command, opts } = parse(process.argv.slice(2));
  switch (command) {
    case "review": {
      need(opts, "day", "night", "text", "out");
      const meta = {
        theme: opts.theme ?? "normal",
        text: opts.text,
        place: opts["place-name"] || opts["place-address"] ? { name: opts["place-name"] ?? null, address: opts["place-address"] ?? null } : null,
        capturedAt: opts["captured-at"] ?? null,
        capturedAtSource: opts["captured-at-source"] ?? null,
        companions: opts.companion,
        differences: opts.difference,
        ...(opts.link ? { linkCheckinId: opts.link } : {}),
      };
      const result = await prepareReview({ dayPath: opts.day, nightPath: opts.night, meta, outDir: opts.out });
      if (!result.ok) {
        console.error("Validation FAILED. Do not submit.");
        for (const c of [...Object.values(result.report.images).flatMap((i) => i.checks), ...result.report.pair].filter((c) => !c.passed)) {
          console.error(`- ${c.name}: ${c.detail}`);
        }
        process.exitCode = 2;
        return;
      }
      console.log(`Validation passed (${result.report.version}). Visual review is still required.\nWorkspace: ${opts.out}`);
      return;
    }
    case "submit": {
      need(opts, "dir");
      const review = await submitForReview({ client: client(), dir: opts.dir });
      const report = JSON.parse(await readFile(path.join(opts.dir, "report.json"), "utf8"));
      const md = renderReviewMarkdown(review, report);
      await writeFile(path.join(opts.dir, "review.md"), md);
      console.log(md);
      console.log(`\nrevisionId: ${review.revisionId}\nstate: ${review.state}\nNOTHING IS PUBLISHED. Show this package and the images, then stop.`);
      return;
    }
    case "approve": {
      need(opts, "dir");
      const a = await approveReviewed({ client: client(), dir: opts.dir });
      console.log(`Approved (trust level: ${a.trustLevel}); expires ${a.expiresAt}.`);
      return;
    }
    case "publish": {
      need(opts, "dir");
      const { result, verification } = await publishApproved({ client: client(), dir: opts.dir });
      console.log(JSON.stringify({ operationId: result.operationId, state: result.state, checkinId: result.checkinId, replay: result.replay, verification }, null, 2));
      if (!verification.ok) process.exitCode = 3;
      return;
    }
    case "status": {
      need(opts, "dir");
      console.log(await readFile(path.join(opts.dir, "state.json"), "utf8"));
      return;
    }
    default:
      throw new Error("usage: hc <review|submit|approve|publish|status> ...");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
