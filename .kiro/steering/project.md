---
inclusion: always
---

# Project constraints

Halloween Check-in. Everything in this repository was written for this project; it contains no code from the owner's earlier August Check-in or from third-party sites. Do not claim work that was not actually done.

- Follow the requirements/design/tasks in `.kiro/specs/halloween-checkin/`. Implement in small verified stages; update task status only after actual work
- The core is photo + checkin intent + optional Halloween → recognizable aligned transparent miniature day/night pair → exact review → explicit publication. No default city, city picker or city assembly
- Treat `normal`/`halloween` asset theme, `day`/`night` lighting and optional website atmosphere as separate concepts. Never call generation on an atmosphere toggle or overwrite normal assets with festive variants
- Kiro develops the system. Image generation belongs to a verified host or provider adapter. The publish MCP does not generate images
- Unknown location/capture metadata stays unknown. Use only approved source data; do not expose original photos, private EXIF or secrets
- Bind approval to immutable final bytes, metadata and target. Mutations invalidate approval. Make publication idempotent and inspect uncertain outcomes before retrying
- Use independent Cloudflare resources. Never alter August Check-in production data, bindings, credentials or deployment
- Do not copy code, prompts, styles or assets from other projects or sites. Ideas may inspire the work; credit them in the README and implement them anew
- Prefer mock fixtures and local tests before external integration. Keep synthetic demo data clearly labeled
- New credentials, persistent access, paid services, deployment, public sharing and competition submission require appropriate user authorization. Repository access alone grants none of these
- Document actual commands, tests, integration limits and observed behavior. Never invent API capabilities, provider success, user approvals, license grants or Kiro history

## Repository map

- `worker/halloween/` is the Worker (`wrangler.jsonc`): `domain/` rules, `service.js` (review/approve/publish), `router.js`, `png.js` (final PNG check), `auth.js`. Storage is injected; tests use `testkit/harness.js`.
- `pipeline/`: `prepare.js` (raw pair → final pair), `validate.js`, `provider.js`, `workflow.js`, `client.js`, `synthetic.js`. CLIs in `scripts/`.
- `src/`: the site. `lib/` is pure logic (tested), `scripts/` is DOM and motion; only `scripts/data.js` may use the network.
- Check `npm run verify` and, for runtime behaviour, `npm run e2e:local` before saying something works. Remote Cloudflare actions need the owner's go-ahead; a hook asks before remote wrangler commands.
