// Deterministic validation for a final day/night miniature pair.
//
// These checks find mechanical problems. They do not prove the sign, doors or
// structure are faithful: visual review stays a separate, human/agent step and
// is recorded as such in the review package (see review.js).
import sharp from "sharp";
import { sha256Hex } from "../worker/halloween/domain/canonical.js";
// Same container check the Worker applies (CRC of every chunk, full IDAT inflate).
import { checkFinalPng, PngError } from "../worker/halloween/png.js";

export const VALIDATOR_VERSION = "pair-validator/1";
export const CANVAS = 720;
export const BASELINE_Y = 651;
export const MAX_SUBJECT_RATIO = 0.92;
export const MIN_SUBJECT_RATIO = 0.4;
export const MAX_BYTES = 4 * 1024 * 1024;
const MAX_INPUT_PIXELS = 16_000_000; // decode guard before dimension checks
const ALPHA_VISIBLE = 16;
const CENTER_TOLERANCE = 12;
const BASELINE_TOLERANCE = 6;
const PAIR_BOUNDS_TOLERANCE = 4;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function isPngMagic(bytes) {
  return bytes.length > 8 && PNG_MAGIC.every((v, i) => bytes[i] === v);
}

async function inspectImage(bytes) {
  const checks = [];
  const add = (name, passed, detail = "") => checks.push({ name, passed, detail });

  add("size_limit", bytes.length > 0 && bytes.length <= MAX_BYTES, `${bytes.length} bytes`);
  add("png_signature", isPngMagic(bytes), "file content, not extension");
  if (!checks.every((c) => c.passed)) return { checks, bounds: null };

  try {
    checkFinalPng(bytes);
    add("png_container", true, "chunk CRCs and IDAT stream verified");
  } catch (error) {
    // Size and colour-format failures are reported by the dedicated checks
    // below, so only structural problems stop here.
    if (!(error instanceof PngError) || !["bad_size", "bad_format"].includes(error.code)) {
      add("png_container", false, String(error.message).slice(0, 120));
      return { checks, bounds: null };
    }
  }

  let meta;
  let raw;
  try {
    const img = sharp(bytes, { limitInputPixels: MAX_INPUT_PIXELS, failOn: "error" });
    meta = await img.metadata();
    add("decodable", meta.format === "png", `format=${meta.format}`);
    if (meta.format !== "png") return { checks, bounds: null };
    raw = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  } catch (error) {
    add("decodable", false, String(error.message).slice(0, 120));
    return { checks, bounds: null };
  }

  add("dimensions", meta.width === CANVAS && meta.height === CANVAS, `${meta.width}x${meta.height}`);
  add("has_alpha_channel", meta.channels === 4 && meta.hasAlpha === true, `channels=${meta.channels}`);
  if (!(meta.width === CANVAS && meta.height === CANVAS)) return { checks, bounds: null };

  const { data } = raw;
  let minX = CANVAS, minY = CANVAS, maxX = -1, maxY = -1;
  let transparent = 0;
  for (let y = 0; y < CANVAS; y++) {
    for (let x = 0; x < CANVAS; x++) {
      const a = data[(y * CANVAS + x) * 4 + 3];
      if (a === 0) transparent++;
      if (a > ALPHA_VISIBLE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const corners = [0, CANVAS - 1].flatMap((y) =>
    [0, CANVAS - 1].map((x) => data[(y * CANVAS + x) * 4 + 3]),
  );
  const fraction = transparent / (CANVAS * CANVAS);
  add(
    "real_transparency",
    corners.every((a) => a === 0) && fraction > 0.2 && fraction < 0.98,
    `transparent=${(fraction * 100).toFixed(1)}% corners=${corners.join(",")}`,
  );
  if (maxX < 0) {
    add("subject_present", false, "no visible pixels");
    return { checks, bounds: null };
  }

  const bounds = { minX, minY, maxX, maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
  const centerOffset = Math.abs((minX + maxX) / 2 - (CANVAS - 1) / 2);
  add("horizontally_centered", centerOffset <= CENTER_TOLERANCE, `offset=${centerOffset.toFixed(1)}px`);
  add(
    "grounded_on_baseline",
    Math.abs(maxY + 1 - BASELINE_Y) <= BASELINE_TOLERANCE,
    `bottom=${maxY + 1} expected≈${BASELINE_Y}`,
  );
  const ratio = Math.max(bounds.width, bounds.height) / CANVAS;
  add(
    "subject_size",
    ratio <= MAX_SUBJECT_RATIO && ratio >= MIN_SUBJECT_RATIO,
    `max side ${(ratio * 100).toFixed(1)}% of canvas`,
  );

  // Preview contamination: magenta substrate leaking into small sizes.
  const previewChecks = [];
  for (const size of [360, 240]) {
    const small = await sharp(bytes).resize(size, size, { kernel: "lanczos3" }).ensureAlpha().raw().toBuffer();
    let visible = 0, magenta = 0;
    for (let i = 0; i < small.length; i += 4) {
      if (small[i + 3] > 128) {
        visible++;
        if (small[i] > 200 && small[i + 1] < 90 && small[i + 2] > 200) magenta++;
      }
    }
    previewChecks.push({ size, magentaFraction: visible ? magenta / visible : 0 });
  }
  add(
    "preview_clean",
    previewChecks.every((p) => p.magentaFraction < 0.001),
    previewChecks.map((p) => `${p.size}px magenta=${(p.magentaFraction * 100).toFixed(2)}%`).join(" "),
  );
  return { checks, bounds };
}

/**
 * @param {{ day: Uint8Array, night: Uint8Array }} pair
 */
export async function validatePair(pair) {
  const report = { version: VALIDATOR_VERSION, passed: false, images: {}, pair: [], visualReview: "not_performed" };
  const results = {};
  for (const slot of ["day", "night"]) {
    const bytes = pair?.[slot];
    if (!(bytes instanceof Uint8Array)) {
      report.pair.push({ name: `${slot}_present`, passed: false, detail: "missing" });
      continue;
    }
    const inspected = await inspectImage(bytes);
    results[slot] = inspected;
    report.images[slot] = {
      sha256: await sha256Hex(bytes),
      bytes: bytes.length,
      checks: inspected.checks,
      bounds: inspected.bounds,
    };
  }
  if (results.day?.bounds && results.night?.bounds) {
    const a = results.day.bounds, b = results.night.bounds;
    const diff = Math.max(
      Math.abs(a.minX - b.minX), Math.abs(a.maxX - b.maxX),
      Math.abs(a.minY - b.minY), Math.abs(a.maxY - b.maxY),
    );
    report.pair.push({
      name: "shared_frame",
      passed: diff <= PAIR_BOUNDS_TOLERANCE,
      detail: `max bounds difference ${diff}px`,
    });
  } else if (results.day && results.night) {
    report.pair.push({ name: "shared_frame", passed: false, detail: "bounds unavailable" });
  }
  const allChecks = [
    ...Object.values(report.images).flatMap((i) => i.checks),
    ...report.pair,
  ];
  report.passed =
    allChecks.length > 0 &&
    allChecks.every((c) => c.passed) &&
    Boolean(report.images.day) &&
    Boolean(report.images.night);
  return report;
}

export async function makePreviews(bytes) {
  const out = {};
  for (const size of [360, 240]) {
    out[size] = await sharp(bytes).resize(size, size, { kernel: "lanczos3" }).png().toBuffer();
  }
  return out;
}
