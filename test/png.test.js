import test from "node:test";
import assert from "node:assert/strict";
import { crc32, deflateSync } from "node:zlib";
import sharp from "sharp";

import { checkFinalPng, PngError } from "../worker/halloween/png.js";
import { tokenMatches } from "../worker/halloween/auth.js";
import { syntheticPair } from "../pipeline/synthetic.js";

// Hand-built PNGs so each structural rule can be broken on purpose.
function chunk(type, data = new Uint8Array(0)) {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}
function ihdr({ width = 720, height = 720, depth = 8, color = 6, interlace = 0 } = {}) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d.set([depth, color, 0, 0, interlace], 8);
  return chunk("IHDR", d);
}
function pixels({ width = 720, height = 720, filter = 0 } = {}) {
  const raw = new Uint8Array((1 + width * 4) * height);
  for (let r = 0; r < height; r++) raw[r * (1 + width * 4)] = filter;
  return deflateSync(raw);
}
const SIG = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const join = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const code = (bytes) => { try { checkFinalPng(bytes); return "ok"; } catch (e) { assert.ok(e instanceof PngError); return e.code; } };

test("accepts a minimal valid 720×720 RGBA PNG and real encoder output", async () => {
  assert.equal(code(join(SIG, ihdr(), chunk("IDAT", pixels()), chunk("IEND"))), "ok");
  const idat = pixels();
  const half = idat.length >> 1;
  assert.equal(code(join(SIG, ihdr(), chunk("tEXt", new Uint8Array(3)), chunk("IDAT", idat.subarray(0, half)), chunk("IDAT", idat.subarray(half)), chunk("IEND"))), "ok");
  const { day } = await syntheticPair();
  assert.deepEqual(checkFinalPng(new Uint8Array(day)), { width: 720, height: 720 });
});

test("rejects wrong signature, truncation, bad CRC and trailing data", () => {
  const good = join(SIG, ihdr(), chunk("IDAT", pixels()), chunk("IEND"));
  assert.equal(code(new TextEncoder().encode("GIF89a, definitely not a png file")), "not_png");
  assert.equal(code(good.subarray(0, good.length - 6)), "truncated");
  const flipped = good.slice();
  flipped[50] ^= 0xff; // inside the IDAT data
  assert.equal(code(flipped), "bad_crc");
  assert.equal(code(join(good, Uint8Array.of(0))), "trailing_data");
});

test("rejects wrong size, format, interlace and unknown critical chunks", () => {
  const body = (h, extra = []) => join(SIG, h, ...extra, chunk("IDAT", pixels()), chunk("IEND"));
  assert.equal(code(body(ihdr({ width: 1024 }))), "bad_size");
  assert.equal(code(body(ihdr({ color: 2 }))), "bad_format");
  assert.equal(code(body(ihdr({ depth: 16 }))), "bad_format");
  assert.equal(code(body(ihdr({ interlace: 1 }))), "unsupported");
  assert.equal(code(body(ihdr(), [chunk("ABCD", new Uint8Array(1))])), "bad_chunk");
  assert.equal(code(join(SIG, chunk("IDAT", pixels()), chunk("IEND"))), "bad_header");
});

test("rejects missing, split or malformed image data and decompression bombs", () => {
  assert.equal(code(join(SIG, ihdr(), chunk("IEND"))), "no_image_data");
  const idat = pixels();
  assert.equal(code(join(SIG, ihdr(), chunk("IDAT", idat.subarray(0, 10)), chunk("tEXt", new Uint8Array(1)), chunk("IDAT", idat.subarray(10)), chunk("IEND"))), "bad_chunk");
  assert.equal(code(join(SIG, ihdr(), chunk("IDAT", pixels({ height: 700 })), chunk("IEND"))), "bad_image_data");
  assert.equal(code(join(SIG, ihdr(), chunk("IDAT", pixels({ filter: 9 })), chunk("IEND"))), "bad_image_data");
  // 40 MB of zeros compresses to ~40 KB; the bounded inflate refuses it.
  const bomb = deflateSync(new Uint8Array(40 * 1024 * 1024));
  assert.equal(code(join(SIG, ihdr(), chunk("IDAT", bomb), chunk("IEND"))), "bad_image_data");
});

test("rejects real images that are the wrong size or have no alpha", async () => {
  const { day } = await syntheticPair();
  assert.equal(code(new Uint8Array(await sharp(day).resize(512, 512).png().toBuffer())), "bad_size");
  assert.equal(code(new Uint8Array(await sharp(day).removeAlpha().png().toBuffer())), "bad_format");
});

test("token comparison", async () => {
  assert.equal(await tokenMatches("abc", "abc"), true);
  assert.equal(await tokenMatches("abd", "abc"), false);
  assert.equal(await tokenMatches("abc", ""), false);
  assert.equal(await tokenMatches(undefined, "abc"), false);
  assert.equal(await tokenMatches("abcabc", "abc"), false);
});
