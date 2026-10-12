import test from "node:test";
import assert from "node:assert/strict";

import { AttemptBudget, BudgetExceeded, createHostImportProvider, createMockProvider, runGeneration } from "../pipeline/provider.js";
import { validatePair } from "../pipeline/validate.js";
import { syntheticMiniature } from "../pipeline/synthetic.js";

const acceptAll = async () => ({ ok: true });

test("mock provider completes day then night for both themes and the result validates", async () => {
  for (const theme of ["normal", "halloween"]) {
    const res = await runGeneration({ provider: createMockProvider(), theme, accept: acceptAll });
    assert.equal(res.ok, true);
    assert.match(res.provider, /synthetic-demo/);
    assert.equal(res.kind, "mock");
    assert.equal((await validatePair({ day: res.day, night: res.night })).passed, true);
    assert.deepEqual(res.log.map((l) => [l.stage, l.outcome]), [["day", "accepted"], ["night", "accepted"]]);
  }
});

test("the night request never receives the source photo", async () => {
  const seen = [];
  const provider = {
    id: "spy", kind: "mock", label: "spy",
    async generate(req) {
      seen.push(req);
      return { bytes: await syntheticMiniature({ lighting: req.stage }) };
    },
  };
  await runGeneration({ provider, source: "SOURCE-PHOTO-REF", accept: acceptAll });
  assert.equal(seen[0].stage, "day");
  assert.equal(seen[0].source, "SOURCE-PHOTO-REF");
  assert.equal(seen[1].stage, "night");
  assert.ok(!("source" in seen[1]), "night must be relit from the accepted day only");
  assert.ok(seen[1].day instanceof Uint8Array);
});

test("a rejected day gets exactly one correction, then the run stops with a blocker", async () => {
  let calls = 0;
  const provider = createMockProvider();
  const res = await runGeneration({
    provider,
    accept: async (stage) => {
      calls++;
      return stage === "day" ? { ok: false, reason: "sign unreadable" } : { ok: true };
    },
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, "day");
  assert.match(res.blocker, /sign unreadable/);
  assert.equal(calls, 2);
  assert.deepEqual(res.log.map((l) => l.outcome), ["rejected", "rejected"]);
});

test("a correction can succeed on the second attempt and carries the reason", async () => {
  const requests = [];
  const base = createMockProvider();
  const provider = { ...base, async generate(r) { requests.push(r); return base.generate(r); } };
  let first = true;
  const res = await runGeneration({
    provider,
    accept: async (stage) => (stage === "day" && first ? ((first = false), { ok: false, reason: "roof wrong" }) : { ok: true }),
  });
  assert.equal(res.ok, true);
  assert.equal(requests[1].correction, "roof wrong");
  assert.equal(res.log.filter((l) => l.stage === "day").length, 2);
});

test("provider errors consume the same budget and never loop forever", async () => {
  const res = await runGeneration({ provider: createMockProvider({ failDayAttempts: 5 }), accept: acceptAll });
  assert.equal(res.ok, false);
  assert.equal(res.log.length, 2);
  assert.ok(res.log.every((l) => l.outcome === "error"));
});

test("a night failure keeps the accepted day and reports the stage", async () => {
  const res = await runGeneration({
    provider: createMockProvider(),
    accept: async (stage) => (stage === "night" ? { ok: false, reason: "sign redrawn" } : { ok: true }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.stage, "night");
  assert.ok(res.day instanceof Uint8Array);
});

test("host import adapter cannot generate: it reports a pending import", async () => {
  const provider = createHostImportProvider(async () => null);
  const res = await runGeneration({ provider, accept: acceptAll });
  assert.equal(res.ok, false);
  assert.match(res.log[0].error, /no day image has been imported/);
});

test("host import adapter passes through bytes the host supplied", async () => {
  const day = await syntheticMiniature({ lighting: "day" });
  const night = await syntheticMiniature({ lighting: "night" });
  const provider = createHostImportProvider(async ({ stage }) => (stage === "day" ? day : night));
  const res = await runGeneration({ provider, accept: acceptAll });
  assert.equal(res.ok, true);
  assert.equal(res.kind, "host-generated");
  assert.deepEqual(res.day, day);
});

test("budget counts per stage", () => {
  const b = new AttemptBudget();
  b.consume("day"); b.consume("day");
  assert.throws(() => b.consume("day"), BudgetExceeded);
  assert.equal(b.consume("night"), 1);
});
