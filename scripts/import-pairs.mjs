#!/usr/bin/env node
// Import finished day/night pairs the owner already has (for example from an
// earlier site) through the normal review → approve → publish path.
//
//   node scripts/import-pairs.mjs --manifest <file.json> --work <dir> [--publish yes]
//
// Manifest: [{ "key": "unique-name", "day": "<file>", "night": "<file>",
//              "text": "at …", "place": { "name": …, "address": … } | null,
//              "capturedAt": "<ISO>" | null, "capturedAtSource": "exif|user|checkin" | null,
//              "companions": [], "theme": "normal" }]
//
// Images are converted to PNG without resampling. If a pair fails only because it
// is off-centre or off the baseline, both images are moved by the same whole-pixel
// offset (no scaling) and checked again. Anything else is reported and skipped.
// Without `--publish yes` it stops after submitting each package for review.
// Each pair has its own workspace under --work, so re-running resumes safely with
// the same idempotency keys.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import sharp from "sharp";

import { createClient } from "../pipeline/client.js";
import { validatePair } from "../pipeline/validate.js";
import { approveReviewed, prepareReview, publishApproved, submitForReview } from "../pipeline/workflow.js";

const CANVAS = 720;
const BASELINE = 651;
const MOVABLE = new Set(["horizontally_centered", "grounded_on_baseline"]);

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, v, i, all) => (i % 2 ? pairs : [...pairs, [v.replace(/^--/, ""), all[i + 1]]]), []),
);
if (!args.manifest || !args.work) {
  console.error("usage: import-pairs.mjs --manifest <file> --work <dir> [--publish yes]");
  process.exit(1);
}

const failures = (report) =>
  [...Object.values(report.images).flatMap((i) => i.checks), ...report.pair].filter((c) => !c.passed);

async function toPng(file) {
  return sharp(await readFile(file)).ensureAlpha().png({ compressionLevel: 9, palette: false }).toBuffer();
}

async function shift(pair, report) {
  const a = report.images.day.bounds;
  const b = report.images.night.bounds;
  const box = { minX: Math.min(a.minX, b.minX), maxX: Math.max(a.maxX, b.maxX), minY: Math.min(a.minY, b.minY), maxY: Math.max(a.maxY, b.maxY) };
  const dx = Math.round((CANVAS - 1) / 2 - (box.minX + box.maxX) / 2);
  const dy = BASELINE - (box.maxY + 1);
  if (box.minX + dx < 0 || box.maxX + dx >= CANVAS || box.minY + dy < 0 || box.maxY + dy >= CANVAS) return null;
  const move = async (png) => {
    const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const out = Buffer.alloc(data.length);
    for (let y = 0; y < CANVAS; y++) {
      const ty = y + dy;
      if (ty < 0 || ty >= CANVAS) continue;
      for (let x = 0; x < CANVAS; x++) {
        const tx = x + dx;
        if (tx < 0 || tx >= CANVAS) continue;
        data.copy(out, (ty * CANVAS + tx) * 4, (y * CANVAS + x) * 4, (y * CANVAS + x) * 4 + 4);
      }
    }
    return sharp(out, { raw: { width: CANVAS, height: CANVAS, channels: 4 } }).png({ compressionLevel: 9, palette: false }).toBuffer();
  };
  return { day: await move(pair.day), night: await move(pair.night), dx, dy };
}

const manifest = JSON.parse(await readFile(args.manifest, "utf8"));
const client = createClient({ baseUrl: process.env.HC_API_URL, token: process.env.HC_TOKEN });
const summary = [];

for (const entry of manifest) {
  const dir = path.join(args.work, entry.key);
  await mkdir(dir, { recursive: true });
  try {
    let pair = { day: await toPng(entry.day), night: await toPng(entry.night) };
    let report = await validatePair({ day: new Uint8Array(pair.day), night: new Uint8Array(pair.night) });
    let note = "unchanged pixels";
    if (!report.passed && failures(report).every((c) => MOVABLE.has(c.name))) {
      const moved = await shift(pair, report);
      if (moved) {
        pair = moved;
        report = await validatePair({ day: new Uint8Array(pair.day), night: new Uint8Array(pair.night) });
        note = `moved by (${moved.dx}, ${moved.dy}) px, no scaling`;
      }
    }
    if (!report.passed) throw new Error("validation: " + failures(report).map((c) => `${c.name} (${c.detail})`).join("; "));

    await writeFile(path.join(dir, "in-day.png"), pair.day);
    await writeFile(path.join(dir, "in-night.png"), pair.night);
    const ws = path.join(dir, "ws");
    let state = {};
    try { state = JSON.parse(await readFile(path.join(ws, "state.json"), "utf8")); } catch { /* new */ }
    if (!state.step) {
      const prep = await prepareReview({
        dayPath: path.join(dir, "in-day.png"),
        nightPath: path.join(dir, "in-night.png"),
        outDir: ws,
        meta: {
          theme: entry.theme ?? "normal",
          text: entry.text,
          place: entry.place ?? null,
          capturedAt: entry.capturedAt ?? null,
          capturedAtSource: entry.capturedAt ? entry.capturedAtSource : null,
          companions: entry.companions ?? [],
          differences: entry.differences ?? [],
        },
      });
      if (!prep.ok) throw new Error("prepareReview failed");
    }
    if (!state.step || state.step === "prepared") await submitForReview({ client, dir: ws });
    if (args.publish !== "yes") {
      summary.push({ key: entry.key, result: "submitted for review", note });
      continue;
    }
    state = JSON.parse(await readFile(path.join(ws, "state.json"), "utf8"));
    if (state.step === "review_ready") await approveReviewed({ client, dir: ws });
    const { result, verification } = await publishApproved({ client, dir: ws });
    summary.push({ key: entry.key, result: result.state, checkinId: result.checkinId, replay: result.replay, verified: verification.ok, problems: verification.problems, note });
  } catch (error) {
    summary.push({ key: entry.key, result: "skipped", error: error.message });
  }
}
console.log(JSON.stringify(summary, null, 2));
process.exitCode = summary.some((s) => s.result === "skipped" || s.verified === false) ? 2 : 0;
