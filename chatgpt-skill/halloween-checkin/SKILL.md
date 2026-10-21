---
name: halloween-checkin
description: "Turn the user's photo of a real place into a reviewed day/night miniature building, with a Halloween edition, and publish it to their Halloween Check-in site only after they clearly ask. Use when the user says checkin, check in, 打卡, checkin Halloween or 万圣节打卡 with a photo."
---

# Halloween Check-in (ChatGPT)

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

Each a square image (1024×1024 if you can choose). Every image: the building on a
perfectly flat, uniform magenta background (#FF00FF), no gradient, no ground, no
shadow, no reflection, and no magenta anywhere on the building.

1. **normal-day**, from the photo only: a small handcrafted miniature (soft clay look)
   of the building, as a collectible, clear front-facing view. Keep the overall shape,
   entrance, main windows and doors, colours, and the main sign with its text exactly
   as in the photo (same language and order). Remove cars, people, cables and clutter.
   Do not add structures that are not in the photo.
2. **normal-night**, an edit of image 1 only: the same scene at night. Change only the
   lighting (dark blue ambient light, warm lit windows and signs, soft glow). Do not
   redraw, move, crop or resize anything.
3. **halloween-day**, from the photo only: as image 1, plus a few small Halloween
   decorations (a pumpkin by the door, orange string lights, a paper bat). Never cover
   or change the sign.
4. **halloween-night**, an edit of image 3 only, as in step 2, decorations now lit.

Look at each result. Retry a stage **once** only for a core failure: wrong building,
wrong or missing sign text, or a night image that changed the shapes. Small details are
notes, not reasons to retry. If the retry also fails, show the best one and ask.

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
