// Structural check for the final PNGs the Worker accepts, written for this
// project from the PNG specification (ISO/IEC 15948). It never decodes pixels
// into colours; it proves the file is one complete, well-formed 720×720 8-bit
// RGBA PNG whose compressed image data inflates to exactly the expected size.
//
// Runs in Workers (nodejs_compat provides node:zlib natively) and in Node.
import { crc32, inflateSync } from "node:zlib";

export const FINAL_SIZE = 720;
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const KNOWN_CRITICAL = new Set(["IHDR", "PLTE", "IDAT", "IEND"]);
const COLOR_RGBA = 6;

export class PngError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PngError";
    this.code = code;
  }
}

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function* chunks(bytes) {
  let pos = SIGNATURE.length;
  while (pos < bytes.length) {
    if (pos + 12 > bytes.length) throw new PngError("truncated", "chunk header runs past the end of the file");
    const length = u32(bytes, pos);
    const end = pos + 12 + length;
    if (end > bytes.length) throw new PngError("truncated", "chunk data runs past the end of the file");
    const typeBytes = bytes.subarray(pos + 4, pos + 8);
    for (const c of typeBytes) {
      const letter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
      if (!letter) throw new PngError("bad_chunk", "chunk type is not four ASCII letters");
    }
    const type = String.fromCharCode(...typeBytes);
    const stored = u32(bytes, end - 4);
    if (crc32(bytes.subarray(pos + 4, end - 4)) !== stored) {
      throw new PngError("bad_crc", `${type} chunk checksum does not match`);
    }
    yield { type, data: bytes.subarray(pos + 8, end - 4), end };
    pos = end;
  }
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ width: number, height: number }}
 * @throws {PngError}
 */
export function checkFinalPng(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < SIGNATURE.length + 12) {
    throw new PngError("not_png", "file is too short to be a PNG");
  }
  for (let i = 0; i < SIGNATURE.length; i++) {
    if (bytes[i] !== SIGNATURE[i]) throw new PngError("not_png", "file does not start with the PNG signature");
  }

  let header = null;
  const compressed = [];
  let compressedLength = 0;
  let idatState = "before"; // before → inside → after
  let finished = false;

  for (const { type, data, end } of chunks(bytes)) {
    if (!header) {
      if (type !== "IHDR" || data.length !== 13) throw new PngError("bad_header", "first chunk must be a 13-byte IHDR");
      header = {
        width: u32(data, 0),
        height: u32(data, 4),
        depth: data[8],
        color: data[9],
        compression: data[10],
        filter: data[11],
        interlace: data[12],
      };
      continue;
    }
    if (type === "IHDR") throw new PngError("bad_header", "IHDR appears more than once");
    const critical = type.charCodeAt(0) < 97;
    if (critical && !KNOWN_CRITICAL.has(type)) throw new PngError("bad_chunk", `unknown critical chunk ${type}`);

    if (type === "IDAT") {
      if (idatState === "after") throw new PngError("bad_chunk", "IDAT chunks must be consecutive");
      idatState = "inside";
      compressed.push(data);
      compressedLength += data.length;
    } else if (idatState === "inside") {
      idatState = "after";
    }

    if (type === "IEND") {
      if (data.length !== 0) throw new PngError("bad_chunk", "IEND must be empty");
      if (end !== bytes.length) throw new PngError("trailing_data", "data follows IEND");
      finished = true;
      break;
    }
  }

  if (!header) throw new PngError("bad_header", "missing IHDR");
  if (!finished) throw new PngError("truncated", "missing IEND");
  if (compressedLength === 0) throw new PngError("no_image_data", "missing IDAT");
  if (header.compression !== 0 || header.filter !== 0 || header.interlace !== 0) {
    throw new PngError("unsupported", "PNG must use standard compression, standard filtering and no interlacing");
  }
  if (header.width !== FINAL_SIZE || header.height !== FINAL_SIZE) {
    throw new PngError("bad_size", `PNG must be ${FINAL_SIZE}×${FINAL_SIZE}, got ${header.width}×${header.height}`);
  }
  if (header.depth !== 8 || header.color !== COLOR_RGBA) {
    throw new PngError("bad_format", "PNG must be 8-bit RGBA (colour type 6)");
  }

  // Each row is one filter-type byte followed by width × 4 bytes.
  const rowBytes = 1 + FINAL_SIZE * 4;
  const expected = rowBytes * FINAL_SIZE;
  const joined = new Uint8Array(compressedLength);
  let offset = 0;
  for (const part of compressed) {
    joined.set(part, offset);
    offset += part.length;
  }
  let raw;
  try {
    // A bounded output length stops decompression bombs before they allocate.
    raw = inflateSync(joined, { maxOutputLength: expected });
  } catch {
    throw new PngError("bad_image_data", "image data does not inflate cleanly to the expected size");
  }
  if (raw.length !== expected) throw new PngError("bad_image_data", "image data has the wrong length");
  for (let row = 0; row < FINAL_SIZE; row++) {
    if (raw[row * rowBytes] > 4) throw new PngError("bad_image_data", `row ${row} uses an unknown filter type`);
  }
  return { width: header.width, height: header.height };
}
