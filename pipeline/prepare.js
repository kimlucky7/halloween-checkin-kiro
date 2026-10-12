// Deterministic preparation of a host-generated day/night pair into the final
// 720×720 transparent PNGs. Written for this project.
//
//  1. Decode each raw image (bounded pixel count), bring both to one working size.
//  2. Background: keep a real alpha channel when the image already has one;
//     otherwise estimate the flat backdrop colour from the image border and key
//     it out with a flood fill that starts at the border. Only backdrop that is
//     connected to the border is removed, so backdrop-coloured details inside the
//     building (a purple sign, a window) survive.
//  3. Edge pixels are "unmixed" from the backdrop colour so no coloured halo is left.
//  4. Small detached specks are dropped.
//  5. One shared transform (scale + offset) for both images: the union of the two
//     subjects is centred horizontally and stands on the baseline y = 651.
//
// Nothing here judges whether the building is recognisable; that is visual review.
import sharp from "sharp";

export const PREPARE_VERSION = "prepare/1";
export const CANVAS = 720;
export const BASELINE = 651;
const WORK_SIZE = 1024;
const TOP_MARGIN = 28;
const BASE_FILL = 0.84;
const MAX_FILL = 0.92;
const WIDE_MIN_HEIGHT = 0.6; // of the canvas, for wide and shallow subjects
const VISIBLE = 0.06; // alpha considered part of the subject
const KEY_INNER = 38; // colour distance treated as pure backdrop
const KEY_OUTER = 115; // colour distance treated as pure subject

export class PrepareError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PrepareError";
    this.code = code;
  }
}

async function decode(input, label, maxPixels) {
  let meta;
  try {
    meta = await sharp(input, { limitInputPixels: maxPixels }).metadata();
  } catch (error) {
    throw new PrepareError("undecodable", `${label}: ${String(error.message).slice(0, 120)}`);
  }
  if (!meta.width || !meta.height) throw new PrepareError("undecodable", `${label}: no dimensions`);
  if (Math.min(meta.width, meta.height) < 512) {
    throw new PrepareError("too_small", `${label}: ${meta.width}×${meta.height} is below 512 px on the short side`);
  }
  const scale = WORK_SIZE / Math.max(meta.width, meta.height);
  const width = Math.round(meta.width * scale);
  const height = Math.round(meta.height * scale);
  const { data } = await sharp(input, { limitInputPixels: maxPixels })
    .rotate()
    .resize(width, height, { kernel: "lanczos3", fit: "fill" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { rgba: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length).slice(), width, height };
}

function borderIndices(width, height) {
  const out = [];
  for (let x = 0; x < width; x++) out.push(x, (height - 1) * width + x);
  for (let y = 1; y < height - 1; y++) out.push(y * width, y * width + width - 1);
  return out;
}

const median = (values) => {
  const sorted = Float64Array.from(values).sort();
  return sorted[sorted.length >> 1];
};

function distance(rgba, i, bg) {
  const dr = rgba[i * 4] - bg[0];
  const dg = rgba[i * 4 + 1] - bg[1];
  const db = rgba[i * 4 + 2] - bg[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Returns alpha in 0..1 for every pixel, and which method produced it. */
function matte({ rgba, width, height }, label) {
  const n = width * height;
  const border = borderIndices(width, height);
  const alpha = new Float32Array(n);
  const transparentBorder = border.filter((i) => rgba[i * 4 + 3] < 16).length / border.length;

  if (transparentBorder > 0.9) {
    for (let i = 0; i < n; i++) alpha[i] = rgba[i * 4 + 3] / 255;
    return { alpha, method: "source-alpha", backdrop: null };
  }

  const bg = [0, 1, 2].map((c) => median(border.map((i) => rgba[i * 4 + c])));
  const uniform = border.filter((i) => distance(rgba, i, bg) < KEY_OUTER * 0.6).length / border.length;
  if (uniform < 0.85) {
    throw new PrepareError(
      "backdrop_not_flat",
      `${label}: the edge of the image is not one flat colour (${Math.round(uniform * 100)}% match); ask the image tool for a flat backdrop`,
    );
  }

  // Flood fill from the border through anything that could be backdrop.
  alpha.fill(1);
  const seen = new Uint8Array(n);
  const queue = new Int32Array(n);
  let head = 0;
  let tail = 0;
  for (const i of border) {
    if (!seen[i] && distance(rgba, i, bg) < KEY_OUTER) {
      seen[i] = 1;
      queue[tail++] = i;
    }
  }
  while (head < tail) {
    const i = queue[head++];
    const d = distance(rgba, i, bg);
    alpha[i] = Math.min(1, Math.max(0, (d - KEY_INNER) / (KEY_OUTER - KEY_INNER)));
    // Grow only through backdrop-like pixels; stop at the subject's edge.
    if (d >= KEY_OUTER * 0.85) continue;
    const x = i % width;
    const neighbours = [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, i - width, i + width];
    for (const j of neighbours) {
      if (j < 0 || j >= n || seen[j]) continue;
      if (distance(rgba, j, bg) < KEY_OUTER) {
        seen[j] = 1;
        queue[tail++] = j;
      }
    }
  }
  return { alpha, method: "backdrop-key", backdrop: bg.map(Math.round) };
}

/** Remove the backdrop colour mixed into semi-transparent edge pixels. */
function unmix(rgba, alpha, backdrop) {
  if (!backdrop) return;
  for (let i = 0; i < alpha.length; i++) {
    const a = alpha[i];
    if (a <= 0 || a >= 1) continue;
    if (a < 0.08) {
      alpha[i] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) {
      rgba[i * 4 + c] = (rgba[i * 4 + c] - (1 - a) * backdrop[c]) / a;
    }
  }
}

/** Keep the main subject and anything reasonably large; drop specks. */
function dropSpecks(alpha, width, height) {
  const n = width * height;
  const label = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  for (let start = 0; start < n; start++) {
    if (label[start] !== -1 || alpha[start] < VISIBLE) continue;
    const id = sizes.length;
    let top = 0;
    let size = 0;
    stack[top++] = start;
    label[start] = id;
    while (top > 0) {
      const i = stack[--top];
      size++;
      const x = i % width;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (!dx && !dy) continue;
          const nx = x + dx;
          const j = i + dy * width + dx;
          if (nx < 0 || nx >= width || j < 0 || j >= n) continue;
          if (label[j] === -1 && alpha[j] >= VISIBLE) {
            label[j] = id;
            stack[top++] = j;
          }
        }
      }
    }
    sizes.push(size);
  }
  if (sizes.length === 0) return { removed: 0 };
  const largest = Math.max(...sizes);
  const keep = sizes.map((s) => s >= Math.max(48, largest * 0.01));
  let removed = 0;
  for (let i = 0; i < n; i++) {
    if (label[i] >= 0 && !keep[label[i]]) {
      alpha[i] = 0;
      removed++;
    } else if (label[i] === -1 && alpha[i] > 0) {
      alpha[i] = 0; // faint residue below the visibility threshold
    }
  }
  return { removed };
}

function bounds(alpha, width, height) {
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alpha[y * width + x] >= VISIBLE) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { minX, minY, maxX, maxY };
}

/** Longest-side fill, with a boost for wide and shallow subjects. Pure, tested. */
export function chooseScale(subjectWidth, subjectHeight) {
  let scale = (BASE_FILL * CANVAS) / Math.max(subjectWidth, subjectHeight);
  if (subjectWidth > subjectHeight * 1.15) {
    const forHeight = (WIDE_MIN_HEIGHT * CANVAS) / subjectHeight;
    scale = Math.min(Math.max(scale, forHeight), (MAX_FILL * CANVAS) / subjectWidth);
  }
  // Tall subjects must fit between the top margin and the baseline.
  scale = Math.min(scale, (BASELINE - TOP_MARGIN) / subjectHeight);
  return scale;
}

async function compose(image, alpha, box, scale) {
  const { width, height } = image;
  const pixels = Buffer.alloc(width * height * 4);
  for (let i = 0; i < alpha.length; i++) {
    pixels[i * 4] = image.rgba[i * 4];
    pixels[i * 4 + 1] = image.rgba[i * 4 + 1];
    pixels[i * 4 + 2] = image.rgba[i * 4 + 2];
    pixels[i * 4 + 3] = Math.round(alpha[i] * 255);
  }
  const w = box.maxX - box.minX + 1;
  const h = box.maxY - box.minY + 1;
  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));
  const subject = await sharp(pixels, { raw: { width, height, channels: 4 } })
    .extract({ left: box.minX, top: box.minY, width: w, height: h })
    .resize(outW, outH, { kernel: "lanczos3", fit: "fill" })
    .png()
    .toBuffer();
  return sharp({ create: { width: CANVAS, height: CANVAS, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: subject, left: Math.round((CANVAS - outW) / 2), top: BASELINE - outH }])
    .png({ compressionLevel: 9, palette: false })
    .toBuffer();
}

/**
 * @param {{ day: Uint8Array|Buffer, night: Uint8Array|Buffer, maxPixels?: number }} input
 * @returns {Promise<{ day: Buffer, night: Buffer, report: object }>}
 */
export async function preparePair({ day, night, maxPixels = 40_000_000 }) {
  const images = {
    day: await decode(day, "day", maxPixels),
    night: await decode(night, "night", maxPixels),
  };
  if (images.day.width !== images.night.width || images.day.height !== images.night.height) {
    throw new PrepareError("shape_mismatch", "day and night must have the same aspect ratio (night is an edit of day)");
  }
  const { width, height } = images.day;
  const report = { version: PREPARE_VERSION, slots: {} };
  const alphas = {};
  const boxes = {};
  for (const slot of ["day", "night"]) {
    const m = matte(images[slot], slot);
    unmix(images[slot].rgba, m.alpha, m.backdrop);
    const specks = dropSpecks(m.alpha, width, height);
    const box = bounds(m.alpha, width, height);
    if (!box) throw new PrepareError("empty", `${slot}: nothing left after removing the backdrop`);
    const coverage = ((box.maxX - box.minX + 1) * (box.maxY - box.minY + 1)) / (width * height);
    if (coverage > 0.97) throw new PrepareError("no_backdrop", `${slot}: the subject fills the whole image; nothing to cut out`);
    alphas[slot] = m.alpha;
    boxes[slot] = box;
    report.slots[slot] = { method: m.method, backdrop: m.backdrop, specksRemoved: specks.removed, box };
  }
  const shared = {
    minX: Math.min(boxes.day.minX, boxes.night.minX),
    minY: Math.min(boxes.day.minY, boxes.night.minY),
    maxX: Math.max(boxes.day.maxX, boxes.night.maxX),
    maxY: Math.max(boxes.day.maxY, boxes.night.maxY),
  };
  const scale = chooseScale(shared.maxX - shared.minX + 1, shared.maxY - shared.minY + 1);
  report.transform = { box: shared, scale: Number(scale.toFixed(5)), baseline: BASELINE };
  const [dayOut, nightOut] = await Promise.all([
    compose(images.day, alphas.day, shared, scale),
    compose(images.night, alphas.night, shared, scale),
  ]);
  return { day: dayOut, night: nightOut, report };
}
