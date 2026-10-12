import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { chooseScale, preparePair, PrepareError, BASELINE, CANVAS } from "../pipeline/prepare.js";
import { syntheticRaw } from "../pipeline/synthetic.js";
import { validatePair } from "../pipeline/validate.js";

const failed = (report) =>
  [...Object.values(report.images).flatMap((i) => i.checks), ...report.pair].filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);

async function rawPair(options = {}) {
  return {
    day: await syntheticRaw({ lighting: "day", ...options }),
    night: await syntheticRaw({ lighting: "night", ...options }),
  };
}

async function alphaAt(png, x, y) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return data[(y * info.width + x) * 4 + 3];
}

test("a magenta-backdrop pair becomes a valid, centred, grounded transparent pair", async () => {
  for (const theme of ["normal", "halloween"]) {
    const out = await preparePair(await rawPair({ theme }));
    assert.equal(out.report.slots.day.method, "backdrop-key");
    assert.deepEqual(out.report.slots.day.backdrop, [255, 0, 255]);
    const report = await validatePair({ day: out.day, night: out.night });
    assert.equal(report.passed, true, failed(report).join("; "));
  }
});

test("other flat backdrops work too (not tied to magenta)", async () => {
  const out = await preparePair(await rawPair({ backdrop: "#00b140" }));
  assert.deepEqual(out.report.slots.night.backdrop, [0, 177, 64]);
  assert.equal((await validatePair({ day: out.day, night: out.night })).passed, true);
});

test("an image that already has transparency keeps its own alpha", async () => {
  const out = await preparePair(await rawPair({ backdrop: null, dx: 120, dy: 40, scale: 0.7 }));
  assert.equal(out.report.slots.day.method, "source-alpha");
  assert.equal((await validatePair({ day: out.day, night: out.night })).passed, true);
});

test("backdrop-coloured detail inside the building is kept", async () => {
  const out = await preparePair(await rawPair({ detail: true, dx: 0, dy: 0, scale: 1 }));
  // Locate the detail: it sits inside the subject, so its pixels stay opaque.
  const { data, info } = await sharp(out.day).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let magentaOpaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > 200 && data[i] > 200 && data[i + 1] < 60 && data[i + 2] > 200) magentaOpaque++;
  }
  assert.ok(magentaOpaque > 400, `expected the enclosed magenta window to survive, found ${magentaOpaque} px`);
  void info;
});

test("edges carry no backdrop halo at preview sizes", async () => {
  const out = await preparePair(await rawPair());
  const report = await validatePair({ day: out.day, night: out.night });
  const preview = report.images.day.checks.find((c) => c.name === "preview_clean");
  assert.equal(preview.passed, true, preview.detail);
});

test("small detached specks are removed", async () => {
  const out = await preparePair(await rawPair({ speck: true }));
  assert.ok(out.report.slots.day.specksRemoved > 0);
  assert.equal(await alphaAt(out.day, 715, 5), 0);
});

test("day and night share one transform", async () => {
  const out = await preparePair(await rawPair({ theme: "halloween" }));
  const report = await validatePair({ day: out.day, night: out.night });
  assert.equal(report.pair.find((c) => c.name === "shared_frame").detail, "max bounds difference 0px");
  assert.ok(report.images.day.bounds.maxY + 1 >= BASELINE - 3 && report.images.day.bounds.maxY + 1 <= BASELINE + 1);
});

test("a noisy, photo-like backdrop is refused instead of guessed", async () => {
  const noise = Buffer.alloc(1024 * 1024 * 3);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) % 251;
  const photo = await sharp(noise, { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  await assert.rejects(preparePair({ day: photo, night: photo }), (e) => e instanceof PrepareError && e.code === "backdrop_not_flat");
});

test("mismatched day/night shapes, tiny inputs, undecodable bytes and oversized inputs are refused", async () => {
  const day = await syntheticRaw({ lighting: "day" });
  const tall = await syntheticRaw({ lighting: "night", height: 1536 });
  await assert.rejects(preparePair({ day, night: tall }), (e) => e.code === "shape_mismatch");
  const tiny = await sharp(day).resize(300, 300).png().toBuffer();
  await assert.rejects(preparePair({ day: tiny, night: tiny }), (e) => e.code === "too_small");
  await assert.rejects(preparePair({ day: Buffer.from("nope"), night: day }), (e) => e.code === "undecodable");
  await assert.rejects(preparePair({ day, night: day, maxPixels: 500_000 }), (e) => e.code === "undecodable");
});

test("an image with nothing to cut out is refused", async () => {
  const flat = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: "#ff00ff" } }).png().toBuffer();
  await assert.rejects(preparePair({ day: flat, night: flat }), (e) => e.code === "empty");
});

test("scale rule: square subjects fill 84%, wide shallow ones are boosted but capped, tall ones fit", () => {
  assert.equal(Math.round(chooseScale(500, 500) * 500), Math.round(0.84 * CANVAS));
  const wide = chooseScale(900, 300);
  assert.ok(wide * 900 <= 0.92 * CANVAS + 0.5);
  assert.ok(wide * 900 > 0.84 * CANVAS);
  const tall = chooseScale(200, 1000);
  assert.ok(tall * 1000 <= BASELINE - 28 + 0.5);
});
