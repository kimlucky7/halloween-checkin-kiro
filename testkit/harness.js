// Local test harness: D1-compatible database over node:sqlite, an in-memory
// R2-compatible bucket, and an app wrapper around the real router. Fault
// injection hooks let tests simulate the failures named in the requirements.
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";

import { createHandler } from "../worker/halloween/router.js";
import { createService } from "../worker/halloween/service.js";
import { sha256Hex } from "../worker/halloween/domain/canonical.js";
import { syntheticPair } from "../pipeline/synthetic.js";
import { VALIDATOR_VERSION } from "../pipeline/validate.js";

export const PROJECT = "halloween-checkin-test";
export const TOKEN = "test-owner-token-not-a-secret-0001";

export function createD1(sqlFiles = ["migrations/0002_halloween_checkin.sql", "migrations/0003_chatgpt_plugin.sql", "migrations/0004_single_image_editions.sql"]) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const f of [].concat(sqlFiles)) sqlite.exec(readFileSync(new URL("../" + f, import.meta.url), "utf8"));
  const faults = { batchBeforeCommit: 0, batchAfterCommit: 0 };

  function statement(sql, params = []) {
    return {
      sql,
      params,
      bind: (...p) => statement(sql, p),
      async first() {
        return sqlite.prepare(sql).get(...params) ?? null;
      },
      async all() {
        return { results: sqlite.prepare(sql).all(...params) };
      },
      async run() {
        const r = sqlite.prepare(sql).run(...params);
        return { meta: { changes: Number(r.changes) } };
      },
    };
  }
  return {
    sqlite,
    faults,
    prepare: (sql) => statement(sql),
    async batch(statements) {
      if (faults.batchBeforeCommit > 0) {
        faults.batchBeforeCommit--;
        throw new Error("injected: database unavailable before commit");
      }
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const s of statements) out.push(await s.run());
        sqlite.exec("COMMIT");
        if (faults.batchAfterCommit > 0) {
          faults.batchAfterCommit--;
          throw new Error("injected: response lost after commit");
        }
        return out;
      } catch (error) {
        if (sqlite.isTransaction) sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

export function createBucket() {
  const objects = new Map();
  const faults = { failPutAfter: Infinity };
  let puts = 0;
  return {
    objects,
    faults,
    async head(key) {
      const o = objects.get(key);
      return o ? { size: o.bytes.length, customMetadata: o.customMetadata } : null;
    },
    async get(key) {
      const o = objects.get(key);
      return o ? { body: o.bytes } : null;
    },
    async put(key, bytes, options = {}) {
      if (puts++ >= faults.failPutAfter) throw new Error("injected: object store unavailable");
      objects.set(key, { bytes: new Uint8Array(bytes), customMetadata: options.customMetadata ?? {} });
    },
  };
}

export function createApp({ ownerId = "owner", db = createD1(), media = createBucket(), now = { value: Date.parse("2026-10-12T10:00:00Z") }, token = TOKEN } = {}) {
  const env = { OWNER_TOKEN: token, OWNER_ID: ownerId, ASSETS: { fetch: async () => new Response("asset", { status: 200 }) } };
  const handle = createHandler({
    serviceFor: () => createService({ db, media, project: PROJECT, clock: () => now.value }),
  });
  async function call(method, path, { body, bytes, headers = {}, auth = token } = {}) {
    const h = { ...headers };
    if (auth) h.authorization = `Bearer ${auth}`;
    let payload;
    if (bytes) payload = bytes;
    else if (body !== undefined) { payload = JSON.stringify(body); h["content-type"] = "application/json"; }
    const res = await handle(new Request("https://test.invalid" + path, { method, headers: h, body: payload }), env);
    const type = res.headers.get("content-type") ?? "";
    const data = type.includes("json") ? await res.json() : new Uint8Array(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  // fetch-compatible entry point so the real client can talk to the real router in-process
  const fetch = (url, init) => handle(new Request(url, init), env);
  return { call, fetch, db, media, now, ownerId };
}

/** Register a revision for a synthetic pair; returns everything a test needs. */
export async function registerSynthetic(app, { theme = "normal", text = "at the synthetic cafe", extra = {}, draftId, variant = 0 } = {}) {
  const pair = await syntheticPair({ theme, variant });
  const images = {
    day: { sha256: await sha256Hex(pair.day), bytes: pair.day.length },
    night: { sha256: await sha256Hex(pair.night), bytes: pair.night.length },
  };
  const res = await app.call("POST", "/api/revisions", {
    body: { draftId, theme, text, images, validator: { version: VALIDATOR_VERSION, passed: true }, ...extra },
  });
  return { ...res, pair, images };
}

export async function uploadBoth(app, revisionId, pair) {
  const a = await app.call("PUT", `/api/revisions/${revisionId}/media/day`, { bytes: pair.day });
  const b = await app.call("PUT", `/api/revisions/${revisionId}/media/night`, { bytes: pair.night });
  return [a, b];
}

let keySeq = 0;
export const newKey = () => `idem-key-${String(++keySeq).padStart(8, "0")}-abcdef`;

/** register → upload → approve; returns ids ready to publish. */
export async function reviewReady(app, options = {}) {
  const reg = await registerSynthetic(app, options);
  assertStatus(reg, 201);
  const revisionId = reg.data.revisionId;
  const ups = await uploadBoth(app, revisionId, reg.pair);
  ups.forEach((u) => assertStatus(u, 200));
  return { revisionId, draftId: reg.data.draftId, payloadHash: reg.data.payloadHash, pair: reg.pair, review: ups[1].data };
}

export async function approved(app, options = {}) {
  const r = await reviewReady(app, options);
  const ap = await app.call("POST", `/api/revisions/${r.revisionId}/approve`, {
    body: { payloadHash: r.payloadHash, attestation: "trusted-agent-attestation" },
  });
  assertStatus(ap, 201);
  return { ...r, approvalId: ap.data.approvalId };
}

function assertStatus(res, expected) {
  if (res.status !== expected) throw new Error(`expected ${expected}, got ${res.status}: ${JSON.stringify(res.data)}`);
}
