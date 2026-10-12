import test from "node:test";
import assert from "node:assert/strict";

import { createApp, createD1, createBucket, registerSynthetic, reviewReady, approved, uploadBoth, newKey, TOKEN } from "../testkit/harness.js";
import { sha256Hex } from "../worker/halloween/domain/canonical.js";

const count = (app, table) => app.db.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
const publish = (app, r, key = newKey(), over = {}) =>
  app.call("POST", `/api/revisions/${r.revisionId}/publish`, {
    headers: { "idempotency-key": key },
    body: { payloadHash: r.payloadHash, approvalId: r.approvalId, ...over },
  });

// ---- scenario 1: normal chain -------------------------------------------------

test("normal chain: register → upload → approve → publish yields one readable record", async () => {
  const app = createApp();
  const r = await approved(app);
  assert.equal(r.review.state, "review_ready");
  const res = await publish(app, r);
  assert.equal(res.status, 201);
  assert.equal(res.data.state, "published");
  assert.equal(res.data.replay, false);

  assert.equal(count(app, "hc_checkins"), 1);
  const list = await app.call("GET", "/api/checkins", { auth: null });
  assert.equal(list.status, 200);
  assert.equal(list.data.checkins.length, 1);
  const v = list.data.checkins[0].variants[0];
  assert.equal(v.theme, "normal");

  const day = await app.call("GET", new URL(v.day, "https://x").pathname, { auth: null });
  assert.equal(day.status, 200);
  assert.equal(day.headers.get("content-type"), "image/png");
  assert.equal(await sha256Hex(day.data), r.review.payload.images.day.sha256);
});

// ---- scenario 2: normal and halloween are independent -----------------------------

test("halloween variant is stored separately and never overwrites the normal pair", async () => {
  const app = createApp();
  const n = await approved(app, { theme: "normal" });
  const nPub = await publish(app, n);
  const checkinId = nPub.data.checkinId;
  const normalBefore = [...app.media.objects.entries()].filter(([k]) => k.startsWith(`media/${n.revisionId}/`)).map(([k, o]) => [k, [...o.bytes]]);

  const h = await approved(app, { theme: "halloween", extra: { linkCheckinId: checkinId, differences: ["pumpkin added"] } });
  const hPub = await publish(app, h);
  assert.equal(hPub.status, 201);
  assert.equal(hPub.data.checkinId, checkinId);

  assert.equal(count(app, "hc_checkins"), 1);
  assert.equal(count(app, "hc_variants"), 2);
  const list = (await app.call("GET", "/api/checkins", { auth: null })).data.checkins[0];
  assert.deepEqual(list.variants.map((v) => v.theme).sort(), ["halloween", "normal"]);
  assert.notEqual(list.variants[0].day, list.variants[1].day);
  const normalAfter = [...app.media.objects.entries()].filter(([k]) => k.startsWith(`media/${n.revisionId}/`)).map(([k, o]) => [k, [...o.bytes]]);
  assert.deepEqual(normalAfter, normalBefore);

  // a second halloween variant for the same check-in is refused (no replacement in MVP)
  const dup = await registerSynthetic(app, { theme: "halloween", extra: { linkCheckinId: checkinId } });
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error, "variant_exists");
});

// ---- scenario 3: changes invalidate approval -------------------------------------

test("a new revision supersedes an approved one; the old approval cannot publish", async () => {
  const app = createApp();
  const r = await approved(app, { text: "first text" });
  const next = await registerSynthetic(app, { draftId: r.draftId, text: "first text!" });
  assert.equal(next.status, 201);
  assert.notEqual(next.data.payloadHash, r.payloadHash);
  const res = await publish(app, r);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "revision_superseded");
  assert.equal(count(app, "hc_checkins"), 0);
});

test("approving or publishing with a stale or wrong hash is refused", async () => {
  const app = createApp();
  const r = await reviewReady(app);
  const bad = await app.call("POST", `/api/revisions/${r.revisionId}/approve`, { body: { payloadHash: "0".repeat(64), attestation: "trusted-agent-attestation" } });
  assert.equal(bad.status, 409);
  assert.equal(bad.data.error, "hash_mismatch");
  const noAttest = await app.call("POST", `/api/revisions/${r.revisionId}/approve`, { body: { payloadHash: r.payloadHash, attestation: "human-clicked" } });
  assert.equal(noAttest.status, 400);

  const ap = await app.call("POST", `/api/revisions/${r.revisionId}/approve`, { body: { payloadHash: r.payloadHash, attestation: "trusted-agent-attestation" } });
  const res = await publish(app, { ...r, approvalId: ap.data.approvalId }, newKey(), { payloadHash: "f".repeat(64) });
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "hash_mismatch");
  assert.equal(count(app, "hc_checkins"), 0);
});

// ---- authorization gates --------------------------------------------------------

test("publishing without, with expired, or with revoked approval is refused", async () => {
  const app = createApp();
  const r = await approved(app);

  const none = await publish(app, { ...r, approvalId: undefined });
  assert.equal(none.status, 403);
  assert.equal(none.data.error, "approval_not_found");

  const wrong = await publish(app, { ...r, approvalId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(wrong.status, 403);

  const rev = await app.call("POST", `/api/approvals/${r.approvalId}/revoke`);
  assert.equal(rev.status, 200);
  const revoked = await publish(app, r);
  assert.equal(revoked.status, 409);
  assert.equal(revoked.data.error, "approval_revoked");

  // a fresh approval works, then expires
  const ap = await app.call("POST", `/api/revisions/${r.revisionId}/approve`, { body: { payloadHash: r.payloadHash, attestation: "trusted-agent-attestation" } });
  assert.equal(ap.status, 201);
  app.now.value += 31 * 60 * 1000;
  const expired = await publish(app, { ...r, approvalId: ap.data.approvalId });
  assert.equal(expired.status, 409);
  assert.equal(expired.data.error, "approval_expired");
  assert.equal(count(app, "hc_checkins"), 0);
});

test("a draft cannot be published before it is approved", async () => {
  const app = createApp();
  const r = await reviewReady(app);
  const res = await publish(app, { ...r, approvalId: "00000000-0000-4000-8000-000000000000" });
  assert.notEqual(res.status, 201);
  assert.equal(count(app, "hc_checkins"), 0);
});

test("approval requires both images to be uploaded", async () => {
  const app = createApp();
  const reg = await registerSynthetic(app);
  await app.call("PUT", `/api/revisions/${reg.data.revisionId}/media/day`, { bytes: reg.pair.day });
  const res = await app.call("POST", `/api/revisions/${reg.data.revisionId}/approve`, { body: { payloadHash: reg.data.payloadHash, attestation: "trusted-agent-attestation" } });
  assert.equal(res.status, 409);
});

// ---- scenario 4: duplicates, retries -----------------------------------------------

test("double publish with the same key, a different key, and in parallel yields one record", async () => {
  const app = createApp();
  const r = await approved(app);
  const key = newKey();
  const [a, b] = await Promise.all([publish(app, r, key), publish(app, r, key)]);
  assert.deepEqual([a.status, b.status].sort(), [200, 201]);
  assert.equal(a.data.checkinId, b.data.checkinId);

  const again = await publish(app, r, key);
  assert.equal(again.status, 200);
  assert.equal(again.data.replay, true);

  const otherKey = await publish(app, r, newKey());
  assert.equal(otherKey.status, 200);
  assert.equal(otherKey.data.checkinId, a.data.checkinId);

  assert.equal(count(app, "hc_checkins"), 1);
  assert.equal(count(app, "hc_variants"), 1);
  assert.equal(count(app, "hc_operations"), 1);
});

test("the same key with a different payload is a conflict", async () => {
  const app = createApp();
  const r = await approved(app);
  const key = newKey();
  assert.equal((await publish(app, r, key)).status, 201);
  const conflict = await publish(app, r, key, { payloadHash: "e".repeat(64) });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error, "idempotency_conflict");

  const other = await approved(app, { text: "another place" });
  const conflict2 = await publish(app, other, key);
  assert.equal(conflict2.status, 409);
  assert.equal(conflict2.data.error, "idempotency_conflict");
});

test("replay after the approval window returns the existing result with no new side effects", async () => {
  const app = createApp();
  const r = await approved(app);
  const key = newKey();
  const first = await publish(app, r, key);
  app.now.value += 24 * 3600 * 1000;
  const replay = await publish(app, r, key);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.checkinId, first.data.checkinId);
  assert.equal(count(app, "hc_checkins"), 1);
});

test("revoking after publication reports the real state and changes nothing", async () => {
  const app = createApp();
  const r = await approved(app);
  await publish(app, r);
  const res = await app.call("POST", `/api/approvals/${r.approvalId}/revoke`);
  assert.equal(res.status, 409);
  assert.equal(res.data.error, "already_started");
  assert.equal(count(app, "hc_variants"), 1);
});

test("bad idempotency keys are rejected", async () => {
  const app = createApp();
  const r = await approved(app);
  const res = await publish(app, r, "short");
  assert.equal(res.status, 400);
});

// ---- scenario 5: partial failure --------------------------------------------------

test("object store failure on the second image leaves nothing public and recovers", async () => {
  const media = createBucket();
  const app = createApp({ media });
  const reg = await registerSynthetic(app);
  const id = reg.data.revisionId;
  media.faults.failPutAfter = 1; // first put ok, second fails
  const day = await app.call("PUT", `/api/revisions/${id}/media/day`, { bytes: reg.pair.day });
  assert.equal(day.status, 200);
  const night = await app.call("PUT", `/api/revisions/${id}/media/night`, { bytes: reg.pair.night });
  assert.equal(night.status, 500);

  const review = await app.call("GET", `/api/revisions/${id}`);
  assert.equal(review.data.state, "preparing");
  assert.equal((await app.call("GET", "/api/checkins", { auth: null })).data.checkins.length, 0);
  assert.equal((await app.call("GET", `/media/${id}/day.png`, { auth: null })).status, 404, "uploaded but unpublished media stays private");

  media.faults.failPutAfter = Infinity;
  const retry = await app.call("PUT", `/api/revisions/${id}/media/night`, { bytes: reg.pair.night });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.state, "review_ready");
});

test("database failure before commit leaves no visible record; the same key finishes it once", async () => {
  const app = createApp();
  const r = await approved(app);
  const key = newKey();
  app.db.faults.batchBeforeCommit = 1;
  const failed = await publish(app, r, key);
  assert.equal(failed.status, 503);
  assert.equal(failed.data.error, "commit_uncertain");
  assert.equal(failed.data.state, "pending");
  assert.equal(count(app, "hc_checkins"), 0);
  assert.equal((await app.call("GET", "/api/checkins", { auth: null })).data.checkins.length, 0);
  assert.equal((await app.call("GET", `/media/${r.revisionId}/day.png`, { auth: null })).status, 404);

  const op = await app.call("GET", `/api/operations/${failed.data.operationId}`);
  assert.equal(op.data.state, "pending");

  const recovered = await publish(app, r, key);
  assert.equal(recovered.status, 200);
  assert.equal(recovered.data.state, "published");
  assert.equal(count(app, "hc_checkins"), 1);
  assert.equal(count(app, "hc_variants"), 1);
});

test("lost response after a real commit: retry with the same key reports published, no duplicate", async () => {
  const app = createApp();
  const r = await approved(app);
  const key = newKey();
  app.db.faults.batchAfterCommit = 1;
  const lost = await publish(app, r, key);
  assert.equal(lost.status, 503);
  // reality check through the status endpoint before retrying
  const op = await app.call("GET", `/api/operations/${lost.data.operationId}`);
  assert.equal(op.data.state, "published");
  const retry = await publish(app, r, key);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.checkinId, op.data.checkinId);
  assert.equal(count(app, "hc_checkins"), 1);
});

// ---- scenario 6: hostile / malformed input ----------------------------------------

test("media upload rejects wrong content, wrong hash, wrong size and bad slots", async () => {
  const app = createApp();
  const reg = await registerSynthetic(app);
  const id = reg.data.revisionId;
  const put = (slot, bytes) => app.call("PUT", `/api/revisions/${id}/media/${slot}`, { bytes });

  assert.equal((await put("day", reg.pair.night)).status, 422, "night bytes in the day slot");
  assert.equal((await put("day", new TextEncoder().encode("not a png"))).status, 422);
  const flipped = new Uint8Array(reg.pair.day);
  flipped[flipped.length - 20] ^= 0xff;
  assert.equal((await put("day", flipped)).status, 422);
  assert.equal((await app.call("PUT", `/api/revisions/${id}/media/side`, { bytes: reg.pair.day })).status, 404);
  assert.equal(app.media.objects.size, 0, "nothing stored from rejected uploads");
});

test("registering rejects unknown fields, bad themes and a failed validator report", async () => {
  const app = createApp();
  const base = await registerSynthetic(app);
  const images = base.images;
  const v = { version: "pair-validator/1", passed: true };
  const post = (body) => app.call("POST", "/api/revisions", { body });
  assert.equal((await post({ text: "x", images, validator: v, ownerId: "evil" })).status, 400);
  assert.equal((await post({ text: "x", images, validator: v, theme: "christmas" })).status, 400);
  assert.equal((await post({ text: "x", images, validator: { version: "v", passed: false } })).status, 400);
  assert.equal((await post({ text: "x", images, validator: v, place: { city: "Somewhere" } })).status, 400);
  const bad = await app.call("POST", "/api/revisions", { headers: { "content-type": "application/json" }, bytes: new TextEncoder().encode("{oops") });
  assert.equal(bad.status, 400);
});

// ---- scenario 7: authorization ----------------------------------------------------

test("anonymous and wrong-token writes are rejected", async () => {
  const app = createApp();
  const reg = await registerSynthetic(app);
  const id = reg.data.revisionId;
  for (const auth of [null, "wrong-token"]) {
    assert.equal((await app.call("POST", "/api/revisions", { auth, body: {} })).status, 401);
    assert.equal((await app.call("PUT", `/api/revisions/${id}/media/day`, { auth, bytes: reg.pair.day })).status, 401);
    assert.equal((await app.call("GET", `/api/revisions/${id}`, { auth })).status, 401);
    assert.equal((await app.call("POST", `/api/revisions/${id}/approve`, { auth, body: {} })).status, 401);
  }
});

test("another owner cannot read, upload to, approve or publish someone else's draft", async () => {
  const db = createD1();
  const media = createBucket();
  const mine = createApp({ db, media, ownerId: "owner-a" });
  const theirs = createApp({ db, media, ownerId: "owner-b" });
  const r = await approved(mine);
  const get = await theirs.call("GET", `/api/revisions/${r.revisionId}`);
  assert.equal(get.status, 404);
  assert.equal((await theirs.call("PUT", `/api/revisions/${r.revisionId}/media/day`, { bytes: r.pair.day })).status, 404);
  assert.equal((await theirs.call("POST", `/api/revisions/${r.revisionId}/approve`, { body: { payloadHash: r.payloadHash, attestation: "trusted-agent-attestation" } })).status, 404);
  const res = await publish(theirs, r);
  assert.equal(res.status, 404);
  assert.equal((await theirs.call("POST", `/api/approvals/${r.approvalId}/revoke`)).status, 404);
  assert.equal((await theirs.call("POST", `/api/drafts/${r.draftId}/cancel`)).status, 404);
  assert.equal(count(mine, "hc_checkins"), 0);
});

test("the owner is taken from server configuration, not from the request", async () => {
  const app = createApp();
  const reg = await registerSynthetic(app, { extra: {} });
  assert.equal(reg.status, 201);
  const row = app.db.sqlite.prepare("SELECT owner_id FROM hc_drafts").get();
  assert.equal(row.owner_id, "owner");
});

// ---- privacy ------------------------------------------------------------------------

test("public responses expose only the published projection", async () => {
  const app = createApp({ ownerId: "secret-owner-id" });
  const r = await approved(app, { extra: { differences: ["roof simplified"], place: { name: "Synthetic Cafe" } } });
  await publish(app, r);
  const list = await app.call("GET", "/api/checkins", { auth: null });
  const text = JSON.stringify(list.data);
  for (const forbidden of ["secret-owner-id", '"media/', "validator", "approval", r.approvalId, r.payloadHash, TOKEN, "day_key"]) {
    assert.ok(!text.includes(forbidden), `public list leaks ${forbidden}`);
  }
  assert.equal(list.data.checkins[0].place.name, "Synthetic Cafe");
  assert.equal(list.data.checkins[0].capturedAt, null, "unknown capture time stays null");
  assert.equal(list.data.checkins[0].variants[0].differences[0], "roof simplified");
});

test("unpublished media is not reachable by guessing ids", async () => {
  const app = createApp();
  const r = await approved(app);
  assert.equal((await app.call("GET", `/media/${r.revisionId}/day.png`, { auth: null })).status, 404);
  assert.equal((await app.call("GET", `/media/${r.revisionId}/night.png`, { auth: null })).status, 404);
  await publish(app, r);
  assert.equal((await app.call("GET", `/media/${r.revisionId}/night.png`, { auth: null })).status, 200);
});

// ---- cancel and immutability -----------------------------------------------------------

test("cancelled drafts cannot be approved or published; published media is immutable", async () => {
  const app = createApp();
  const r = await reviewReady(app);
  assert.equal((await app.call("POST", `/api/drafts/${r.draftId}/cancel`)).status, 200);
  const ap = await app.call("POST", `/api/revisions/${r.revisionId}/approve`, { body: { payloadHash: r.payloadHash, attestation: "trusted-agent-attestation" } });
  assert.equal(ap.status, 409);

  const p = await approved(app, { text: "other" });
  await publish(app, p);
  const reupload = await app.call("PUT", `/api/revisions/${p.revisionId}/media/day`, { bytes: p.pair.day });
  assert.equal(reupload.status, 409, "published draft is closed to changes");
});

test("a database batch is atomic: a failing statement leaves no partial rows", async () => {
  const app = createApp();
  const r = await approved(app);
  // Break the commit from inside: a pre-existing variant row for this revision id would normally
  // be treated as already published, so instead force a constraint failure on hc_checkins.
  app.db.sqlite.exec(`CREATE TRIGGER block_variants BEFORE INSERT ON hc_variants BEGIN SELECT RAISE(ABORT, 'forced'); END`);
  const key = newKey();
  const failed = await publish(app, r, key);
  assert.equal(failed.status, 503);
  assert.equal(count(app, "hc_checkins"), 0, "checkin row rolled back with the failed batch");
  app.db.sqlite.exec("DROP TRIGGER block_variants");
  assert.equal((await publish(app, r, key)).status, 200);
  assert.equal(count(app, "hc_checkins"), 1);
});
