// Input validation for draft revisions. Unknown data stays null; nothing is
// inferred. There is intentionally no city field and no default place.

export const THEMES = ["normal", "halloween"];
export const SLOTS = ["day", "night"];
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 280;
export const MAX_COMPANIONS = 10;
export const MAX_DIFFERENCES = 20;
export const CAPTURE_SOURCES = ["exif", "user", "checkin"];

export class ValidationError extends Error {
  constructor(issues) {
    super("Invalid input: " + issues.map((i) => `${i.field} ${i.message}`).join("; "));
    this.name = "ValidationError";
    this.issues = issues;
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * @param {unknown} input
 * @param {{ project: string }} context
 * @returns the normalized, hash-ready revision payload (without id/created fields)
 */
export function validateRevisionInput(input, { project }) {
  const issues = [];
  const fail = (field, message) => issues.push({ field, message });
  const obj = input && typeof input === "object" && !Array.isArray(input) ? input : null;
  if (!obj) throw new ValidationError([{ field: "body", message: "must be an object" }]);

  const allowed = new Set([
    "theme", "text", "place", "capturedAt", "capturedAtSource", "companions",
    "differences", "images", "validator", "linkCheckinId",
  ]);
  for (const key of Object.keys(obj)) if (!allowed.has(key)) fail(key, "is not a recognized field");

  const theme = obj.theme ?? "normal";
  if (!THEMES.includes(theme)) fail("theme", `must be one of ${THEMES.join(", ")}`);

  const text = typeof obj.text === "string" ? obj.text.normalize("NFC").trim() : "";
  if (!text) fail("text", "is required");
  else if (text.length > MAX_TEXT_LENGTH) fail("text", `must be at most ${MAX_TEXT_LENGTH} characters`);

  const place = normalizePlace(obj.place, fail);

  let capturedAt = null;
  let capturedAtSource = null;
  if (obj.capturedAt != null) {
    if (typeof obj.capturedAt !== "string" || !ISO_WITH_ZONE.test(obj.capturedAt) ||
        Number.isNaN(Date.parse(obj.capturedAt))) {
      fail("capturedAt", "must be ISO-8601 with an explicit time zone offset");
    } else {
      capturedAt = obj.capturedAt;
    }
    // exif: from the photo's metadata; user: stated by the owner;
    // checkin: the time the owner recorded when checking in on site (imported records).
    if (!CAPTURE_SOURCES.includes(obj.capturedAtSource)) {
      fail("capturedAtSource", `must be one of ${CAPTURE_SOURCES.join(", ")} when capturedAt is set`);
    } else {
      capturedAtSource = obj.capturedAtSource;
    }
  } else if (obj.capturedAtSource != null) {
    fail("capturedAtSource", "must be absent when capturedAt is unknown");
  }

  const companions = stringList(obj.companions, "companions", MAX_COMPANIONS, 60, fail);
  const differences = stringList(obj.differences, "differences", MAX_DIFFERENCES, 300, fail);

  const images = {};
  const rawImages = obj.images && typeof obj.images === "object" ? obj.images : null;
  if (!rawImages) fail("images", "must include day and night");
  else {
    for (const slot of SLOTS) {
      const img = rawImages[slot];
      if (!img || typeof img !== "object") { fail(`images.${slot}`, "is required"); continue; }
      if (typeof img.sha256 !== "string" || !SHA256.test(img.sha256)) {
        fail(`images.${slot}.sha256`, "must be lowercase hex SHA-256");
      }
      if (!Number.isInteger(img.bytes) || img.bytes <= 0 || img.bytes > MAX_IMAGE_BYTES) {
        fail(`images.${slot}.bytes`, `must be an integer in 1..${MAX_IMAGE_BYTES}`);
      }
      images[slot] = { sha256: img.sha256, bytes: img.bytes, width: 720, height: 720, mime: "image/png" };
    }
    for (const key of Object.keys(rawImages)) {
      if (!SLOTS.includes(key)) fail(`images.${key}`, "is not a recognized slot");
    }
  }

  const validator = obj.validator;
  if (!validator || typeof validator.version !== "string" || !validator.version) {
    fail("validator.version", "is required");
  }
  if (validator && validator.passed !== true) fail("validator.passed", "must be true to register a revision");

  if (obj.linkCheckinId != null && (typeof obj.linkCheckinId !== "string" || !/^[a-z0-9-]{6,64}$/.test(obj.linkCheckinId))) {
    fail("linkCheckinId", "must be an existing check-in id");
  }

  if (issues.length) throw new ValidationError(issues);

  return {
    payload: {
      project,
      visibility: "public",
      theme,
      text,
      place,
      capturedAt,
      capturedAtSource,
      companions,
      differences,
      images,
      validatorVersion: validator.version,
    },
    linkCheckinId: obj.linkCheckinId ?? null,
  };
}

function normalizePlace(raw, fail) {
  if (raw == null) return { name: null, address: null, lat: null, lng: null };
  if (typeof raw !== "object" || Array.isArray(raw)) { fail("place", "must be an object or null"); return null; }
  const out = { name: null, address: null, lat: null, lng: null };
  for (const key of Object.keys(raw)) {
    if (!(key in out)) fail(`place.${key}`, "is not a recognized field (no city field exists)");
  }
  for (const key of ["name", "address"]) {
    const v = raw[key];
    if (v == null) continue;
    if (typeof v !== "string" || !v.trim() || v.length > 200) fail(`place.${key}`, "must be a non-empty string up to 200 chars or null");
    else out[key] = v.normalize("NFC").trim();
  }
  const hasLat = raw.lat != null;
  const hasLng = raw.lng != null;
  if (hasLat !== hasLng) fail("place.lat", "lat and lng must be provided together");
  else if (hasLat) {
    if (!Number.isFinite(raw.lat) || raw.lat < -90 || raw.lat > 90) fail("place.lat", "must be within -90..90");
    else if (!Number.isFinite(raw.lng) || raw.lng < -180 || raw.lng > 180) fail("place.lng", "must be within -180..180");
    else { out.lat = raw.lat; out.lng = raw.lng; }
  }
  return out;
}

function stringList(raw, field, max, maxLen, fail) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) { fail(field, "must be an array"); return []; }
  if (raw.length > max) fail(field, `must have at most ${max} items`);
  const out = [];
  raw.forEach((item, i) => {
    if (typeof item !== "string" || !item.trim() || item.length > maxLen) {
      fail(`${field}[${i}]`, `must be a non-empty string up to ${maxLen} chars`);
    } else out.push(item.normalize("NFC").trim());
  });
  return out;
}
