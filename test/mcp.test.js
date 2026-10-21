import test from "node:test";
import assert from "node:assert/strict";

import { createD1, createBucket, PROJECT } from "../testkit/harness.js";
import { createService } from "../worker/halloween/service.js";
import { createMcpHandler, TOOLS } from "../worker/halloween/mcp.js";
import { allowedHost, downloadFile } from "../worker/halloween/files.js";
import { d1Kv } from "../worker/halloween/kv-d1.js";
import { syntheticPair } from "../pipeline/synthetic.js";
import { sha256Hex } from "../worker/halloween/domain/canonical.js";

const ORIGIN = "https://site.test";

// A fake file host: ChatGPT-style download URLs serve the bytes registered here.
function fakeFiles() {
  const files = new Map();
  let n = 0;
  const calls = [];
  return {
    calls,
    add(bytes) {
      const url = `https://files.oaiusercontent.com/file-${++n}?sig=x`;
      files.set(url, bytes);
      return { download_url: url, file_id: `file-${n}`, mime_type: "image/png", file_name: `f${n}.png` };
    },
    redirect(from, to) {
      files.set(from, { redirect: to });
    },
    async fetch(url) {
      calls.push(url);
      const hit = files.get(url);
      if (!hit) return new Response("missing", { status: 404 });
      if (hit.redirect) return new Response(null, { status: 302, headers: { location: hit.redirect } });
      return new Response(hit, { status: 200, headers: { "content-length": String(hit.length) } });
    },
  };
}

function setup({ ownerId = "owner", db = createD1(), media = createBucket(), files = fakeFiles() } = {}) {
  const service = createService({ db, media, project: PROJECT });
  const mcp = createMcpHandler({ serviceFor: () => service, fetchImpl: (u, i) => files.fetch(u, i) });
  let id = 0;
  async function rpc(method, params, props = { ownerId }) {
    const res = await mcp.fetch(
      new Request(`${ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }),
      {},
      { props },
    );
    return { status: res.status, body: res.status === 202 ? null : await res.json() };
  }
  const call = async (name, args, props) => (await rpc("tools/call", { name, arguments: args }, props)).body.result;
  return { rpc, call, files, db, media, service };
}

async function submitArgs(files, { theme = "normal", ...over } = {}) {
  const pair = await syntheticPair({ theme });
  return {
    pair,
    args: { theme, text: "at the test cafe", place_name: "Test Cafe", validator_version: "prepare-py/1", day_image: files.add(pair.day), night_image: files.add(pair.night), ...over },
  };
}

test("initialize and tools/list describe the plugin's tools with file params and OAuth", async () => {
  const { rpc } = setup();
  const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.equal(init.body.result.serverInfo.name, "halloween-checkin");
  const list = (await rpc("tools/list")).body.result.tools;
  assert.deepEqual(list.map((t) => t.name), ["submit_checkin_for_review", "publish_checkin", "get_checkin_status", "list_checkins"]);
  const submit = list[0];
  assert.deepEqual(submit._meta["openai/fileParams"], ["day_image", "night_image"]);
  assert.ok(list.every((t) => t.securitySchemes[0].type === "oauth2"));
  assert.equal(list.find((t) => t.name === "list_checkins").annotations.readOnlyHint, true);
  assert.equal(TOOLS.length, 4);
});

test("notifications get 202 and no body", async () => {
  const { files } = setup();
  const service = createService({ db: createD1(), media: createBucket(), project: PROJECT });
  const mcp = createMcpHandler({ serviceFor: () => service, fetchImpl: files.fetch });
  const res = await mcp.fetch(new Request(`${ORIGIN}/mcp`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }), {}, { props: { ownerId: "owner" } });
  assert.equal(res.status, 202);
});

test("requests without an authenticated owner are rejected; GET is not supported", async () => {
  const { rpc } = setup();
  const res = await rpc("tools/list", undefined, {});
  assert.equal(res.status, 401);
  const service = createService({ db: createD1(), media: createBucket(), project: PROJECT });
  const mcp = createMcpHandler({ serviceFor: () => service });
  assert.equal((await mcp.fetch(new Request(`${ORIGIN}/mcp`), {}, { props: { ownerId: "o" } })).status, 405);
});

test("submit registers a review-ready revision and publishes nothing", async () => {
  const s = setup();
  const { args, pair } = await submitArgs(s.files);
  const r = await s.call("submit_checkin_for_review", args);
  assert.equal(r.isError, undefined, JSON.stringify(r));
  const data = r.structuredContent;
  assert.equal(data.state, "review_ready");
  assert.match(data.payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(data.images.day_sha256, await sha256Hex(pair.day));
  assert.equal(data.public_fields.place.name, "Test Cafe");
  assert.equal(data.public_fields.captured_at, null, "unknown capture time stays unknown");
  assert.equal(data.target.site, ORIGIN);
  assert.equal((await s.service.listPublic()).length, 0);
});

test("publish approves and publishes the reviewed revision once; repeating it is a replay", async () => {
  const s = setup();
  const { args } = await submitArgs(s.files);
  const sub = (await s.call("submit_checkin_for_review", args)).structuredContent;
  const pub = await s.call("publish_checkin", { revision_id: sub.revision_id, payload_hash: sub.payload_hash });
  assert.equal(pub.isError, undefined, JSON.stringify(pub));
  assert.equal(pub.structuredContent.state, "published");
  assert.deepEqual(pub.structuredContent.editions, ["normal"]);
  const again = (await s.call("publish_checkin", { revision_id: sub.revision_id, payload_hash: sub.payload_hash })).structuredContent;
  assert.equal(again.replay, true);
  assert.equal(again.checkin_id, pub.structuredContent.checkin_id);
  assert.equal(s.db.sqlite.prepare("SELECT COUNT(*) AS n FROM hc_checkins").get().n, 1);
});

test("publish refuses a wrong payload hash and an unknown revision", async () => {
  const s = setup();
  const { args } = await submitArgs(s.files);
  const sub = (await s.call("submit_checkin_for_review", args)).structuredContent;
  const bad = await s.call("publish_checkin", { revision_id: sub.revision_id, payload_hash: "0".repeat(64) });
  assert.equal(bad.isError, true);
  assert.equal(bad.structuredContent.error, "hash_mismatch");
  const missing = await s.call("publish_checkin", { revision_id: "00000000-0000-4000-8000-000000000000", payload_hash: sub.payload_hash });
  assert.equal(missing.structuredContent.error, "not_found");
  assert.equal(s.db.sqlite.prepare("SELECT COUNT(*) AS n FROM hc_checkins").get().n, 0);
});

test("normal and Halloween editions of one place are reviewed together, then published into one check-in", async () => {
  const s = setup();
  const normal = (await s.call("submit_checkin_for_review", (await submitArgs(s.files)).args)).structuredContent;
  const { args } = await submitArgs(s.files, { theme: "halloween", link_revision_id: normal.revision_id, differences: ["pumpkin added"] });
  const hall = (await s.call("submit_checkin_for_review", args)).structuredContent;
  assert.equal(hall.link_revision_id, normal.revision_id);

  // Halloween first is refused: its place does not exist yet.
  const early = await s.call("publish_checkin", { revision_id: hall.revision_id, payload_hash: hall.payload_hash });
  assert.equal(early.structuredContent.error, "partner_not_published");

  const n = (await s.call("publish_checkin", { revision_id: normal.revision_id, payload_hash: normal.payload_hash })).structuredContent;
  const h = (await s.call("publish_checkin", { revision_id: hall.revision_id, payload_hash: hall.payload_hash })).structuredContent;
  assert.equal(h.state, "published");
  assert.equal(h.checkin_id, n.checkin_id);
  assert.deepEqual(h.editions.sort(), ["halloween", "normal"]);
  const list = (await s.call("list_checkins", {})).structuredContent.checkins;
  assert.equal(list.length, 1);
});

test("link_revision_id must be the owner's normal revision and only for Halloween", async () => {
  const s = setup();
  const normal = (await s.call("submit_checkin_for_review", (await submitArgs(s.files)).args)).structuredContent;
  const wrongTheme = await s.call("submit_checkin_for_review", (await submitArgs(s.files, { link_revision_id: normal.revision_id })).args);
  assert.equal(wrongTheme.structuredContent.error, "invalid_input");
  const other = setup({ db: s.db, media: s.media, files: s.files, ownerId: "someone-else" });
  const foreign = await other.call("submit_checkin_for_review", (await submitArgs(s.files, { theme: "halloween", link_revision_id: normal.revision_id })).args);
  assert.equal(foreign.structuredContent.error, "link_target_not_found");
});

test("another owner cannot see or publish a revision", async () => {
  const s = setup();
  const sub = (await s.call("submit_checkin_for_review", (await submitArgs(s.files)).args)).structuredContent;
  const other = setup({ db: s.db, media: s.media, files: s.files, ownerId: "intruder" });
  assert.equal((await other.call("get_checkin_status", { revision_id: sub.revision_id })).structuredContent.error, "not_found");
  assert.equal((await other.call("publish_checkin", { revision_id: sub.revision_id, payload_hash: sub.payload_hash })).structuredContent.error, "not_found");
});

test("files must be real final PNGs from an allowed host", async () => {
  const s = setup();
  const { args, pair } = await submitArgs(s.files);
  const evil = await s.call("submit_checkin_for_review", { ...args, day_image: { download_url: "https://evil.example/x.png" } });
  assert.equal(evil.structuredContent.error, "host_not_allowed");
  const http = await s.call("submit_checkin_for_review", { ...args, day_image: { download_url: "http://files.oaiusercontent.com/x" } });
  assert.equal(http.structuredContent.error, "host_not_allowed");
  const notPng = await s.call("submit_checkin_for_review", { ...args, day_image: s.files.add(new TextEncoder().encode("hello")) });
  assert.equal(notPng.structuredContent.error, "invalid_image");
  void pair;
});

test("redirects are followed only to allowed hosts", async () => {
  const files = fakeFiles();
  const pair = await syntheticPair();
  const ok = files.add(pair.day);
  files.redirect("https://chatgpt.com/backend/file-9", ok.download_url);
  files.redirect("https://chatgpt.com/backend/file-10", "https://169.254.169.254/latest");
  const bytes = await downloadFile({ download_url: "https://chatgpt.com/backend/file-9" }, { label: "f", maxBytes: 5e6, fetchImpl: files.fetch });
  assert.equal(bytes.length, pair.day.length);
  await assert.rejects(downloadFile({ download_url: "https://chatgpt.com/backend/file-10" }, { label: "f", maxBytes: 5e6, fetchImpl: files.fetch }), /not accepted/);
  await assert.rejects(downloadFile({ download_url: ok.download_url }, { label: "f", maxBytes: 10, fetchImpl: files.fetch }), /larger than/);
  assert.equal(allowedHost(new URL("https://a.blob.core.windows.net/x")), true);
  assert.equal(allowedHost(new URL("https://oaiusercontent.com.evil.example/x")), false);
});

test("D1-backed KV: get/put/delete, JSON, expiry, metadata, prefix listing with cursors", async () => {
  const db = createD1();
  let clock = 1_000_000;
  const kv = d1Kv(db, { now: () => clock });
  await kv.put("client:a", JSON.stringify({ x: 1 }));
  await kv.put("grant:u:1", "g1", { metadata: { c: "a" }, expirationTtl: 60 });
  await kv.put("grant:u:2", "g2");
  await kv.put("grant:v:1", "g3");
  assert.deepEqual(await kv.get("client:a", { type: "json" }), { x: 1 });
  assert.equal(await kv.get("grant:u:2"), "g2");
  assert.equal(await kv.get("nope"), null);
  const page1 = await kv.list({ prefix: "grant:u:", limit: 1 });
  assert.deepEqual(page1.keys.map((k) => k.name), ["grant:u:1"]);
  assert.deepEqual(page1.keys[0].metadata, { c: "a" });
  assert.equal(page1.list_complete, false);
  const page2 = await kv.list({ prefix: "grant:u:", limit: 1, cursor: page1.cursor });
  assert.deepEqual(page2.keys.map((k) => k.name), ["grant:u:2"]);
  assert.equal(page2.list_complete, true);
  clock += 61_000;
  assert.equal(await kv.get("grant:u:1"), null, "expired values are gone");
  assert.deepEqual((await kv.list({ prefix: "grant:u:" })).keys.map((k) => k.name), ["grant:u:2"]);
  await kv.delete("grant:u:2");
  assert.equal(await kv.get("grant:u:2"), null);
  await kv.put("grant:u:2", "again");
  await kv.put("grant:u:2", "overwritten", { expiration: Math.floor(clock / 1000) + 30 });
  assert.equal(await kv.get("grant:u:2"), "overwritten");
  await kv.sweep();
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) AS n FROM hc_oauth_kv").get().n, 3);
});
