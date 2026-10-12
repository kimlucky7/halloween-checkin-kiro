import test from "node:test";
import assert from "node:assert/strict";

import { canonicalize, computePayloadHash } from "../worker/halloween/domain/canonical.js";
import { validateRevisionInput, ValidationError } from "../worker/halloween/domain/schema.js";
import { transition, TransitionError, canTransition } from "../worker/halloween/domain/state.js";
import { checkApprovalForPublish } from "../worker/halloween/domain/approval.js";

const H = "a".repeat(64);
const H2 = "b".repeat(64);
const base = () => ({
  theme: "normal",
  text: "at the synthetic cafe",
  images: { day: { sha256: H, bytes: 1000 }, night: { sha256: H2, bytes: 1100 } },
  validator: { version: "pair-validator/1", passed: true },
});
const ctx = { project: "halloween-checkin-test" };

test("canonicalize is key-order independent and rejects undefined", () => {
  assert.equal(canonicalize({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalize({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.throws(() => canonicalize({ a: undefined }), /undefined/);
  assert.throws(() => canonicalize({ a: NaN }), /non-finite/);
});

test("canonicalize applies Unicode NFC", () => {
  assert.equal(canonicalize({ t: "e\u0301" }), canonicalize({ t: "\u00e9" }));
});

test("unknown optional data stays null and no city exists", () => {
  const { payload } = validateRevisionInput(base(), ctx);
  assert.deepEqual(payload.place, { name: null, address: null, lat: null, lng: null });
  assert.equal(payload.capturedAt, null);
  assert.equal(payload.capturedAtSource, null);
  assert.deepEqual(payload.companions, []);
  assert.ok(!("city" in payload.place));
  assert.throws(() => validateRevisionInput({ ...base(), place: { name: "x", city: "y" } }, ctx), ValidationError);
});

test("theme defaults to normal and rejects unknown themes", () => {
  assert.equal(validateRevisionInput(base(), ctx).payload.theme, "normal");
  const { theme, ...rest } = base();
  assert.equal(validateRevisionInput(rest, ctx).payload.theme, "normal");
  assert.throws(() => validateRevisionInput({ ...base(), theme: "christmas" }, ctx), /theme/);
});

test("capture time needs an explicit zone and a source", () => {
  assert.throws(() => validateRevisionInput({ ...base(), capturedAt: "2026-10-01T10:00:00" }, ctx), /capturedAt/);
  assert.throws(() => validateRevisionInput({ ...base(), capturedAt: "2026-10-01T10:00:00+08:00" }, ctx), /capturedAtSource/);
  assert.throws(() => validateRevisionInput({ ...base(), capturedAtSource: "exif" }, ctx), /capturedAtSource/);
  const ok = validateRevisionInput({ ...base(), capturedAt: "2026-10-01T10:00:00+08:00", capturedAtSource: "exif" }, ctx);
  assert.equal(ok.payload.capturedAt, "2026-10-01T10:00:00+08:00");
});

test("gps requires both coordinates within range", () => {
  assert.throws(() => validateRevisionInput({ ...base(), place: { lat: 1 } }, ctx), /lat and lng/);
  assert.throws(() => validateRevisionInput({ ...base(), place: { lat: 91, lng: 0 } }, ctx), /lat/);
});

test("rejects unrecognized fields, missing images, and failed validation", () => {
  assert.throws(() => validateRevisionInput({ ...base(), ownerId: "someone" }, ctx), /ownerId/);
  const { images, ...noImages } = base();
  assert.throws(() => validateRevisionInput(noImages, ctx), /images/);
  assert.throws(() => validateRevisionInput({ ...base(), images: { day: base().images.day } }, ctx), /images.night/);
  assert.throws(() => validateRevisionInput({ ...base(), validator: { version: "v", passed: false } }, ctx), /validator.passed/);
});

test("changing any approved field changes the payload hash", async () => {
  const { payload } = validateRevisionInput(base(), ctx);
  const h0 = await computePayloadHash(payload);
  const variants = [
    { ...payload, text: payload.text + "!" },
    { ...payload, theme: "halloween" },
    { ...payload, project: "other-project" },
    { ...payload, companions: ["Ada"] },
    { ...payload, images: { ...payload.images, night: { ...payload.images.night, sha256: "c".repeat(64) } } },
    { ...payload, validatorVersion: "pair-validator/2" },
    { ...payload, differences: ["roof simplified"] },
    { ...payload, place: { ...payload.place, name: "Synthetic Cafe" } },
  ];
  const hashes = new Set([h0]);
  for (const v of variants) hashes.add(await computePayloadHash(v));
  assert.equal(hashes.size, variants.length + 1);
  assert.equal(await computePayloadHash(payload), h0);
});

test("state machine allows the happy path and blocks shortcuts", () => {
  let s = "created";
  for (const e of ["register", "media_complete", "approve", "start_publish", "commit"]) s = transition(s, e);
  assert.equal(s, "published");
  assert.throws(() => transition("review_ready", "start_publish"), TransitionError);
  assert.throws(() => transition("preparing", "approve"), TransitionError);
  assert.throws(() => transition("published", "cancel"), TransitionError);
  assert.equal(canTransition("approved", "revoke"), true);
  assert.equal(transition("approved", "revoke"), "review_ready");
});

function fixture(over = {}) {
  const now = Date.parse("2026-10-12T10:00:00Z");
  const revision = { id: "rev1", payloadHash: "h1", payload: { project: "p" }, validationPassed: true };
  const approval = {
    revisionId: "rev1", payloadHash: "h1", revokedAt: null,
    expiresAt: new Date(now + 60_000).toISOString(),
    target: { project: "p", visibility: "public" },
  };
  return { approval, revision, expectedHash: "h1", target: { project: "p", visibility: "public" }, now, ...over };
}

test("approval check accepts a matching approval", () => {
  assert.deepEqual(checkApprovalForPublish(fixture()), { ok: true });
});

test("approval check refuses missing, mismatched, expired, revoked, and wrong-target cases", () => {
  const f = fixture();
  const reason = (o) => checkApprovalForPublish({ ...f, ...o }).reason;
  assert.equal(reason({ approval: null }), "approval_not_found");
  assert.equal(reason({ approval: { ...f.approval, revisionId: "other" } }), "revision_mismatch");
  assert.equal(reason({ approval: { ...f.approval, payloadHash: "x" } }), "hash_mismatch");
  assert.equal(reason({ expectedHash: "x" }), "hash_mismatch");
  assert.equal(reason({ approval: { ...f.approval, revokedAt: "2026-10-12T09:59:00Z" } }), "approval_revoked");
  assert.equal(reason({ now: f.now + 120_000 }), "approval_expired");
  assert.equal(reason({ target: { project: "q", visibility: "public" } }), "target_mismatch");
  assert.equal(reason({ revision: { ...f.revision, validationPassed: false } }), "validation_failed");
});
