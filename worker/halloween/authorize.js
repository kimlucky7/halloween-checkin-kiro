// OAuth sign-in page for the ChatGPT plugin. Single owner: the page asks for the
// owner token (the same secret the CLI uses). The OAuth provider library parses
// the request and issues the grant; this file only decides whether to grant it.
import { tokenMatches } from "./auth.js";

export const SCOPE = "checkins.write";

const esc = (value) =>
  String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
};

function page({ client, redirectHost, scopes, error = "" }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect Halloween Check-in</title>
<style>body{font:16px/1.5 ui-sans-serif,system-ui,-apple-system,"PingFang SC",sans-serif;background:#101014;color:#efeef3;display:grid;place-items:center;min-height:100vh;margin:0}
main{max-width:26rem;padding:2rem}h1{font-size:1.3rem}p{color:#a7a4b1}input{width:100%;box-sizing:border-box;padding:.7rem;border-radius:.6rem;border:1px solid #3a3350;background:#1f1e25;color:inherit;font:inherit}
button{margin-top:1rem;width:100%;padding:.75rem;border:0;border-radius:999px;background:#f97316;color:#1a1024;font:inherit;font-weight:600;cursor:pointer}.err{color:#fca5a5}code{color:#fde68a}</style></head>
<body><main><h1>Connect to Halloween Check-in · 连接</h1>
<p><b>${esc(client)}</b> wants to submit and publish check-ins on your site.<br>It will return to <code>${esc(redirectHost)}</code>.<br>Permission: <code>${esc(scopes)}</code></p>
<p>Enter your owner token to allow it. 输入你的 owner 令牌以授权。</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post"><input type="password" name="token" autocomplete="current-password" required autofocus aria-label="Owner token">
<button type="submit">Allow · 允许</button></form></main></body></html>`;
}

/** GET shows the page; POST (to the same URL, so the OAuth query is kept) checks the token. */
export async function handleAuthorize(request, env) {
  const helpers = env.OAUTH_PROVIDER;
  let authRequest;
  try {
    authRequest = await helpers.parseAuthRequest(request);
  } catch (error) {
    return new Response(page({ client: "Unknown client", redirectHost: "—", scopes: "—", error: String(error.message ?? error) }), { status: 400, headers: HEADERS });
  }
  const client = await helpers.lookupClient(authRequest.clientId);
  if (!client) return new Response(page({ client: "Unknown client", redirectHost: "—", scopes: "—", error: "This client is not registered." }), { status: 400, headers: HEADERS });
  let redirectHost = "—";
  try {
    redirectHost = new URL(authRequest.redirectUri).host;
  } catch {
    /* shown as unknown */
  }
  const view = { client: client.clientName || client.clientId, redirectHost, scopes: SCOPE };

  if (request.method === "GET") return new Response(page(view), { headers: HEADERS });
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { allow: "GET, POST" } });

  const form = await request.formData().catch(() => null);
  const provided = form?.get("token");
  if (!(await tokenMatches(typeof provided === "string" ? provided : "", env.OWNER_TOKEN))) {
    await new Promise((r) => setTimeout(r, 600)); // slow down guessing
    return new Response(page({ ...view, error: "That token is not right. 令牌不正确。" }), { status: 401, headers: HEADERS });
  }
  const ownerId = env.OWNER_ID || "owner";
  const { redirectTo } = await helpers.completeAuthorization({
    request: authRequest,
    userId: ownerId,
    metadata: { label: "ChatGPT plugin" },
    scope: [SCOPE],
    // The owner id travels inside the token; the MCP handler never takes it from a request.
    props: { ownerId },
  });
  return Response.redirect(redirectTo, 302);
}
