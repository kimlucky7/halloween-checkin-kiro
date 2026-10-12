#!/usr/bin/env node
// npm run prepare -- --day <raw-day.png> --night <raw-night.png> --out-dir <dir>
// Writes day.png, night.png (720×720 RGBA) and prepare-report.json.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { preparePair, PrepareError } from "../pipeline/prepare.js";

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i]?.startsWith("--") || argv[i + 1] === undefined) throw new Error(`bad argument near '${argv[i] ?? ""}'`);
    out[argv[i].slice(2)] = argv[i + 1];
  }
  for (const k of ["day", "night", "out-dir"]) if (!out[k]) throw new Error(`--${k} is required`);
  return out;
}

try {
  const a = args(process.argv.slice(2));
  const [day, night] = await Promise.all([readFile(a.day), readFile(a.night)]);
  const result = await preparePair({ day, night });
  await mkdir(a["out-dir"], { recursive: true });
  await writeFile(path.join(a["out-dir"], "day.png"), result.day);
  await writeFile(path.join(a["out-dir"], "night.png"), result.night);
  await writeFile(path.join(a["out-dir"], "prepare-report.json"), JSON.stringify(result.report, null, 2));
  console.log(`Prepared ${a["out-dir"]}/day.png and night.png (${result.report.slots.day.method}, scale ${result.report.transform.scale}).`);
} catch (error) {
  console.error(error instanceof PrepareError ? `Preparation failed (${error.code}): ${error.message}` : error.message);
  process.exitCode = error instanceof PrepareError ? 2 : 1;
}
