#!/usr/bin/env python3
"""Prepare a host-generated day/night pair into the final 720x720 transparent PNGs.

Runs inside ChatGPT's offline sandbox (Pillow + NumPy only). Same rules as
pipeline/prepare.js in the repository:
  - keep a real alpha channel if the image has one; otherwise remove the flat
    backdrop that is connected to the image edge (a flood fill from the border),
    so backdrop-coloured details inside the building survive;
  - unmix the backdrop colour from semi-transparent edge pixels (no halo);
  - drop small detached specks;
  - one shared transform for every image of the place (normal and Halloween, day and
    night): centred horizontally, standing on y=651, so switching never resizes it.
Then the same mechanical checks the site applies. On any failure it writes nothing
and exits with status 2.

    python prepare.py --day normal-day.png --night normal-night.png \
        --halloween-day halloween-day.png --halloween-night halloween-night.png --out-dir out
    # -> out/normal/{day,night}.png and out/halloween/{day,night}.png
    python prepare.py --day day.png --night night.png --out-dir out   # one edition -> out/{day,night}.png
"""
import argparse
import hashlib
import json
import os
import sys
from collections import deque

import numpy as np
from PIL import Image

VERSION = "prepare-py/2"
CANVAS, BASELINE, TOP_MARGIN = 720, 651, 28
WORK = 1024
BASE_FILL, MAX_FILL, WIDE_MIN_HEIGHT = 0.84, 0.92, 0.60
VISIBLE = 0.06
KEY_INNER, KEY_OUTER = 38.0, 115.0
# The Halloween day is the normal day plus small decorations; below this the model was redrawn.
HALLOWEEN_MIN_OVERLAP = 0.80


class Fail(Exception):
    pass


def load(path, label):
    try:
        im = Image.open(path)
        im.load()
    except Exception as e:  # noqa: BLE001
        raise Fail(f"{label}: cannot read image ({e})")
    if min(im.size) < 512:
        raise Fail(f"{label}: {im.size[0]}x{im.size[1]} is below 512 px on the short side")
    im = im.convert("RGBA")
    scale = WORK / max(im.size)
    im = im.resize((round(im.size[0] * scale), round(im.size[1] * scale)), Image.LANCZOS)
    return np.asarray(im).astype(np.float32)


def border_mask(h, w):
    m = np.zeros((h, w), bool)
    m[0, :] = m[-1, :] = m[:, 0] = m[:, -1] = True
    return m


def matte(rgba, label):
    h, w, _ = rgba.shape
    border = border_mask(h, w)
    if (rgba[..., 3][border] < 16).mean() > 0.9:
        return rgba[..., 3] / 255.0, "source-alpha", None
    rgb = rgba[..., :3]
    bg = np.median(rgb[border], axis=0)
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    uniform = (dist[border] < KEY_OUTER * 0.6).mean()
    if uniform < 0.85:
        raise Fail(f"{label}: the edge of the image is not one flat colour ({uniform:.0%} match); ask for a flat backdrop (backdrop_not_flat)")
    candidate = dist < KEY_OUTER
    grow = dist < KEY_OUTER * 0.85
    seen = np.zeros((h, w), bool)
    q = deque()
    for y, x in zip(*np.nonzero(border & candidate)):
        seen[y, x] = True
        q.append((y, x))
    while q:
        y, x = q.popleft()
        if not grow[y, x]:
            continue
        for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
            if 0 <= ny < h and 0 <= nx < w and not seen[ny, nx] and candidate[ny, nx]:
                seen[ny, nx] = True
                q.append((ny, nx))
    alpha = np.ones((h, w), np.float32)
    alpha[seen] = np.clip((dist[seen] - KEY_INNER) / (KEY_OUTER - KEY_INNER), 0, 1)
    return alpha, "backdrop-key", bg


def unmix(rgba, alpha, bg):
    if bg is None:
        return
    edge = (alpha > 0) & (alpha < 1)
    alpha[edge & (alpha < 0.08)] = 0
    edge = (alpha > 0) & (alpha < 1)
    a = alpha[edge][:, None]
    rgba[..., :3][edge] = np.clip((rgba[..., :3][edge] - (1 - a) * bg) / a, 0, 255)


def drop_specks(alpha):
    h, w = alpha.shape
    vis = alpha >= VISIBLE
    labels = np.full((h, w), -1, np.int32)
    sizes = []
    for sy, sx in zip(*np.nonzero(vis)):
        if labels[sy, sx] != -1:
            continue
        lid = len(sizes)
        stack = [(sy, sx)]
        labels[sy, sx] = lid
        n = 0
        while stack:
            y, x = stack.pop()
            n += 1
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and vis[ny, nx] and labels[ny, nx] == -1:
                        labels[ny, nx] = lid
                        stack.append((ny, nx))
        sizes.append(n)
    if not sizes:
        return 0
    keep_min = max(48, max(sizes) * 0.01)
    small = np.array([s < keep_min for s in sizes])
    drop = (labels >= 0) & small[np.maximum(labels, 0)]
    removed = int(drop.sum())
    alpha[drop] = 0
    alpha[(labels == -1) & (alpha > 0)] = 0
    return removed


def bounds(alpha):
    ys, xs = np.nonzero(alpha >= VISIBLE)
    if not len(xs):
        return None
    return int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())


def choose_scale(w, h):
    scale = BASE_FILL * CANVAS / max(w, h)
    if w > h * 1.15:
        scale = min(max(scale, WIDE_MIN_HEIGHT * CANVAS / h), MAX_FILL * CANVAS / w)
    return min(scale, (BASELINE - TOP_MARGIN) / h)


def compose(rgba, alpha, box, scale):
    x0, y0, x1, y1 = box
    out = rgba.copy()
    out[..., 3] = alpha * 255
    sub = Image.fromarray(np.ascontiguousarray(out[y0 : y1 + 1, x0 : x1 + 1].round().astype(np.uint8)))
    w, h = max(1, round(sub.width * scale)), max(1, round(sub.height * scale))
    # Resize with premultiplied alpha so transparent pixels do not bleed colour.
    sub = sub.convert("RGBa").resize((w, h), Image.LANCZOS).convert("RGBA")
    canvas = Image.new("RGBA", (CANVAS, CANVAS), (0, 0, 0, 0))
    canvas.alpha_composite(sub, ((CANVAS - w) // 2, BASELINE - h))
    return canvas


def frame_problems(b, label):
    """Centred and grounded: checked on the box shared by all images of the place."""
    x0, _, x1, y1 = b
    problems = []
    if abs((x0 + x1) / 2 - (CANVAS - 1) / 2) > 12:
        problems.append(f"{label}: not centred")
    if abs(y1 + 1 - BASELINE) > 6:
        problems.append(f"{label}: not on the baseline")
    return problems


def check(img, label):
    a = np.asarray(img)[..., 3]
    problems = []
    if img.size != (CANVAS, CANVAS) or img.mode != "RGBA":
        problems.append("not 720x720 RGBA")
    if any(a[y, x] for y in (0, -1) for x in (0, -1)):
        problems.append("corners are not transparent")
    frac = (a == 0).mean()
    if not 0.2 < frac < 0.98:
        problems.append(f"transparent area {frac:.0%} is implausible")
    b = bounds(a / 255.0)
    if b is None:
        problems.append("no subject")
        return problems, None
    x0, y0, x1, y1 = b
    side = max(x1 - x0 + 1, y1 - y0 + 1) / CANVAS
    if not 0.4 <= side <= 0.92:
        problems.append(f"subject size {side:.0%} out of range")
    for size in (360, 240):
        small = np.asarray(img.resize((size, size), Image.LANCZOS)).astype(int)
        vis = small[..., 3] > 128
        # Only the rim counts: visible pixels within 2px of transparency. Magenta that
        # belongs to the building (a sign, a window) is not a fringe.
        clear = small[..., 3] < 16
        near = clear.copy()
        for _ in range(2):
            grown = near.copy()
            grown[1:, :] |= near[:-1, :]
            grown[:-1, :] |= near[1:, :]
            grown[:, 1:] |= near[:, :-1]
            grown[:, :-1] |= near[:, 1:]
            near = grown
        rim = vis & near
        mag = rim & (small[..., 0] > 200) & (small[..., 1] < 90) & (small[..., 2] > 200)
        if rim.any() and mag.sum() / rim.sum() > 0.01:
            problems.append(f"magenta fringe at {size}px")
    return [f"{label}: {p}" for p in problems], b


def write_pair(pair, out_dir, report):
    os.makedirs(out_dir, exist_ok=True)
    for slot, img in pair.items():
        path = os.path.join(out_dir, f"{slot}.png")
        img.save(path, "PNG", optimize=True)
        with open(path, "rb") as f:
            report[slot]["sha256"] = hashlib.sha256(f.read()).hexdigest()
        for size in (360, 240):
            img.resize((size, size), Image.LANCZOS).save(os.path.join(out_dir, f"preview-{slot}-{size}.png"))


def overlap(a, b):
    """Intersection over union of two visible masks."""
    va, vb = a >= VISIBLE, b >= VISIBLE
    union = (va | vb).sum()
    return float((va & vb).sum() / union) if union else 0.0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", required=True, help="normal-day image")
    ap.add_argument("--night", required=True, help="normal-night image")
    ap.add_argument("--halloween-day", help="halloween-day image, an edit of the accepted normal day")
    ap.add_argument("--halloween-night", help="halloween-night image, a relight of the halloween day")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    try:
        if bool(args.halloween_day) != bool(args.halloween_night):
            raise Fail("give both --halloween-day and --halloween-night, or neither")
        # Keys are (edition, lighting). All images share one crop and one scale, so the
        # normal and the Halloween model have exactly the same size on the site.
        paths = {("normal", "day"): args.day, ("normal", "night"): args.night}
        if args.halloween_day:
            paths[("halloween", "day")] = args.halloween_day
            paths[("halloween", "night")] = args.halloween_night
        imgs = {k: load(p, "-".join(k)) for k, p in paths.items()}
        if len({img.shape for img in imgs.values()}) != 1:
            raise Fail("the images have different shapes; each night must be an edit of its day and the Halloween day an edit of the normal day (shape_mismatch)")
        report = {"version": VERSION, "editions": {}}
        alphas, boxes = {}, {}
        for key, rgba in imgs.items():
            label = "-".join(key)
            alpha, method, bg = matte(rgba, label)
            unmix(rgba, alpha, bg)
            removed = drop_specks(alpha)
            box = bounds(alpha)
            if box is None:
                raise Fail(f"{label}: nothing left after removing the backdrop (empty)")
            h, w = alpha.shape
            if (box[2] - box[0] + 1) * (box[3] - box[1] + 1) / (w * h) > 0.97:
                raise Fail(f"{label}: the building fills the whole image; nothing to cut out (no_backdrop)")
            alphas[key], boxes[key] = alpha, box
            report["editions"].setdefault(key[0], {})[key[1]] = {
                "method": method, "backdrop": None if bg is None else [round(float(c)) for c in bg], "specks_removed": removed,
            }
        if ("halloween", "day") in alphas:
            iou = overlap(alphas[("normal", "day")], alphas[("halloween", "day")])
            report["halloween_overlap"] = round(iou, 3)
            if iou < HALLOWEEN_MIN_OVERLAP:
                raise Fail(
                    f"halloween-day: the model differs from the normal day ({iou:.0%} overlap); make it as an edit of the "
                    "accepted normal-day image that only adds decorations (halloween_redrawn)"
                )
        shared = (
            min(b[0] for b in boxes.values()), min(b[1] for b in boxes.values()),
            max(b[2] for b in boxes.values()), max(b[3] for b in boxes.values()),
        )
        scale = choose_scale(shared[2] - shared[0] + 1, shared[3] - shared[1] + 1)
        out = {k: compose(imgs[k], alphas[k], shared, scale) for k in imgs}
        problems, final_boxes = [], {}
        for key, img in out.items():
            p, b = check(img, "-".join(key))
            problems += p
            final_boxes[key] = b
        editions = sorted({k[0] for k in out}, key=lambda e: e != "normal")
        if all(final_boxes.values()):
            fb = list(final_boxes.values())
            union = (min(b[0] for b in fb), min(b[1] for b in fb), max(b[2] for b in fb), max(b[3] for b in fb))
            problems += frame_problems(union, "shared frame")
            # The normal model itself must still stand on the line, not float above it.
            problems += [p for p in frame_problems(final_boxes[("normal", "day")], "normal-day") if "baseline" in p]
        for edition in editions:
            d, n = final_boxes.get((edition, "day")), final_boxes.get((edition, "night"))
            if d and n:
                diff = max(abs(a - b) for a, b in zip(d, n))
                if diff > 4:
                    problems.append(f"{edition}: day and night do not share one frame ({diff}px apart)")
        if problems:
            raise Fail("; ".join(problems))
        out_dirs = {}
        for edition in editions:
            # Two editions: out/normal and out/halloween. One edition: out itself.
            out_dir = os.path.join(args.out_dir, edition) if len(editions) > 1 else args.out_dir
            pair = {lighting: out[(edition, lighting)] for lighting in ("day", "night")}
            write_pair(pair, out_dir, report["editions"][edition])
            out_dirs[edition] = out_dir
        report["transform"] = {"box": shared, "scale": round(scale, 5), "baseline": BASELINE, "shared_by": ["-".join(k) for k in out]}
        report["passed"] = True
        with open(os.path.join(args.out_dir, "report.json"), "w") as f:
            json.dump(report, f, indent=2)
        print(json.dumps({"ok": True, "validator_version": VERSION, "out_dirs": out_dirs, "report": report}, indent=2))
    except Fail as e:
        print(json.dumps({"ok": False, "validator_version": VERSION, "error": str(e)}, indent=2))
        sys.exit(2)


if __name__ == "__main__":
    main()
