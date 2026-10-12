# Prompts

Original wording written for this project. Fill the `<…>` parts. The photo is the only image input for the day prompts; the accepted day image is the only image input for the night prompt.

## Common substrate line (all stages)

> Place the subject on a perfectly flat, uniform magenta background (#FF00FF) with no gradient, no ground plane, no shadow and no reflection. Do not use magenta anywhere on the subject.

## Day, normal

> Make a small handcrafted miniature (soft clay look) of the building in the photo, as if it were a collectible. Keep a clear front-facing view. Keep the building's overall shape, entrance, main windows/doors, colours, and the main sign with its text exactly as it appears in the photo, in the same language and order. Remove cars, people, cables and clutter that are not part of the building. Do not add structures that are not in the photo. <common substrate line>

If the user supplied a verified place name and that same name is visible in the photo, you may add: *"The main sign reads exactly: `<NAME>`."* Never add text that is not in the photo.

## Day, Halloween

> Same as the normal day prompt, and additionally add a few small Halloween decorations (for example a pumpkin by the door, a string of orange lights, a paper bat), keeping them small enough that the sign, entrance and building shape stay clearly recognisable. Do not cover or alter the sign. <common substrate line>

List the decorations you asked for in `--difference` when you review (they are creative additions, not facts about the real place).

## Night (both themes)

> Edit this exact image into the same scene at night. Change only the lighting: dark blue ambient light, warm lit windows and signs, soft glow. Do not redraw, move, crop or resize anything; keep every shape, the sign text, the colours of the sign and all objects identical to the input. For the Halloween edition keep the same decorations, now lit. <common substrate line>

## What counts as a core failure (allows the single correction)

- wrong or unrecognisable building, or a major invented opening/structure;
- primary sign missing, misspelled, reordered, translated or clearly less prominent than in the photo;
- night image changed geometry, crop, sign or core objects;
- the preparation script cannot produce a clean transparent result without removing part of the building.

Everything else (tiny posters, small numbers, minor fixtures, wear) is a note for the review, not a reason to regenerate.
