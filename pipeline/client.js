// Minimal API client used by the skill's CLI. `fetchImpl` is injectable so tests
// can run the real router in-process. The token is only ever placed in the
// Authorization header; it is never logged or returned.

export class ApiError extends Error {
  constructor(status, body) {
    super(`API ${status}: ${body?.error ?? "error"}${body?.detail ? " - " + body.detail : ""}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export function createClient({ baseUrl, token, fetchImpl = fetch }) {
  if (!baseUrl) throw new Error("HC_API_URL is not set");
  if (!token) throw new Error("HC_TOKEN is not set (configure it in the environment; never paste it into chat)");
  const base = baseUrl.replace(/\/+$/, "");

  async function request(method, path, { json, bytes, headers = {} } = {}) {
    const h = { authorization: `Bearer ${token}`, ...headers };
    let body;
    if (json !== undefined) { body = JSON.stringify(json); h["content-type"] = "application/json"; }
    else if (bytes) { body = bytes; h["content-type"] = "image/png"; }
    const res = await fetchImpl(base + path, { method, headers: h, body });
    const text = await res.text();
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { error: "non_json_response" }; }
    if (!res.ok) throw new ApiError(res.status, parsed);
    return { status: res.status, body: parsed };
  }

  return {
    baseUrl: base,
    register: (input) => request("POST", "/api/revisions", { json: input }).then((r) => r.body),
    putMedia: (revisionId, slot, bytes) => request("PUT", `/api/revisions/${revisionId}/media/${slot}`, { bytes }).then((r) => r.body),
    getReview: (revisionId) => request("GET", `/api/revisions/${revisionId}`).then((r) => r.body),
    approve: (revisionId, payloadHash) =>
      request("POST", `/api/revisions/${revisionId}/approve`, { json: { payloadHash, attestation: "trusted-agent-attestation" } }).then((r) => r.body),
    revoke: (approvalId) => request("POST", `/api/approvals/${approvalId}/revoke`).then((r) => r.body),
    publish: (revisionId, { idempotencyKey, payloadHash, approvalId }) =>
      request("POST", `/api/revisions/${revisionId}/publish`, { json: { payloadHash, approvalId }, headers: { "idempotency-key": idempotencyKey } }).then((r) => r.body),
    getOperation: (operationId) => request("GET", `/api/operations/${operationId}`).then((r) => r.body),
    cancel: (draftId) => request("POST", `/api/drafts/${draftId}/cancel`).then((r) => r.body),
    // Public reads: no credentials required, so use a bare request.
    async listPublic() {
      const res = await fetchImpl(base + "/api/checkins");
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      return (await res.json()).checkins;
    },
    async fetchPublicMedia(url) {
      const res = await fetchImpl(url.startsWith("http") ? url : base + url);
      return { status: res.status, contentType: res.headers.get("content-type"), bytes: new Uint8Array(await res.arrayBuffer()) };
    },
  };
}
