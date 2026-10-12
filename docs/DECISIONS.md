# Decisions

Short record of the choices behind this repository, kept current.

## Product shape

1. **Skill** in a host agent (ChatGPT, Codex …) that can generate images with the user's own subscription. The host generates; the repository's scripts prepare and validate; the user reviews; the skill publishes on an explicit request.
2. **Publish backend**: one Cloudflare Worker with D1 (records, revisions, approvals, operations) and R2 (immutable final images). It never generates images.
3. **Site**: static Astro page served by the same Worker; reads `/api/checkins`.

A subscription is not an API, so the public site cannot generate anything. Reviewers see published records and a recording of the real skill flow.

## Choices

| Area | Choice |
|---|---|
| Runtime | Node ≥ 22.12, ESM JavaScript, Astro 7, `sharp`, `node:test` |
| Auth | Single owner, Bearer token stored as the Worker secret `OWNER_TOKEN`; the owner id comes from server config, never from a request |
| Transport | Plain HTTPS: JSON for revisions, raw PNG body for media upload. No MCP/OAuth connector (owner chose skill-only) |
| Approval | `trusted-agent-attestation`: the server checks identity, payload hash, target and expiry, but cannot prove a human clicked |
| Image generation | Host only. `pipeline/provider.js` has a host-import adapter and a mock |
| Image preparation | `pipeline/prepare.js`: keep source alpha if present, else key out the flat backdrop connected to the image edge, unmix edges, drop specks, one shared transform onto 720×720 with the base at y = 651 |
| Site motion | Springs (`src/lib/spring.js`) for entrance, tilt, edition flip and paging; circular reveal for day/night via the View Transitions API with a crossfade fallback; FLIP for opening and closing the shelf; all disabled under `prefers-reduced-motion` |

## Out of scope

Website approval button, image replacement or deletion, multi-owner, rate limiting, any city features.

## Origins

This repository was started fresh. Its predecessor (the owner's private development repository) also held a copy of the owner's earlier August Check-in site, whose front end follows another designer's public site. None of that code, styling, prompts or assets is here. The idea of a homepage line that says where you were last seen, with a little picture of the place, is credited in the README.
