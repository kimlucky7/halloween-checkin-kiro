// Image provider adapter contract and generation orchestration.
//
//   provider = { id, kind, label, generate(request) -> { bytes, model?, note? } }
//   request  = { stage: 'day' | 'night', theme, source?, day?, attempt, correction? }
//
// - `host-generated`: the host agent produced the image elsewhere; the adapter only
//   imports bytes the agent hands over. It cannot generate by itself.
// - `mock`: deterministic synthetic output, always labelled as a simulation.
// Night is relit from the accepted day only: the request for the night stage never
// carries the source photo, so a provider cannot redraw the scene from it.
import { syntheticMiniature, SYNTHETIC_LABEL } from "./synthetic.js";

export const MAX_ATTEMPTS_PER_STAGE = 2;

export class BudgetExceeded extends Error {
  constructor(stage) {
    super(`generation budget for '${stage}' is exhausted (${MAX_ATTEMPTS_PER_STAGE} attempts)`);
    this.name = "BudgetExceeded";
    this.stage = stage;
  }
}

export class ProviderUnavailable extends Error {
  constructor(message) {
    super(message);
    this.name = "ProviderUnavailable";
  }
}

export class AttemptBudget {
  #used = { day: 0, night: 0 };
  constructor(max = MAX_ATTEMPTS_PER_STAGE) {
    this.max = max;
  }
  consume(stage) {
    if (this.#used[stage] >= this.max) throw new BudgetExceeded(stage);
    return ++this.#used[stage];
  }
  used(stage) {
    return this.#used[stage];
  }
}

export function createMockProvider({ failDayAttempts = 0 } = {}) {
  let dayCalls = 0;
  return {
    id: "mock",
    kind: "mock",
    label: `${SYNTHETIC_LABEL} (simulated flow, no image service)`,
    async generate({ stage, theme }) {
      if (stage === "day" && dayCalls++ < failDayAttempts) throw new ProviderUnavailable("mock: simulated failure");
      return { bytes: await syntheticMiniature({ lighting: stage, theme }), model: "synthetic-svg", note: SYNTHETIC_LABEL };
    },
  };
}

/** Adapter for images produced by the host agent. `supply` returns bytes for a stage or null. */
export function createHostImportProvider(supply, { label = "host-generated (imported)" } = {}) {
  return {
    id: "host-import",
    kind: "host-generated",
    label,
    async generate(request) {
      const bytes = await supply(request);
      if (!bytes) throw new ProviderUnavailable(`no ${request.stage} image has been imported yet`);
      return { bytes, note: "imported from host" };
    },
  };
}

/**
 * Run day then night with at most MAX_ATTEMPTS_PER_STAGE attempts each.
 * `accept(stage, bytes)` is the identity/QA decision (human or agent); it returns
 * { ok: true } or { ok: false, reason } and drives the one allowed correction.
 */
export async function runGeneration({ provider, theme = "normal", source = null, accept, budget = new AttemptBudget() }) {
  const log = [];
  async function stageLoop(stage, input) {
    let correction;
    for (;;) {
      let attempt;
      try {
        attempt = budget.consume(stage);
      } catch (error) {
        if (error instanceof BudgetExceeded) return { ok: false, blocker: `${stage}: ${correction ?? "budget exhausted"}` };
        throw error;
      }
      let produced;
      try {
        produced = await provider.generate({ stage, theme, attempt, correction, ...input });
      } catch (error) {
        log.push({ stage, attempt, provider: provider.id, outcome: "error", error: error.message });
        correction = error.message;
        continue;
      }
      const verdict = await accept(stage, produced.bytes);
      log.push({ stage, attempt, provider: provider.id, model: produced.model ?? null, outcome: verdict.ok ? "accepted" : "rejected", reason: verdict.reason });
      if (verdict.ok) return { ok: true, bytes: produced.bytes };
      correction = verdict.reason;
    }
  }

  const day = await stageLoop("day", { source });
  if (!day.ok) return { ok: false, stage: "day", blocker: day.blocker, log, provider: provider.label };
  // The night request deliberately omits `source`.
  const night = await stageLoop("night", { day: day.bytes });
  if (!night.ok) return { ok: false, stage: "night", blocker: night.blocker, day: day.bytes, log, provider: provider.label };
  return { ok: true, day: day.bytes, night: night.bytes, log, provider: provider.label, kind: provider.kind };
}
