// Worker entry for the Halloween Check-in service.
//  - static site from the assets binding
//  - /api/* and /media/*: HTTP API (Bearer owner token) used by the CLI and the site
//  - /mcp: MCP server for the ChatGPT plugin, behind OAuth
//  - /authorize, /oauth/*, /.well-known/oauth-*: OAuth endpoints (owner sign-in)
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { handleAuthorize, SCOPE } from "./authorize.js";
import { d1Kv } from "./kv-d1.js";
import { createMcpHandler } from "./mcp.js";
import { createWorkerHandler, serviceForEnv } from "./router.js";

const handle = createWorkerHandler();
const mcp = createMcpHandler({ serviceFor: serviceForEnv });

const OAUTH_PATH = /^\/(mcp(\/|$)|authorize$|oauth\/|\.well-known\/oauth-)/;

// The provider needs absolute URLs in its metadata, so one is built per origin.
const providers = new Map();
function providerFor(origin) {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider({
      apiRoute: "/mcp",
      apiHandler: mcp,
      defaultHandler: {
        fetch(request, env) {
          if (new URL(request.url).pathname === "/authorize") return handleAuthorize(request, env);
          return handle(request, env);
        },
      },
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: [SCOPE],
      requiredScopes: [SCOPE],
      accessTokenTTL: 3600,
      refreshTokenTTL: 30 * 24 * 3600,
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        bearer_methods_supported: ["header"],
        resource_name: "Halloween Check-in",
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!OAUTH_PATH.test(url.pathname)) return handle(request, env);
    if (!env.DB || !env.OWNER_TOKEN) {
      return Response.json({ error: "not_configured" }, { status: 503 });
    }
    // OAuth records live in this project's D1 database (see kv-d1.js).
    return providerFor(url.origin).fetch(request, { ...env, OAUTH_KV: d1Kv(env.DB) }, ctx);
  },
};
