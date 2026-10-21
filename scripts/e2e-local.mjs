#!/usr/bin/env node
// End-to-end check against the real Workers runtime (workerd) in LOCAL mode.
// D1 and R2 are simulated on disk in a temp directory; nothing is sent to Cloudflare.
// Uses synthetic images only. Requires `npm run build` first (serves ./dist).
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { unstable_dev } from "wrangler";

import { createClient } from "../pipeline/client.js";
import { syntheticRaw } from "../pipeline/synthetic.js";
import { preparePair } from "../pipeline/prepare.js";
import { approveReviewed, prepareReview, publishApproved, submitForReview } from "../pipeline/workflow.js";

process.env.WRANGLER_SEND_METRICS = "false";
const TOKEN = "e2e-local-token-not-a-secret-0001";
const tmp = await mkdtemp(path.join(os.tmpdir(), "hc-e2e-"));
const persist = path.join(tmp, "state");
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
};

let worker;
try {
  let migrate = { status: 0 };
  for (const file of ["migrations/0002_halloween_checkin.sql", "migrations/0003_chatgpt_plugin.sql"]) {
    if (migrate.status !== 0) break;
    migrate = spawnSync(
      "npx",
      ["wrangler", "d1", "execute", "DB", "--local", "--config", "wrangler.local.jsonc", "--persist-to", persist, "--file", file],
      { encoding: "utf8", env: { ...process.env, WRANGLER_SEND_METRICS: "false" } },
    );
  }
  check("local D1 migrations apply", migrate.status === 0, migrate.status === 0 ? "" : (migrate.stderr || migrate.stdout).slice(-300));
  if (migrate.status !== 0) throw new Error("migration failed");

  worker = await unstable_dev("worker/halloween/index.js", {
    config: "wrangler.local.jsonc",
    local: true,
    persistTo: persist,
    vars: { OWNER_TOKEN: TOKEN, PROJECT_ID: "halloween-checkin-local" },
    experimental: { disableExperimentalWarning: true, disableDevRegistry: true },
    logLevel: "error",
  });
  const base = `http://${worker.address}:${worker.port}`;

  const page = await worker.fetch("/");
  const html = await page.text();
  check("static site is served", page.status === 200 && html.includes("Halloween Check-in") && html.includes("data-stage"));
  check("anonymous write is rejected", (await worker.fetch("/api/revisions", { method: "POST", body: "{}" })).status === 401);
  const empty = await (await worker.fetch("/api/checkins")).json();
  check("public list starts empty", Array.isArray(empty.checkins) && empty.checkins.length === 0);

  const client = createClient({ baseUrl: base, token: TOKEN });
  const published = [];
  for (const theme of ["normal", "halloween"]) {
    const dir = path.join(tmp, theme);
    // Raw "generator output" on a magenta backdrop, prepared exactly as the skill does.
    const pair = await preparePair({ day: await syntheticRaw({ lighting: "day", theme }), night: await syntheticRaw({ lighting: "night", theme }) });
    await writeFile(path.join(tmp, `${theme}-day.png`), pair.day);
    await writeFile(path.join(tmp, `${theme}-night.png`), pair.night);
    const link = published[0]?.checkinId;
    const prep = await prepareReview({
      dayPath: path.join(tmp, `${theme}-day.png`), nightPath: path.join(tmp, `${theme}-night.png`), outDir: dir,
      meta: { theme, text: "at the synthetic cafe", place: { name: "Synthetic Cafe (demo)" }, capturedAt: null, capturedAtSource: null, companions: [],
        differences: theme === "halloween" ? ["pumpkin added (creative decoration)"] : ["synthetic demo building"], ...(link ? { linkCheckinId: link } : {}) },
    });
    check(`${theme}: pair validates`, prep.ok);
    const review = await submitForReview({ client, dir });
    check(`${theme}: review package is ready and nothing is public yet`, review.state === "review_ready" && (await client.listPublic()).filter((c) => c.variants.some((v) => v.theme === theme)).length === 0);
    await approveReviewed({ client, dir });
    const { result, verification } = await publishApproved({ client, dir });
    check(`${theme}: published and public media verified`, result.state === "published" && verification.ok, verification.problems.join("; "));
    const replay = await publishApproved({ client, dir });
    check(`${theme}: repeated publish is a replay`, replay.result.replay === true && replay.result.checkinId === result.checkinId);
    published.push(result);
  }
  const list = await client.listPublic();
  check("one check-in with two independent editions", list.length === 1 && list[0].variants.length === 2, JSON.stringify(list.map((c) => c.variants.map((v) => v.theme))));
  const leaked = JSON.stringify(list);
  check("public projection has no private fields", !/owner|media\/|payloadHash|validator|approval/i.test(leaked.replace(/\/media\//g, "")));

  // ---- ChatGPT plugin: OAuth sign-in, then MCP over the issued token ----
  // Absolute URLs: OAuth metadata is built from the request origin.
  const at = (p, init) => fetch(base + p, init);
  const b64url = (bytes) => Buffer.from(bytes).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  const redirect = "https://chatgpt.com/connector_platform_oauth_redirect";

  const prm = await (await at("/.well-known/oauth-protected-resource/mcp")).json().catch(() => null);
  check("protected resource metadata names the MCP resource", prm?.resource?.endsWith("/mcp") && prm?.scopes_supported?.includes("checkins.write"), JSON.stringify(prm)?.slice(0, 160));
  const asMeta = await (await at("/.well-known/oauth-authorization-server")).json();
  check("authorization server metadata advertises register, authorize and token", Boolean(asMeta.registration_endpoint && asMeta.authorization_endpoint && asMeta.token_endpoint));

  const noToken = await at("/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  check("MCP without a token is 401 with a WWW-Authenticate challenge", noToken.status === 401 && /resource_metadata/.test(noToken.headers.get("www-authenticate") ?? ""), noToken.headers.get("www-authenticate") ?? "");

  const reg = await (await at("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "ChatGPT (test)", redirect_uris: [redirect], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }) })).json();
  check("dynamic client registration works", typeof reg.client_id === "string", JSON.stringify(reg).slice(0, 160));

  const authQuery = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: redirect, scope: "checkins.write", state: "st-123", code_challenge: challenge, code_challenge_method: "S256", resource: `${base}/mcp` });
  const pageRes = await at(`/authorize?${authQuery}`);
  const pageHtml = await pageRes.text();
  check("sign-in page names the client and asks for the owner token", pageRes.status === 200 && pageHtml.includes("ChatGPT (test)") && pageHtml.includes('type="password"'));
  const csp = pageRes.headers.get("content-security-policy") ?? "";
  check("the sign-in page lets the browser follow the redirect back to the client", /form-action 'self' https:\/\/chatgpt\.com(;|$| )/.test(csp), csp);
  const wrong = await at(`/authorize?${authQuery}`, { method: "POST", body: new URLSearchParams({ token: "wrong" }), redirect: "manual" });
  check("a wrong owner token is refused", wrong.status === 401);
  const ok = await at(`/authorize?${authQuery}`, { method: "POST", body: new URLSearchParams({ token: TOKEN }), redirect: "manual" });
  const location = new URL(ok.headers.get("location") ?? "about:blank");
  check("the right owner token redirects back with a code and the same state", ok.status === 302 && location.searchParams.get("state") === "st-123" && Boolean(location.searchParams.get("code")), location.href.slice(0, 120));

  const tokenRes = await (await at("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code"), redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier, resource: `${base}/mcp` }) })).json();
  check("the code is exchanged for access and refresh tokens (PKCE)", typeof tokenRes.access_token === "string" && typeof tokenRes.refresh_token === "string", JSON.stringify(tokenRes).slice(0, 120));

  const mcp = async (method, params, token = tokenRes.access_token) => {
    const res = await at("/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }) });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
  const init = await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  check("MCP initialize over the OAuth token", init.status === 200 && init.body?.result?.serverInfo?.name === "halloween-checkin", `${init.status} ${JSON.stringify(init.body)?.slice(0, 200)}`);
  const tools = await mcp("tools/list");
  check("MCP lists the four tools", tools.body?.result?.tools?.length === 4);
  const listed = await mcp("tools/call", { name: "list_checkins", arguments: {} });
  check("list_checkins sees the published place with both editions", listed.body?.result?.structuredContent?.checkins?.[0]?.editions?.length === 2, JSON.stringify(listed.body?.result?.structuredContent)?.slice(0, 160));
  const badFile = await mcp("tools/call", { name: "submit_checkin_for_review", arguments: { theme: "normal", text: "at x", validator_version: "t", day_image: { download_url: "http://127.0.0.1/x" }, night_image: { download_url: "http://127.0.0.1/y" } } });
  check("submit refuses files from a non-ChatGPT host", badFile.body?.result?.structuredContent?.error === "host_not_allowed");
  const forged = await mcp("tools/list", undefined, "forged-token");
  check("a forged token is refused", forged.status === 401);
  const refreshed = await (await at("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokenRes.refresh_token, client_id: reg.client_id }) })).json();
  check("the refresh token yields a working access token", (await mcp("tools/list", undefined, refreshed.access_token)).status === 200);
  const ownerApi = await at("/api/revisions", { method: "POST", headers: { authorization: `Bearer ${tokenRes.access_token}` }, body: "{}" });
  check("an OAuth token does not unlock the owner HTTP API", ownerApi.status === 401);
  // Last, because a reused authorization code revokes the whole grant (OAuth 2.1).
  const replayCode = await at("/oauth/token", { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code: location.searchParams.get("code"), redirect_uri: redirect, client_id: reg.client_id, code_verifier: verifier }) });
  check("an authorization code works only once", replayCode.status >= 400);
  check("reusing a code revokes the tokens issued from it", (await mcp("tools/list", undefined, refreshed.access_token)).status === 401);
} catch (error) {
  check("e2e run completed", false, error.message);
} finally {
  await worker?.stop();
  await rm(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
