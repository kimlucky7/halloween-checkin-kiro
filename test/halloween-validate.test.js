import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";

import { syntheticPair, syntheticMiniature } from "../pipeline/synthetic.js";
import { validatePair, makePreviews } from "../pipeline/validate.js";

const failed = (report) =>
  [...Object.values(report.images).flatMap((i) => i.checks), ...report.pair]
    .filter((c) => !c.passed)
    .map((c) => c.name);

test("synthetic normal and halloween pairs pass validation", async () => {
  for (const theme of ["normal", "halloween"]) {
    const pair = await syntheticPair({ theme });
    const report = await validatePair(pair);
    assert.equal(report.passed, true, `${theme}: ${failed(report)}`);
    assert.equal(report.visualReview, "not_performed");
    assert.match(report.images.day.sha256, /^[0-9a-f]{64}$/);
  }
});

test("normal and halloween variants differ and do not overwrite each other", async () => {
  const n = await syntheticPair({ theme: "normal" });
  const h = await syntheticPair({ theme: "halloween" });
  assert.notDeepEqual(n.day, h.day);
  assert.notDeepEqual(n.night, h.night);
});

test("previews are produced at 360 and 240", async () => {
  const { day } = await syntheticPair();
  const previews = await makePreviews(day);
  assert.equal((await sharp(previews[360]).metadata()).width, 360);
  assert.equal((await sharp(previews[240]).metadata()).width, 240);
});

test("rejects wrong extension content, corrupted PNG, and empty input", async () => {
  const { day, night } = await syntheticPair();
  const jpeg = await sharp(day).flatten({ background: "#fff" }).jpeg().toBuffer();
  assert.ok(failed(await validatePair({ day: jpeg, night })).includes("png_signature"));
  const corrupted = new Uint8Array(day);
  for (let i = 1000; i < 1100; i++) corrupted[i] ^= 0xff; // inside the IDAT stream
  assert.equal((await validatePair({ day: corrupted, night })).passed, false);
  assert.equal((await validatePair({ day: new Uint8Array(0), night })).passed, false);
  assert.equal((await validatePair({ night })).passed, false);
});

test("rejects wrong dimensions", async () => {
  const { night } = await syntheticPair();
  const small = await sharp(night).resize(512, 512).png().toBuffer();
  assert.ok(failed(await validatePair({ day: small, night })).includes("dimensions"));
});

test("rejects images without alpha or with a drawn opaque background", async () => {
  const { day, night } = await syntheticPair();
  const noAlpha = await sharp(day).flatten({ background: "#ffffff" }).removeAlpha().png().toBuffer();
  assert.ok(failed(await validatePair({ day: noAlpha, night })).includes("has_alpha_channel"));
  const checker = await sharp(day).flatten({ background: "#cccccc" }).ensureAlpha().png().toBuffer();
  assert.ok(failed(await validatePair({ day: checker, night })).includes("real_transparency"));
});

test("rejects oversized decode input", async () => {
  const { night } = await syntheticPair();
  const big = await sharp({ create: { width: 5000, height: 5000, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .png({ compressionLevel: 9 }).toBuffer();
  const report = await validatePair({ day: big, night });
  assert.equal(report.passed, false);
});

test("rejects a night image whose subject differs from the day frame", async () => {
  const { day } = await syntheticPair();
  const other = await syntheticMiniature({ lighting: "night", variant: 1 }); // narrower building
  const report = await validatePair({ day, night: other });
  assert.ok(failed(report).includes("shared_frame"));
});

test("rejects a floating or off-center subject", async () => {
  const { day, night } = await syntheticPair();
  const floating = await sharp({ create: { width: 720, height: 720, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: night, top: -60, left: 0 }]).png().toBuffer();
  assert.ok(failed(await validatePair({ day, night: floating })).includes("grounded_on_baseline"));
  const shifted = await sharp({ create: { width: 720, height: 720, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: day, top: 0, left: 80 }]).png().toBuffer();
  assert.ok(failed(await validatePair({ day: shifted, night })).includes("horizontally_centered"));
});

test("rejects a fully transparent image", async () => {
  const { night } = await syntheticPair();
  const empty = await sharp({ create: { width: 720, height: 720, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  assert.equal((await validatePair({ day: empty, night })).passed, false);
});
