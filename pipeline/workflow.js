// Skill-side workflow steps. Each step is a plain function so the CLI, tests
// and (later) other hosts share the same behaviour.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { sha256Hex } from "../worker/halloween/domain/canonical.js";
import { makePreviews, validatePair, VALIDATOR_VERSION } from "./validate.js";

const STATE_FILE = "state.json";

async function readState(dir) {
  try {
    return JSON.parse(await readFile(path.join(dir, STATE_FILE), "utf8"));
  } catch {
    return {};
  }
}
async function writeState(dir, state) {
  await writeFile(path.join(dir, STATE_FILE), JSON.stringify(state, null, 2));
}

/** Step 1 (offline): validate the final pair and write the review workspace. */
export async function prepareReview({ dayPath, nightPath, meta, outDir }) {
  const [day, night] = await Promise.all([readFile(dayPath), readFile(nightPath)]);
  const report = await validatePair({ day: new Uint8Array(day), night: new Uint8Array(night) });
  await mkdir(outDir, { recursive: true });
  await writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  if (!report.passed) return { ok: false, report };

  await writeFile(path.join(outDir, "day.png"), day);
  await writeFile(path.join(outDir, "night.png"), night);
  for (const [slot, bytes] of [["day", day], ["night", night]]) {
    const previews = await makePreviews(bytes);
    for (const size of [360, 240]) await writeFile(path.join(outDir, `preview-${slot}-${size}.png`), previews[size]);
  }
  const submission = {
    ...meta,
    images: {
      day: { sha256: report.images.day.sha256, bytes: report.images.day.bytes },
      night: { sha256: report.images.night.sha256, bytes: report.images.night.bytes },
    },
    validator: { version: VALIDATOR_VERSION, passed: true },
  };
  await writeFile(path.join(outDir, "submission.json"), JSON.stringify(submission, null, 2));
  await writeState(outDir, { step: "prepared" });
  return { ok: true, report, submission };
}

/** Step 2: register the revision and upload the exact bytes. Does not publish. */
export async function submitForReview({ client, dir }) {
  const submission = JSON.parse(await readFile(path.join(dir, "submission.json"), "utf8"));
  const state = await readState(dir);
  if (state.step === "published") throw new Error("this workspace is already published; start a new one for a new revision");

  // Re-verify the bytes on disk are the ones the submission describes.
  const day = new Uint8Array(await readFile(path.join(dir, "day.png")));
  const night = new Uint8Array(await readFile(path.join(dir, "night.png")));
  if ((await sha256Hex(day)) !== submission.images.day.sha256 || (await sha256Hex(night)) !== submission.images.night.sha256) {
    throw new Error("images changed after validation; run prepare again");
  }

  const review = await client.register({ ...(state.draftId ? { draftId: state.draftId } : {}), ...submission });
  await client.putMedia(review.revisionId, "day", day);
  const ready = await client.putMedia(review.revisionId, "night", night);
  await writeState(dir, { step: "review_ready", draftId: ready.draftId, revisionId: ready.revisionId, payloadHash: ready.payloadHash });
  return ready;
}

/** Step 3: only after the user clearly asked to publish this reviewed package. */
export async function approveReviewed({ client, dir }) {
  const state = await readState(dir);
  if (state.step !== "review_ready" && state.step !== "approved") throw new Error(`cannot approve from step '${state.step ?? "none"}'`);
  const approval = await client.approve(state.revisionId, state.payloadHash);
  await writeState(dir, { ...state, step: "approved", approvalId: approval.approvalId, approvalExpiresAt: approval.expiresAt });
  return approval;
}

/** Step 4: publish with a persisted idempotency key, then verify the public result. */
export async function publishApproved({ client, dir, keyGenerator = () => crypto.randomUUID().replace(/-/g, "") }) {
  const state = await readState(dir);
  if (!["approved", "publishing", "published"].includes(state.step)) throw new Error(`cannot publish from step '${state.step ?? "none"}'`);
  // Persist the key before the request so a retry after a crash/timeout reuses it.
  const idempotencyKey = state.idempotencyKey ?? `hc-${keyGenerator()}`;
  if (!state.idempotencyKey) await writeState(dir, { ...state, step: "publishing", idempotencyKey });

  const result = await client.publish(state.revisionId, {
    idempotencyKey,
    payloadHash: state.payloadHash,
    approvalId: state.approvalId,
  });
  await writeState(dir, { ...state, step: "published", idempotencyKey, checkinId: result.checkinId, operationId: result.operationId });
  return { result, verification: await verifyPublished({ client, checkinId: result.checkinId, revisionId: state.revisionId, dir }) };
}

export async function verifyPublished({ client, checkinId, revisionId, dir }) {
  const list = await client.listPublic();
  const entry = list.find((c) => c.id === checkinId);
  const problems = [];
  if (!entry) problems.push("check-in not in public list");
  const submission = JSON.parse(await readFile(path.join(dir, "submission.json"), "utf8"));
  const variant = entry?.variants.find((v) => (v.day ?? v.night ?? "").includes(revisionId));
  if (entry && !variant) problems.push("variant for this revision missing");
  for (const slot of ["day", "night"]) {
    if (!variant) break;
    if (!submission.images[slot]) continue; // this edition has no picture in that lighting
    if (!variant[slot]) { problems.push(`${slot} media not listed`); continue; }
    const media = await client.fetchPublicMedia(variant[slot]);
    if (media.status !== 200) problems.push(`${slot} media status ${media.status}`);
    else if (!media.contentType?.startsWith("image/png")) problems.push(`${slot} content-type ${media.contentType}`);
    else if ((await sha256Hex(media.bytes)) !== submission.images[slot].sha256) problems.push(`${slot} bytes differ from reviewed image`);
  }
  return { ok: problems.length === 0, problems, checkinId };
}

/** Human-readable review summary written next to the images. */
export function renderReviewMarkdown(review, report) {
  const p = review.payload;
  const checks = [...Object.entries(report.images).flatMap(([slot, i]) => i.checks.map((c) => ({ slot, ...c }))), ...report.pair.map((c) => ({ slot: "pair", ...c }))];
  return [
    `# Review package`,
    ``,
    `- Theme: **${p.theme}**`,
    `- Text: ${p.text}`,
    `- Place: ${p.place.name ?? "unknown"}${p.place.address ? " — " + p.place.address : ""}`,
    `- Captured: ${p.capturedAt ?? "unknown"}${p.capturedAtSource ? ` (${p.capturedAtSource})` : ""}`,
    `- Companions: ${p.companions.length ? p.companions.join(", ") : "none"}`,
    `- Differences / creative additions: ${p.differences.length ? p.differences.join("; ") : "none noted"}`,
    `- Target: project \`${p.project}\`, visibility ${p.visibility}`,
    `- Payload hash: \`${review.payloadHash}\``,
    `- Day sha256: \`${p.images.day.sha256}\``,
    `- Night sha256: \`${p.images.night.sha256}\``,
    ``,
    `## Automatic checks (${report.version})`,
    ...checks.map((c) => `- [${c.passed ? "x" : " "}] ${c.slot}: ${c.name} — ${c.detail}`),
    ``,
    `Visual review (sign, doors, structure, night = same building relit): **${report.visualReview}** by the script; the agent must inspect the images and state findings.`,
  ].join("\n");
}
