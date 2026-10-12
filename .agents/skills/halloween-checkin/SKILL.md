---
name: halloween-checkin
description: "Turn a photo of a real place into a reviewed day/night miniature building pair (normal or Halloween edition) and publish it to the Halloween Check-in site only after the user clearly asks. Use for: checkin, check in, 打卡, 万圣节打卡, checkin Halloween. Not for unrelated image edits."
---

# Halloween Check-in

You run this skill inside a host agent that can generate and edit images with the user's own subscription. This project does **not** provide image generation: the host generates the pictures, the scripts in this repository validate them, and the Worker stores and shows them. Never claim a picture was produced by anything other than the tool that actually produced it.

## Inputs

- A photo of a real place that the user is allowed to use. If there is no readable photo, or several candidate photos, ask one short question.
- Intent `checkin`. If the user also says `Halloween` / `万圣节`, the theme is `halloween`; otherwise `normal`.
- Optional facts: place name, capture time, companions. Use only what the user or the photo's metadata states. Unknown stays unknown: no guessing of address, GPS, city or time from pixels. There is no default city.
- The photo is private. Do not upload it anywhere except to the image tool the user already authorized for this request, and never save it in the repository.

## Pipeline

1. **Day image.** Read [references/prompts.md](references/prompts.md). Generate with the photo as the *only* visual input. For `halloween`, use the Halloween day prompt: decorations may be added, but the sign, the building's identity and its main structure must stay.
2. **Check identity** (you look at the image): same overall shape, entrance and openings, readable primary sign text exactly as in the photo, sign colours, no invented major structure.
3. **Night image.** Edit the *accepted day image only* (never the photo) with the night prompt. Night changes lighting, not geometry, sign or objects.
4. **Budget.** At most two generation attempts per stage: the first one and one correction for a core failure (wrong building, wrong/missing sign, night redrew the scene, unusable matte). Do not loop for small text or peripheral details; mention them as differences. If the correction fails, show the best candidate and the blocker and wait for the user.
5. **Prepare.** `npm run prepare:images -- --day <raw-day.png> --night <raw-night.png> --out-dir <dir>`. It keeps a real transparent background if the image has one, otherwise removes the flat backdrop that touches the image edge (the prompts ask for flat magenta), cleans the edges and applies one shared framing to both images. Do not regenerate because of an imperfect backdrop; regenerate only if the script reports `backdrop_not_flat` or the result cuts into the building.
6. **Validate.** `npm run hc -- review --day <dir>/day.png --night <dir>/night.png --theme <normal|halloween> --text "at <place>" --out <workspace> [--place-name ...] [--captured-at <ISO with zone> --captured-at-source exif|user] [--companion ...] [--difference "..."]... [--link <checkin id>]`. If it fails, fix the cause; do not edit thresholds.
7. **Look at the result.** Open the workspace `day.png`, `night.png` and the 360/240 previews. The script cannot judge the sign or structure: you must, and you must say so in your review.
8. **Submit for review.** `npm run hc -- submit --dir <workspace>` registers the revision and uploads the exact bytes. Nothing is public after this. Show: the photo, day, night, previews, theme, every proposed public field, differences (include every creative addition such as pumpkins), the target project, the payload hash, and your visual-review findings. Then **stop**.

## Publishing

Only a later user message that clearly asks to publish *this reviewed package* authorizes it (for example `发布`, `确认发布`, `go`, `发吧`). A message before the review, a thanks, or a request to change something is not authorization. Any change to an image or a field means a new `review` → `submit` → a fresh review.

After clear authorization:

```bash
npm run hc -- approve --dir <workspace>
npm run hc -- publish --dir <workspace>
```

`approve` records a `trusted-agent-attestation`: the server checks identity, hash and target, but it cannot independently prove a human clicked. Say that plainly if asked.

`publish` verifies the public list and both images (status, `image/png`, byte hash). Report the verified result. If a call times out or returns something unclear, run `npm run hc -- status --dir <workspace>` and repeat `publish` for the **same workspace**: the stored idempotency key makes it safe. Never start a new workspace to retry.

## Normal and Halloween are separate

A Halloween request creates a Halloween pair; it never replaces a normal pair. To add a Halloween edition to an existing check-in, pass `--link <existing checkin id>`. The website's optional "Halloween mood" switch is decoration only and never triggers generation.

## Configuration and secrets

`HC_API_URL` and `HC_TOKEN` come from the environment. Never ask for the token in chat, print it, write it to a file in the repository, or pass it on a command line. If they are missing, tell the user what to configure and stop.
