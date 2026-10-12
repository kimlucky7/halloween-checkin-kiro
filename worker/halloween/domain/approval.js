// Approval binding. An approval is valid only for one revision, one payload
// hash and one target, until it expires or is revoked.

export const ATTESTATION_LEVELS = ["trusted-agent-attestation"];
export const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * Decide whether a new publication may start for this approval.
 * Replay of an already-started operation is handled by the idempotency layer
 * and does not go through this check.
 */
export function checkApprovalForPublish({ approval, revision, expectedHash, target, now }) {
  if (!approval) return refuse("approval_not_found");
  if (approval.revisionId !== revision.id) return refuse("revision_mismatch");
  if (approval.payloadHash !== revision.payloadHash) return refuse("hash_mismatch");
  if (expectedHash !== revision.payloadHash) return refuse("hash_mismatch");
  if (approval.revokedAt) return refuse("approval_revoked");
  if (Date.parse(approval.expiresAt) <= now) return refuse("approval_expired");
  if (approval.target?.project !== target.project || approval.target?.visibility !== target.visibility) {
    return refuse("target_mismatch");
  }
  if (revision.payload.project !== target.project) return refuse("target_mismatch");
  if (!revision.validationPassed) return refuse("validation_failed");
  return { ok: true };
}

function refuse(reason) {
  return { ok: false, reason };
}
