// Canonical serialization and hashing for approval-bound payloads.
//
// Frozen rules (payload version 1):
//  - object keys sorted by UTF-16 code unit order, no insignificant whitespace
//  - strings Unicode NFC; `undefined` is rejected, absence must be explicit `null`
//  - numbers must be finite; integers only unless a field is documented otherwise
//  - the same function runs in Node and Workers (WebCrypto only)

export const PAYLOAD_VERSION = 1;

export function canonicalize(value) {
  return JSON.stringify(normalize(value, "$"));
}

function normalize(value, path) {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return value.normalize("NFC");
    case "boolean":
      return value;
    case "number":
      if (!Number.isFinite(value)) throw new TypeError(`non-finite number at ${path}`);
      return value;
    case "undefined":
      throw new TypeError(`undefined at ${path}; use null for explicit absence`);
    case "object": {
      if (Array.isArray(value)) return value.map((item, i) => normalize(item, `${path}[${i}]`));
      const proto = Object.getPrototypeOf(value);
      if (proto !== Object.prototype && proto !== null) {
        throw new TypeError(`unsupported object type at ${path}`);
      }
      const out = {};
      for (const key of Object.keys(value).sort()) {
        out[key.normalize("NFC")] = normalize(value[key], `${path}.${key}`);
      }
      return out;
    }
    default:
      throw new TypeError(`unsupported ${typeof value} at ${path}`);
  }
}

export async function sha256Hex(input) {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The payload covers everything that changes the public result: theme, text,
// place, capture time, companions, differences, the exact image hashes, the
// validator version, and the publication target. Changing any of them changes
// the hash and therefore invalidates an earlier approval.
export async function computePayloadHash(payload) {
  return sha256Hex(canonicalize({ v: PAYLOAD_VERSION, ...payload }));
}
