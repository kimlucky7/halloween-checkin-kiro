// HTTP surface. Writes require the owner's bearer token; reads of /api/checkins
// and /media/* are public but only expose committed, published records.

import { tokenMatches } from "./auth.js";
import { MAX_IMAGE_BYTES, ValidationError } from "./domain/schema.js";
import { TransitionError } from "./domain/state.js";
import { createService, HttpError } from "./service.js";

const MAX_JSON_BYTES = 64 * 1024;
const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...JSON_HEADERS, ...headers } });
}

async function authenticate(request, env) {
  const header = request.headers.get("authorization") ?? "";
  const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!env.OWNER_TOKEN || !(await tokenMatches(provided, env.OWNER_TOKEN))) return null;
  // The owner id comes from server configuration bound to the credential,
  // never from the request body or headers.
  return { ownerId: env.OWNER_ID || "owner" };
}

async function readJson(request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_JSON_BYTES) throw new HttpError(413, "body_too_large");
  const text = await request.text();
  if (text.length > MAX_JSON_BYTES) throw new HttpError(413, "body_too_large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "bad_json");
  }
}

async function readBytes(request) {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_IMAGE_BYTES) throw new HttpError(413, "body_too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, "body_too_large");
  return bytes;
}

export function createHandler({ serviceFor }) {
  return async function handle(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    try {
      const isApi = pathname.startsWith("/api/") || pathname.startsWith("/media/");
      if (!isApi) return env.ASSETS.fetch(request);

      const service = serviceFor(env);

      // ---- public reads
      if (pathname === "/api/checkins") {
        if (method !== "GET") return json(405, { error: "method_not_allowed" });
        return json(200, { checkins: await service.listPublic() }, { "cache-control": "public, max-age=30" });
      }
      const mediaMatch = pathname.match(/^\/media\/([0-9a-f-]{36})\/(day|night)\.png$/);
      if (mediaMatch) {
        if (method !== "GET" && method !== "HEAD") return json(405, { error: "method_not_allowed" });
        const object = await service.getPublicMedia(mediaMatch[1], mediaMatch[2]);
        if (!object) return json(404, { error: "not_found" });
        return new Response(method === "HEAD" ? null : object.body, {
          headers: {
            "content-type": "image/png",
            "cache-control": "public, max-age=31536000, immutable",
            "x-content-type-options": "nosniff",
          },
        });
      }

      // ---- authenticated writes and private reads
      const principal = await authenticate(request, env);
      if (!principal) {
        return json(401, { error: "unauthorized" }, { "www-authenticate": 'Bearer realm="halloween-checkin"' });
      }
      const { ownerId } = principal;
      let m;

      if (pathname === "/api/revisions" && method === "POST") {
        return json(201, await service.createRevision(ownerId, await readJson(request)));
      }
      if ((m = pathname.match(/^\/api\/revisions\/([0-9a-f-]{36})$/)) && method === "GET") {
        return json(200, await service.getReview(ownerId, m[1]));
      }
      if ((m = pathname.match(/^\/api\/revisions\/([0-9a-f-]{36})\/media\/(day|night)$/)) && method === "PUT") {
        return json(200, await service.putMedia(ownerId, m[1], m[2], await readBytes(request)));
      }
      if ((m = pathname.match(/^\/api\/revisions\/([0-9a-f-]{36})\/approve$/)) && method === "POST") {
        return json(201, await service.approve(ownerId, m[1], await readJson(request)));
      }
      if ((m = pathname.match(/^\/api\/revisions\/([0-9a-f-]{36})\/publish$/)) && method === "POST") {
        const body = await readJson(request);
        const result = await service.publish(ownerId, m[1], {
          idempotencyKey: request.headers.get("idempotency-key"),
          payloadHash: body.payloadHash,
          approvalId: body.approvalId,
        });
        return json(result.replay ? 200 : 201, result);
      }
      if ((m = pathname.match(/^\/api\/approvals\/([0-9a-f-]{36})\/revoke$/)) && method === "POST") {
        return json(200, await service.revoke(ownerId, m[1]));
      }
      if ((m = pathname.match(/^\/api\/drafts\/([0-9a-f-]{36})\/cancel$/)) && method === "POST") {
        return json(200, await service.cancelDraft(ownerId, m[1]));
      }
      if ((m = pathname.match(/^\/api\/operations\/([0-9a-f-]{36})$/)) && method === "GET") {
        return json(200, await service.getOperation(ownerId, m[1]));
      }
      return json(404, { error: "not_found" });
    } catch (error) {
      if (error instanceof HttpError) {
        return json(error.status, { error: error.code, detail: error.detail || undefined, ...error.extra });
      }
      if (error instanceof ValidationError) return json(400, { error: "invalid_input", issues: error.issues });
      if (error instanceof TransitionError) return json(409, { error: "invalid_transition", detail: error.message });
      console.error("unhandled error:", error?.name, error?.message);
      return json(500, { error: "internal_error" });
    }
  };
}

export function serviceForEnv(env) {
  if (!env.DB || !env.MEDIA) throw new HttpError(503, "storage_not_configured");
  if (!env.PROJECT_ID) throw new HttpError(503, "project_not_configured");
  return createService({
    db: env.DB,
    media: env.MEDIA,
    project: env.PROJECT_ID,
    approvalTtlMs: env.APPROVAL_TTL_MS ? Number(env.APPROVAL_TTL_MS) : undefined,
  });
}

export function createWorkerHandler() {
  return createHandler({ serviceFor: serviceForEnv });
}
