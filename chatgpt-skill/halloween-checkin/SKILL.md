---
name: halloween-checkin
description: "Turn the user's photo of a real place into a reviewed day/night miniature building, with a Halloween edition, and publish it to their Halloween Check-in site only after they clearly ask. Use when the user says checkin, check in, 打卡, checkin Halloween or 万圣节打卡 with a photo."
---

# Halloween Check-in (ChatGPT)

When this skill is used, follow these steps in order and do not improvise another check-in format (no location lookup, no check-in cards, no claims that something was saved before a tool returned it).

You generate the pictures with your own image tool. The prepare script in this skill
cuts them out and checks them. The **Halloween Check-in** plugin's tools receive the
finished files and publish them. The tools never generate images, and nothing is
public until the user clearly asks you to publish.

## 1. Inputs

- One photo of a real place that the user is allowed to use. If there is no photo or
  several candidates, ask one short question.
- Place name: use what the user says, or the sign that is clearly readable in the photo.
  Never guess an address, city or coordinates.
- Capture time: only from the photo's EXIF (read it with Pillow) or what the user says,
  with a time zone offset. Otherwise leave it unknown.
- Companions: only names the user gives.
- Always make both editions: **normal** and **halloween**.

## 2. Generate four images, one at a time

Use your image tool. Send it **exactly** the prompt text below (fill in nothing else).
Never put the words "check-in", "checkin", "打卡", a date, an address, a map or a place
name into an image prompt: the image tool then draws a check-in card or an app screen
instead of a building. The result must be **one miniature building object and nothing
else** — no card, no frame, no UI, no text overlay, no map, no pin, no date, no caption.

Shared ending for every prompt (call it BACKDROP):

> Show only the miniature object, centred, whole, with empty space around it. Background: one perfectly flat solid magenta colour #FF00FF filling the whole image, no gradient, no floor, no shadow, no reflection, no border. Do not use magenta on the object. No text, labels, captions, frames, cards, maps, icons or UI of any kind, except the lettering that is physically on the building's own sign.

1. **normal-day** — image input: the user's photo only.
   > A photograph of a small handcrafted collectible scale model of the building in the reference photo, soft clay and painted-wood look, like a miniature on a shelf. Straight front view of the facade. Keep the building's shape, entrance, windows, doors and colours, and copy the main shop sign exactly as it appears, same letters and language. Leave out people, cars, bicycles, cables, street signs and the street itself. Do not add anything that is not part of the building. BACKDROP
2. **normal-night** — image input: image 1 only.
   > Relight this exact miniature as night: dark blue ambient light, warm glowing windows and sign. Keep every shape, the camera, the framing, the sign lettering and the magenta background exactly the same; change only the lighting on the object. BACKDROP
3. **halloween-day** — image input: the user's photo only.
   > Same as a small handcrafted collectible scale model of the building in the reference photo (front view, same shape, windows, doors, colours, and the main sign copied exactly), decorated for Halloween with a few small additions: a carved pumpkin by the door, a string of orange lights, one paper bat. Decorations stay small and never cover the sign. No people, cars or street. BACKDROP
4. **halloween-night** — image input: image 3 only.
   > Relight this exact decorated miniature as night: dark blue ambient light, glowing windows, sign, pumpkin and string lights. Keep every shape, the framing, the sign and the magenta background the same; change only the lighting. BACKDROP

After each image, look at it before going on. **Core failures** (retry that stage once
with a short correction, e.g. "only the building model, no card or text"): not a single
miniature building; a card, screen, map or caption; wrong building; sign text wrong or
missing; night changed the shapes; background not flat magenta. Anything smaller is a
note for the review. If the retry also fails, show both attempts, say which rule they
broke, and ask the user (offer to try again with a clearer photo).

Do not research or guess the location (city, branch, address) from the photo. The
place name is what the user says or what the sign clearly reads; everything else stays
unknown.

## 3. Prepare and check (in your Python sandbox)

Save the four images, then run the script once per edition:

```bash
python scripts/prepare.py --day normal-day.png --night normal-night.png --out-dir out/normal
python scripts/prepare.py --day halloween-day.png --night halloween-night.png --out-dir out/halloween
```

It prints JSON. `"ok": true` means `out/<edition>/day.png` and `night.png` are the final
720×720 transparent files; note `validator_version`. `"ok": false` explains why; if it
says `backdrop_not_flat`, regenerate that image with a flatter magenta background.
Never edit the script's limits to make it pass.

Then **look** at the prepared images and the 360/240 previews yourself: is the sign
readable, is the night the same building, are there cut-off parts? The script cannot
judge that.

## 4. Submit for review (nothing becomes public)

Call `submit_checkin_for_review` for the normal edition with the files
`out/normal/day.png` and `out/normal/night.png`, `theme: "normal"`, the text
(for example `at Sushiro`), place name, capture time only if known, companions,
`differences` (notable simplifications), and `validator_version`.

Then call it for the Halloween edition with `out/halloween/*.png`, `theme: "halloween"`,
`link_revision_id` set to the normal edition's `revision_id`, and `differences` listing
every decoration you added (they are creative additions, not facts about the place).

Show the user a review package: the four final pictures, the exact public text and
place, the capture time (or "unknown"), companions, differences, the site the tools
returned, and both payload hashes. Then **stop and wait**.

## 5. Publish only on a clear request

Only a later message that clearly asks to publish this package counts (for example
`发布`, `确认发布`, `publish`, `go`). Thanks, "looks good", or a change request do not.
Any change means new files → submit again → review again.

When asked: call `publish_checkin` for the **normal** revision first, then for the
**Halloween** revision, each with its own `payload_hash`. Report the site link and the
editions the tool returned.

If a call times out or the result is unclear, call `get_checkin_status` first. Calling
`publish_checkin` again for the same revision is safe: it returns the existing result.

## Notes

- To add a Halloween edition to a place that is already on the site, use
  `list_checkins` to find its id and pass `link_checkin_id` instead of
  `link_revision_id`.
- Never upload the original photo with the tools, and never put it on the site.
- Publishing records that you relayed the user's request (trusted-agent attestation);
  the server checks identity, hashes and target but cannot prove a person clicked.
