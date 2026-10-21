// Review, approval and publication service. Storage is injected (D1-compatible
// `db`, R2-compatible `media`) so the same code runs in the Worker and in tests.
//
// Guarantees implemented here:
//  - revisions are immutable; a change creates a new revision
//  - approval binds revision id + payload hash + target, expires, can be revoked
//  - publication is idempotent per (owner, key) and happens at most once per revision
//  - media is written first, the visible record is a single atomic D1 batch
//  - an uncertain publication leaves a `pending` operation that the same
//    idempotency key resumes; nothing is visible until the batch commits

import { checkFinalPng } from "./png.js";
import { computePayloadHash, sha256Hex } from "./domain/canonical.js";
import { checkApprovalForPublish, ATTESTATION_LEVELS, DEFAULT_APPROVAL_TTL_MS } from "./domain/approval.js";
import { MAX_IMAGE_BYTES, SLOTS, ValidationError, validateRevisionInput } from "./domain/schema.js";
import { transition } from "./domain/state.js";

export class HttpError extends Error {
  constructor(status, code, detail = "", extra = {}) {
    super(`${code}${detail ? ": " + detail : ""}`);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.detail = detail;
    this.extra = extra;
  }
}

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const mediaKey = (revisionId, slot) => `media/${revisionId}/${slot}.png`;
const iso = (ms) => new Date(ms).toISOString();

export function createService({
  db,
  media,
  project,
  clock = () => Date.now(),
  approvalTtlMs = DEFAULT_APPROVAL_TTL_MS,
  newId = () => crypto.randomUUID(),
}) {
  if (!project) throw new Error("project id is required");
  const target = { project, visibility: "public" };

  async function one(sql, ...params) {
    return db.prepare(sql).bind(...params).first();
  }
  async function all(sql, ...params) {
    return (await db.prepare(sql).bind(...params).all()).results;
  }

  async function loadOwned(ownerId, revisionId) {
    const row = await one(
      `SELECT r.*, d.owner_id AS owner_id, d.state AS draft_state, d.current_revision_id AS current_revision_id
         FROM hc_revisions r JOIN hc_drafts d ON d.id = r.draft_id WHERE r.id = ?`,
      revisionId,
    );
    // Same response for "missing" and "someone else's": do not reveal existence.
    if (!row || row.owner_id !== ownerId) throw new HttpError(404, "not_found");
    return row;
  }

  function requireEditable(row) {
    if (["published", "cancelled"].includes(row.draft_state)) {
      throw new HttpError(409, "draft_closed", `draft is ${row.draft_state}`);
    }
    if (row.current_revision_id !== row.id) {
      throw new HttpError(409, "revision_superseded", "a newer revision exists");
    }
  }

  async function reviewPackage(row) {
    const approval = await one(
      "SELECT * FROM hc_approvals WHERE revision_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      row.id,
    );
    const op = await one("SELECT * FROM hc_operations WHERE revision_id = ?", row.id);
    return {
      draftId: row.draft_id,
      revisionId: row.id,
      seq: row.seq,
      state: row.draft_state,
      current: row.current_revision_id === row.id,
      payload: JSON.parse(row.payload_json),
      payloadHash: row.payload_hash,
      linkCheckinId: row.link_checkin_id,
      linkRevisionId: row.link_revision_id ?? null,
      media: { day: { uploaded: !!row.day_uploaded }, night: { uploaded: !!row.night_uploaded } },
      approval: approval
        ? { id: approval.id, expiresAt: approval.expires_at, revokedAt: approval.revoked_at, payloadHash: approval.payload_hash }
        : null,
      operation: op ? { id: op.id, state: op.state, checkinId: op.checkin_id } : null,
    };
  }

  return {
    HttpError,

    async createRevision(ownerId, body) {
      const { draftId = null, ...input } = body && typeof body === "object" ? body : {};
      const { payload, linkCheckinId, linkRevisionId } = validateRevisionInput(input, { project });
      const payloadHash = await computePayloadHash(payload);
      const now = iso(clock());

      if (linkCheckinId) {
        const target = await one("SELECT owner_id FROM hc_checkins WHERE id = ?", linkCheckinId);
        if (!target || target.owner_id !== ownerId) throw new HttpError(404, "link_target_not_found");
        const taken = await one("SELECT 1 AS x FROM hc_variants WHERE checkin_id = ? AND theme = ?", linkCheckinId, payload.theme);
        if (taken) throw new HttpError(409, "variant_exists", "replacement is not supported; publish a different theme");
      }
      if (linkRevisionId) {
        // The Halloween edition of a place whose normal revision is still under review.
        const partner = await one(
          "SELECT r.theme, d.owner_id FROM hc_revisions r JOIN hc_drafts d ON d.id = r.draft_id WHERE r.id = ?",
          linkRevisionId,
        );
        if (!partner || partner.owner_id !== ownerId) throw new HttpError(404, "link_target_not_found");
        if (partner.theme !== "normal") throw new HttpError(409, "link_target_not_normal");
      }

      let id = draftId;
      let seq = 1;
      const statements = [];
      if (id) {
        const draft = await one("SELECT * FROM hc_drafts WHERE id = ?", id);
        if (!draft || draft.owner_id !== ownerId) throw new HttpError(404, "not_found");
        if (["published", "cancelled"].includes(draft.state)) throw new HttpError(409, "draft_closed", `draft is ${draft.state}`);
        const max = await one("SELECT MAX(seq) AS m FROM hc_revisions WHERE draft_id = ?", id);
        seq = (max?.m ?? 0) + 1;
      } else {
        id = newId();
        statements.push(
          db.prepare("INSERT INTO hc_drafts (id, owner_id, project, state, current_revision_id, created_at, updated_at) VALUES (?, ?, ?, 'created', NULL, ?, ?)")
            .bind(id, ownerId, project, now, now),
        );
      }
      const revisionId = newId();
      statements.push(
        db.prepare("INSERT INTO hc_revisions (id, draft_id, seq, theme, payload_json, payload_hash, link_checkin_id, link_revision_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(revisionId, id, seq, payload.theme, JSON.stringify(payload), payloadHash, linkCheckinId, linkRevisionId, now),
        // Any older approval stops being usable because only the current revision can publish.
        db.prepare("UPDATE hc_drafts SET current_revision_id = ?, state = 'preparing', updated_at = ? WHERE id = ?")
          .bind(revisionId, now, id),
      );
      await db.batch(statements);
      return reviewPackage(await loadOwned(ownerId, revisionId));
    },

    async putMedia(ownerId, revisionId, slot, bytes) {
      if (!SLOTS.includes(slot)) throw new HttpError(400, "bad_slot");
      const row = await loadOwned(ownerId, revisionId);
      requireEditable(row);
      const expected = JSON.parse(row.payload_json).images[slot];
      if (!(bytes instanceof Uint8Array) || bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
        throw new HttpError(413, "bad_size", `image must be 1..${MAX_IMAGE_BYTES} bytes`);
      }
      if (bytes.length !== expected.bytes) throw new HttpError(422, "bytes_mismatch", "size differs from the registered revision");
      const sha = await sha256Hex(bytes);
      if (sha !== expected.sha256) throw new HttpError(422, "hash_mismatch", "content differs from the registered revision");
      try {
        checkFinalPng(bytes);
      } catch (error) {
        throw new HttpError(422, "invalid_image", String(error.message));
      }

      const key = mediaKey(revisionId, slot);
      const existing = await media.head(key);
      if (existing && existing.customMetadata?.sha256 !== sha) {
        throw new HttpError(409, "media_immutable", "different bytes already stored for this revision");
      }
      if (!existing) {
        await media.put(key, bytes, { httpMetadata: { contentType: "image/png" }, customMetadata: { sha256: sha } });
      }
      const now = iso(clock());
      const column = slot === "day" ? "day_uploaded" : "night_uploaded";
      await db.prepare(`UPDATE hc_revisions SET ${column} = 1 WHERE id = ?`).bind(revisionId).run();
      const fresh = await loadOwned(ownerId, revisionId);
      if (fresh.day_uploaded && fresh.night_uploaded && fresh.draft_state === "preparing") {
        await db.prepare("UPDATE hc_drafts SET state = ?, updated_at = ? WHERE id = ?")
          .bind(transition("preparing", "media_complete"), now, fresh.draft_id).run();
      }
      return reviewPackage(await loadOwned(ownerId, revisionId));
    },

    async getReview(ownerId, revisionId) {
      return reviewPackage(await loadOwned(ownerId, revisionId));
    },

    async cancelDraft(ownerId, draftId) {
      const draft = await one("SELECT * FROM hc_drafts WHERE id = ?", draftId);
      if (!draft || draft.owner_id !== ownerId) throw new HttpError(404, "not_found");
      if (["publishing", "published", "cancelled"].includes(draft.state)) {
        throw new HttpError(409, "cannot_cancel", `draft is ${draft.state}`);
      }
      await db.prepare("UPDATE hc_drafts SET state = 'cancelled', updated_at = ? WHERE id = ?").bind(iso(clock()), draftId).run();
      return { draftId, state: "cancelled" };
    },

    async approve(ownerId, revisionId, { payloadHash, attestation } = {}) {
      const row = await loadOwned(ownerId, revisionId);
      requireEditable(row);
      if (!["review_ready", "approved"].includes(row.draft_state)) {
        throw new HttpError(409, "not_review_ready", `draft is ${row.draft_state}`);
      }
      if (!row.day_uploaded || !row.night_uploaded) throw new HttpError(409, "media_incomplete");
      if (payloadHash !== row.payload_hash) throw new HttpError(409, "hash_mismatch", "approve the hash of the exact package you reviewed");
      if (!ATTESTATION_LEVELS.includes(attestation)) {
        throw new HttpError(400, "bad_attestation", `attestation must be one of ${ATTESTATION_LEVELS.join(", ")}`);
      }
      const nowMs = clock();
      const approvalId = newId();
      await db.batch([
        db.prepare("INSERT INTO hc_approvals (id, revision_id, payload_hash, owner_id, target_json, trust_level, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(approvalId, revisionId, row.payload_hash, ownerId, JSON.stringify(target), attestation, iso(nowMs), iso(nowMs + approvalTtlMs)),
        db.prepare("UPDATE hc_drafts SET state = 'approved', updated_at = ? WHERE id = ?").bind(iso(nowMs), row.draft_id),
      ]);
      return { approvalId, revisionId, payloadHash: row.payload_hash, expiresAt: iso(nowMs + approvalTtlMs), trustLevel: attestation, target };
    },

    async revoke(ownerId, approvalId) {
      const approval = await one("SELECT * FROM hc_approvals WHERE id = ?", approvalId);
      if (!approval || approval.owner_id !== ownerId) throw new HttpError(404, "not_found");
      const op = await one("SELECT * FROM hc_operations WHERE revision_id = ?", approval.revision_id);
      if (op) {
        // A started publication cannot be raced; report its real state instead.
        throw new HttpError(409, "already_started", `publication is ${op.state}`, { operationId: op.id, state: op.state });
      }
      const now = iso(clock());
      const rev = await loadOwned(ownerId, approval.revision_id);
      const statements = [db.prepare("UPDATE hc_approvals SET revoked_at = COALESCE(revoked_at, ?) WHERE id = ?").bind(now, approvalId)];
      if (rev.draft_state === "approved") {
        statements.push(db.prepare("UPDATE hc_drafts SET state = ?, updated_at = ? WHERE id = ?").bind(transition("approved", "revoke"), now, rev.draft_id));
      }
      await db.batch(statements);
      return { approvalId, revoked: true };
    },

    async publish(ownerId, revisionId, { idempotencyKey, payloadHash, approvalId }) {
      if (typeof idempotencyKey !== "string" || !KEY_PATTERN.test(idempotencyKey)) {
        throw new HttpError(400, "bad_idempotency_key", "16-128 chars of A-Z a-z 0-9 _ -");
      }
      const row = await loadOwned(ownerId, revisionId);

      // 1. Replay / recovery paths never create a new side effect.
      const byKey = await one("SELECT * FROM hc_operations WHERE owner_id = ? AND idempotency_key = ?", ownerId, idempotencyKey);
      if (byKey) {
        if (byKey.revision_id !== revisionId || byKey.payload_hash !== payloadHash) {
          throw new HttpError(409, "idempotency_conflict", "this key was used with a different payload");
        }
        return resume(byKey, row);
      }
      const byRevision = await one("SELECT * FROM hc_operations WHERE revision_id = ?", revisionId);
      if (byRevision) {
        if (byRevision.payload_hash !== payloadHash) throw new HttpError(409, "hash_mismatch");
        return resume(byRevision, row);
      }

      // 2. New publication: every gate must pass.
      requireEditable(row);
      const approval = approvalId ? await one("SELECT * FROM hc_approvals WHERE id = ? AND owner_id = ?", approvalId, ownerId) : null;
      const verdict = checkApprovalForPublish({
        approval: approval && {
          revisionId: approval.revision_id,
          payloadHash: approval.payload_hash,
          revokedAt: approval.revoked_at,
          expiresAt: approval.expires_at,
          target: JSON.parse(approval.target_json),
        },
        revision: {
          id: row.id,
          payloadHash: row.payload_hash,
          payload: JSON.parse(row.payload_json),
          validationPassed: !!row.day_uploaded && !!row.night_uploaded,
        },
        expectedHash: payloadHash,
        target,
        now: clock(),
      });
      if (!verdict.ok) {
        throw new HttpError(verdict.reason === "approval_not_found" ? 403 : 409, verdict.reason);
      }
      if (row.draft_state !== "approved") throw new HttpError(409, "not_approved", `draft is ${row.draft_state}`);

      const payload = JSON.parse(row.payload_json);
      for (const slot of SLOTS) {
        const head = await media.head(mediaKey(revisionId, slot));
        if (!head || head.customMetadata?.sha256 !== payload.images[slot].sha256) {
          throw new HttpError(409, "media_missing", `${slot} image is not stored`);
        }
      }
      const linkId = await resolveLink(row);
      if (row.link_revision_id && !linkId) {
        throw new HttpError(409, "partner_not_published", "publish the normal edition of this place first");
      }
      if (linkId) {
        const taken = await one("SELECT 1 AS x FROM hc_variants WHERE checkin_id = ? AND theme = ?", linkId, payload.theme);
        if (taken) throw new HttpError(409, "variant_exists");
      }

      // 3. Atomic claim. The unique indexes decide a race: the loser re-reads.
      const operationId = newId();
      const now = iso(clock());
      const claim = await db.prepare(
        "INSERT INTO hc_operations (id, owner_id, idempotency_key, revision_id, payload_hash, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT DO NOTHING",
      ).bind(operationId, ownerId, idempotencyKey, revisionId, payloadHash, now, now).run();
      if ((claim.meta?.changes ?? 0) === 0) {
        const winner =
          (await one("SELECT * FROM hc_operations WHERE owner_id = ? AND idempotency_key = ?", ownerId, idempotencyKey)) ??
          (await one("SELECT * FROM hc_operations WHERE revision_id = ?", revisionId));
        if (!winner) throw new HttpError(503, "claim_failed", "retry with the same Idempotency-Key");
        if (winner.payload_hash !== payloadHash) throw new HttpError(409, "idempotency_conflict");
        return resume(winner, await loadOwned(ownerId, revisionId));
      }
      await db.prepare("UPDATE hc_drafts SET state = ?, updated_at = ? WHERE id = ?")
        .bind(transition("approved", "start_publish"), now, row.draft_id).run();
      return commit(await one("SELECT * FROM hc_operations WHERE id = ?", operationId), row, false);
    },

    async getOperation(ownerId, operationId) {
      const op = await one("SELECT * FROM hc_operations WHERE id = ?", operationId);
      if (!op || op.owner_id !== ownerId) throw new HttpError(404, "not_found");
      return operationView(op, false);
    },

    async listPublic(origin = "") {
      const checkins = await all("SELECT * FROM hc_checkins ORDER BY published_at DESC, id DESC LIMIT 200");
      const variants = await all("SELECT * FROM hc_variants ORDER BY published_at ASC");
      return checkins.map((c) => ({
        id: c.id,
        text: c.text,
        place: JSON.parse(c.place_json),
        capturedAt: c.captured_at,
        capturedAtSource: c.captured_at_source,
        companions: JSON.parse(c.companions_json),
        publishedAt: c.published_at,
        variants: variants.filter((v) => v.checkin_id === c.id).map((v) => ({
          theme: v.theme,
          text: v.text,
          differences: JSON.parse(v.differences_json),
          day: `${origin}/media/${v.revision_id}/day.png`,
          night: `${origin}/media/${v.revision_id}/night.png`,
        })),
      }));
    },

    async getPublicMedia(revisionId, slot) {
      if (!SLOTS.includes(slot)) return null;
      // Only objects referenced by a committed variant are public.
      const variant = await one("SELECT day_key, night_key FROM hc_variants WHERE revision_id = ?", revisionId);
      if (!variant) return null;
      return media.get(slot === "day" ? variant.day_key : variant.night_key);
    },
  };

  function operationView(op, replay) {
    return {
      operationId: op.id,
      state: op.state,
      revisionId: op.revision_id,
      checkinId: op.checkin_id,
      replay,
    };
  }

  async function resume(op, row) {
    if (op.state === "published") return operationView(op, true);
    // Pending: an earlier attempt claimed the revision but did not finish.
    return commit(op, row, true);
  }

  // The check-in a revision joins: given directly, or through its published normal partner.
  async function resolveLink(row) {
    if (row.link_checkin_id) return row.link_checkin_id;
    if (!row.link_revision_id) return null;
    const partner = await one("SELECT checkin_id FROM hc_operations WHERE revision_id = ? AND state = 'published'", row.link_revision_id);
    return partner?.checkin_id ?? null;
  }

  async function commit(op, row, replay) {
    const payload = JSON.parse(row.payload_json);
    const linkId = await resolveLink(row);
    const now = iso(clock());
    const already = await one("SELECT checkin_id FROM hc_variants WHERE revision_id = ?", row.id);
    const checkinId = already?.checkin_id ?? linkId ?? `ck-${op.id.replace(/-/g, "").slice(0, 12)}`;
    const statements = [];
    if (!already) {
      if (!linkId) {
        statements.push(
          db.prepare("INSERT OR IGNORE INTO hc_checkins (id, owner_id, text, place_json, captured_at, captured_at_source, companions_json, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(checkinId, op.owner_id, payload.text, JSON.stringify(payload.place), payload.capturedAt, payload.capturedAtSource, JSON.stringify(payload.companions), now),
        );
      }
      statements.push(
        db.prepare("INSERT INTO hc_variants (checkin_id, theme, revision_id, text, differences_json, day_key, night_key, day_sha256, night_sha256, published_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
          .bind(checkinId, payload.theme, row.id, payload.text, JSON.stringify(payload.differences),
            mediaKey(row.id, "day"), mediaKey(row.id, "night"), payload.images.day.sha256, payload.images.night.sha256, now),
      );
    }
    statements.push(
      db.prepare("UPDATE hc_operations SET state = 'published', checkin_id = ?, updated_at = ? WHERE id = ?").bind(checkinId, now, op.id),
      db.prepare("UPDATE hc_drafts SET state = 'published', updated_at = ? WHERE id = ?").bind(now, row.draft_id),
    );
    try {
      await db.batch(statements);
    } catch (error) {
      // Outcome of the batch is not known to this caller. The operation row
      // stays `pending`; the same key resumes it and reads the real state.
      throw new HttpError(503, "commit_uncertain", "check the operation, then retry with the same Idempotency-Key", {
        operationId: op.id,
        state: "pending",
      });
    }
    return operationView({ ...op, state: "published", checkin_id: checkinId }, replay);
  }
}

export { ValidationError };
