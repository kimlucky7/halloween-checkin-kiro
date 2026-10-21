// MCP server for the ChatGPT plugin (streamable HTTP, JSON responses).
// Reached only through the OAuth provider, which puts { ownerId } in ctx.props.
//
// Tools never generate images. They accept final 720×720 PNGs that the skill
// prepared and the user reviewed, and reuse the same service as the HTTP API:
//   submit_checkin_for_review → a review-ready revision; nothing becomes public
//   publish_checkin           → approve that exact revision and publish it (idempotent)
//   get_checkin_status        → state of a revision, for recovery after a timeout
//   list_checkins             → what is public now
import { sha256Hex } from "./domain/canonical.js";
import { MAX_IMAGE_BYTES, ValidationError } from "./domain/schema.js";
import { TransitionError } from "./domain/state.js";
import { downloadFile, FileError } from "./files.js";
import { createService, HttpError } from "./service.js";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const SERVER_INFO = { name: "halloween-checkin", version: "1.0.0" };
const SECURITY = [{ type: "oauth2", scopes: ["checkins.write"] }];

const FILE = {
  type: "object",
  properties: { download_url: { type: "string" }, file_id: { type: "string" }, mime_type: { type: "string" }, file_name: { type: "string" } },
  required: ["download_url"],
  additionalProperties: true,
};
const nullable = (schema) => ({ anyOf: [schema, { type: "null" }] });

export const TOOLS = [
  {
    name: "submit_checkin_for_review",
    title: "Submit a check-in for review",
    description:
      "Register one edition (normal or halloween) of a place for review. Use only after the halloween-checkin skill prepared and validated the exact final pair: two 720×720 transparent RGBA PNG files, day and night. Nothing becomes public. Returns a revision_id and payload_hash to show the user. For the Halloween edition of a place whose normal edition was just submitted, pass that normal revision as link_revision_id.",
    inputSchema: {
      type: "object",
      $defs: { File: FILE },
      properties: {
        theme: { type: "string", enum: ["normal", "halloween"] },
        text: { type: "string", minLength: 1, maxLength: 280, description: 'Public caption, for example "at Sushiro".' },
        place_name: nullable({ type: "string", maxLength: 200 }),
        place_address: nullable({ type: "string", maxLength: 200 }),
        captured_at: nullable({ type: "string", description: "ISO-8601 with a time zone offset, only if known from EXIF or stated by the user." }),
        captured_at_source: nullable({ type: "string", enum: ["exif", "user"] }),
        companions: { type: "array", items: { type: "string", maxLength: 60 }, maxItems: 10 },
        differences: { type: "array", items: { type: "string", maxLength: 300 }, maxItems: 20, description: "Creative additions and notable simplifications, e.g. 'pumpkin added'." },
        link_revision_id: nullable({ type: "string", description: "For a Halloween edition: the normal revision of the same place." }),
        link_checkin_id: nullable({ type: "string", description: "For a Halloween edition of a place that is already published." }),
        validator_version: { type: "string", description: "Version string printed by the skill's prepare script." },
        day_image: { $ref: "#/$defs/File" },
        night_image: { $ref: "#/$defs/File" },
      },
      required: ["theme", "text", "validator_version", "day_image", "night_image"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    securitySchemes: SECURITY,
    _meta: {
      securitySchemes: SECURITY,
      "openai/fileParams": ["day_image", "night_image"],
      "openai/toolInvocation/invoking": "Submitting for review…",
      "openai/toolInvocation/invoked": "Ready for review",
    },
  },
  {
    name: "publish_checkin",
    title: "Publish a reviewed check-in",
    description:
      "Publish one reviewed revision to the public site. Call only after the user, having seen that exact review package, clearly asked to publish it (for example 发布, go, publish). Publish the normal edition before a Halloween edition linked to it. Safe to call again for the same revision: it returns the existing result.",
    inputSchema: {
      type: "object",
      properties: {
        revision_id: { type: "string" },
        payload_hash: { type: "string", description: "The payload_hash returned by submit_checkin_for_review for this revision." },
      },
      required: ["revision_id", "payload_hash"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    securitySchemes: SECURITY,
    _meta: { securitySchemes: SECURITY, "openai/toolInvocation/invoking": "Publishing…", "openai/toolInvocation/invoked": "Published" },
  },
  {
    name: "get_checkin_status",
    title: "Check a revision",
    description: "Read the current state of a revision (review_ready, approved, published …). Use it after a timeout or an unclear result before trying again.",
    inputSchema: { type: "object", properties: { revision_id: { type: "string" } }, required: ["revision_id"], additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    securitySchemes: SECURITY,
    _meta: { securitySchemes: SECURITY },
  },
  {
    name: "list_checkins",
    title: "List published check-ins",
    description: "List the places currently on the public site, with their ids and editions. Use it to find link_checkin_id for adding a Halloween edition to an existing place.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
    securitySchemes: SECURITY,
    _meta: { securitySchemes: SECURITY },
  },
];

const rpcResult = (id, result) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
const toolOk = (data, text) => ({ content: [{ type: "text", text: text ?? JSON.stringify(data) }], structuredContent: data });
const toolErr = (code, detail) => ({ content: [{ type: "text", text: `${code}${detail ? ": " + detail : ""}` }], structuredContent: { ok: false, error: code, detail: detail || undefined }, isError: true });

function siteUrl(request) {
  return new URL(request.url).origin;
}

async function callTool(name, args, { service, ownerId, request, fetchImpl, fileHosts }) {
  const a = args && typeof args === "object" ? args : {};
  switch (name) {
    case "submit_checkin_for_review": {
      const [day, night] = await Promise.all([
        downloadFile(a.day_image, { label: "day_image", maxBytes: MAX_IMAGE_BYTES, fetchImpl, hosts: fileHosts }),
        downloadFile(a.night_image, { label: "night_image", maxBytes: MAX_IMAGE_BYTES, fetchImpl, hosts: fileHosts }),
      ]);
      const place = a.place_name || a.place_address ? { name: a.place_name ?? null, address: a.place_address ?? null } : null;
      const input = {
        theme: a.theme,
        text: a.text,
        place,
        capturedAt: a.captured_at ?? null,
        capturedAtSource: a.captured_at ? a.captured_at_source : null,
        companions: a.companions ?? [],
        differences: a.differences ?? [],
        images: {
          day: { sha256: await sha256Hex(day), bytes: day.length },
          night: { sha256: await sha256Hex(night), bytes: night.length },
        },
        // The skill's prepare script reports pass/fail; it refuses to produce files on failure.
        validator: { version: String(a.validator_version || "unknown"), passed: true },
        ...(a.link_checkin_id ? { linkCheckinId: a.link_checkin_id } : {}),
        ...(a.link_revision_id ? { linkRevisionId: a.link_revision_id } : {}),
      };
      const created = await service.createRevision(ownerId, input);
      await service.putMedia(ownerId, created.revisionId, "day", day);
      const review = await service.putMedia(ownerId, created.revisionId, "night", night);
      const data = {
        ok: true,
        revision_id: review.revisionId,
        payload_hash: review.payloadHash,
        state: review.state,
        theme: review.payload.theme,
        public_fields: {
          text: review.payload.text,
          place: review.payload.place,
          captured_at: review.payload.capturedAt,
          companions: review.payload.companions,
          differences: review.payload.differences,
        },
        images: { day_sha256: review.payload.images.day.sha256, night_sha256: review.payload.images.night.sha256 },
        target: { site: siteUrl(request), visibility: review.payload.visibility },
        link_revision_id: review.linkRevisionId,
        link_checkin_id: review.linkCheckinId,
        next: "Show this package to the user and stop. Publish only after they clearly ask to.",
      };
      return toolOk(data);
    }
    case "publish_checkin": {
      if (typeof a.revision_id !== "string" || typeof a.payload_hash !== "string") return toolErr("bad_arguments", "revision_id and payload_hash are required");
      let review = await service.getReview(ownerId, a.revision_id);
      if (!review.operation) {
        const a0 = review.approval;
        const usable = review.state === "approved" && a0 && !a0.revokedAt && Date.parse(a0.expiresAt) > Date.now();
        if (!usable) {
          if (!["review_ready", "approved"].includes(review.state)) return toolErr("not_ready", `revision is ${review.state}`);
          // The user's explicit request in chat is what this records (trusted-agent-attestation).
          await service.approve(ownerId, a.revision_id, { payloadHash: a.payload_hash, attestation: "trusted-agent-attestation" });
          review = await service.getReview(ownerId, a.revision_id);
        }
      }
      // One key per revision: a retry after a timeout resumes the same publication.
      const result = await service.publish(ownerId, a.revision_id, {
        idempotencyKey: `mcp-${a.revision_id}`,
        payloadHash: a.payload_hash,
        approvalId: review.approval?.id,
      });
      const list = await service.listPublic(siteUrl(request));
      const entry = list.find((c) => c.id === result.checkinId);
      return toolOk({
        ok: true,
        state: result.state,
        checkin_id: result.checkinId,
        replay: result.replay,
        site: siteUrl(request),
        editions: entry ? entry.variants.map((v) => v.theme) : [],
      });
    }
    case "get_checkin_status": {
      if (typeof a.revision_id !== "string") return toolErr("bad_arguments", "revision_id is required");
      const r = await service.getReview(ownerId, a.revision_id);
      return toolOk({ ok: true, revision_id: r.revisionId, state: r.state, theme: r.payload.theme, payload_hash: r.payloadHash, operation: r.operation });
    }
    case "list_checkins": {
      const list = await service.listPublic(siteUrl(request));
      return toolOk({
        ok: true,
        checkins: list.map((c) => ({ id: c.id, place: c.place.name, text: c.text, published_at: c.publishedAt, editions: c.variants.map((v) => v.theme) })),
      });
    }
    default:
      return null;
  }
}

/**
 * @param {{ serviceFor: (env) => ReturnType<typeof createService>, fetchImpl?: typeof fetch, fileHosts?: string[] }} options
 */
export function createMcpHandler({ serviceFor, fetchImpl = (...args) => fetch(...args), fileHosts } = {}) {
  return {
    async fetch(request, env, ctx) {
      if (request.method === "GET" || request.method === "DELETE") {
        // No server-initiated stream and no sessions.
        return new Response(null, { status: 405, headers: { allow: "POST" } });
      }
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      const ownerId = ctx?.props?.ownerId;
      if (!ownerId) return Response.json(rpcError(null, -32001, "unauthorized"), { status: 401 });

      let message;
      try {
        message = await request.json();
      } catch {
        return Response.json(rpcError(null, -32700, "parse error"), { status: 400 });
      }
      const batch = Array.isArray(message);
      const replies = [];
      for (const m of batch ? message : [message]) {
        const reply = await handleMessage(m, { env, ownerId, request, serviceFor, fetchImpl, fileHosts });
        if (reply) replies.push(reply);
      }
      if (!replies.length) return new Response(null, { status: 202 });
      return Response.json(batch ? replies : replies[0], { headers: { "cache-control": "no-store" } });
    },
  };
}

async function handleMessage(m, { env, ownerId, request, serviceFor, fetchImpl, fileHosts }) {
  if (!m || m.jsonrpc !== "2.0" || typeof m.method !== "string") return rpcError(m?.id ?? null, -32600, "invalid request");
  const isNotification = m.id === undefined || m.id === null;
  if (isNotification) return null;
  switch (m.method) {
    case "initialize": {
      const asked = m.params?.protocolVersion;
      return rpcResult(m.id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: "Halloween Check-in publishing. Use with the halloween-checkin skill. Tools never generate images.",
      });
    }
    case "ping":
      return rpcResult(m.id, {});
    case "tools/list":
      return rpcResult(m.id, { tools: TOOLS });
    case "tools/call": {
      const name = m.params?.name;
      if (!TOOLS.some((t) => t.name === name)) return rpcError(m.id, -32602, `unknown tool ${name}`);
      try {
        const service = serviceFor(env);
        return rpcResult(m.id, await callTool(name, m.params?.arguments, { service, ownerId, request, fetchImpl, fileHosts }));
      } catch (error) {
        if (error instanceof HttpError) return rpcResult(m.id, toolErr(error.code, error.detail));
        if (error instanceof ValidationError) return rpcResult(m.id, toolErr("invalid_input", error.issues.map((i) => `${i.field} ${i.message}`).join("; ")));
        if (error instanceof TransitionError) return rpcResult(m.id, toolErr("invalid_transition", error.message));
        if (error instanceof FileError) return rpcResult(m.id, toolErr(error.code, error.message));
        console.error("mcp tool error:", error?.name, error?.message);
        return rpcResult(m.id, toolErr("internal_error", "check get_checkin_status before retrying"));
      }
    }
    default:
      return rpcError(m.id, -32601, `method not found: ${m.method}`);
  }
}
