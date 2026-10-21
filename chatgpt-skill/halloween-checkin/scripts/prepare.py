#!/usr/bin/env python3
"""Prepare a host-generated day/night pair into the final 720x720 transparent PNGs.

Runs inside ChatGPT's offline sandbox (Pillow + NumPy only). Same rules as
pipeline/prepare.js in the repository:
  - keep a real alpha channel if the image has one; otherwise remove the flat
    backdrop that is connected to the image edge (a flood fill from the border),
    so backdrop-coloured details inside the building survive;
  - unmix the backdrop colour from semi-transparent edge pixels (no halo);
  - drop small detached specks;
  - one shared transform for day and night: centred horizontally, standing on y=651.
Then the same mechanical checks the site applies. On any failure it writes nothing
and exits with status 2.

    python prepare.py --day day.png --night night.png --out-dir out
"""
import argparse
import hashlib
import json
import os
import sys
from collections import deque

import numpy as np
from PIL import Image

VERSION = "prepare-py/1"
CANVAS, BASELINE, TOP_MARGIN = 720, 651, 28
WORK = 1024
BASE_FILL, MAX_FILL, WIDE_MIN_HEIGHT = 0.84, 0.92, 0.60
VISIBLE = 0.06
KEY_INNER, KEY_OUTER = 38.0, 115.0


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
    if abs((x0 + x1) / 2 - (CANVAS - 1) / 2) > 12:
        problems.append("not centred")
    if abs(y1 + 1 - BASELINE) > 6:
        problems.append("not on the baseline")
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--day", required=True)
    ap.add_argument("--night", required=True)
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()
    try:
        imgs = {"day": load(args.day, "day"), "night": load(args.night, "night")}
        if imgs["day"].shape != imgs["night"].shape:
            raise Fail("day and night have different shapes; night must be an edit of day (shape_mismatch)")
        report = {"version": VERSION, "slots": {}}
        alphas, boxes = {}, {}
        for slot, rgba in imgs.items():
            alpha, method, bg = matte(rgba, slot)
            unmix(rgba, alpha, bg)
            removed = drop_specks(alpha)
            box = bounds(alpha)
            if box is None:
                raise Fail(f"{slot}: nothing left after removing the backdrop (empty)")
            h, w = alpha.shape
            if (box[2] - box[0] + 1) * (box[3] - box[1] + 1) / (w * h) > 0.97:
                raise Fail(f"{slot}: the building fills the whole image; nothing to cut out (no_backdrop)")
            alphas[slot], boxes[slot] = alpha, box
            report["slots"][slot] = {"method": method, "backdrop": None if bg is None else [round(float(c)) for c in bg], "specks_removed": removed}
        shared = (
            min(boxes["day"][0], boxes["night"][0]), min(boxes["day"][1], boxes["night"][1]),
            max(boxes["day"][2], boxes["night"][2]), max(boxes["day"][3], boxes["night"][3]),
        )
        scale = choose_scale(shared[2] - shared[0] + 1, shared[3] - shared[1] + 1)
        out = {slot: compose(imgs[slot], alphas[slot], shared, scale) for slot in imgs}
        problems, final_boxes = [], {}
        for slot, img in out.items():
            p, b = check(img, slot)
            problems += p
            final_boxes[slot] = b
        if final_boxes["day"] and final_boxes["night"]:
            diff = max(abs(a - b) for a, b in zip(final_boxes["day"], final_boxes["night"]))
            if diff > 4:
                problems.append(f"day and night do not share one frame ({diff}px apart)")
        if problems:
            raise Fail("; ".join(problems))
        os.makedirs(args.out_dir, exist_ok=True)
        for slot, img in out.items():
            path = os.path.join(args.out_dir, f"{slot}.png")
            img.save(path, "PNG", optimize=True)
            with open(path, "rb") as f:
                report["slots"][slot]["sha256"] = hashlib.sha256(f.read()).hexdigest()
            for size in (360, 240):
                img.resize((size, size), Image.LANCZOS).save(os.path.join(args.out_dir, f"preview-{slot}-{size}.png"))
        report["transform"] = {"box": shared, "scale": round(scale, 5), "baseline": BASELINE}
        report["passed"] = True
        with open(os.path.join(args.out_dir, "report.json"), "w") as f:
            json.dump(report, f, indent=2)
        print(json.dumps({"ok": True, "validator_version": VERSION, "out_dir": args.out_dir, "report": report}, indent=2))
    except Fail as e:
        print(json.dumps({"ok": False, "validator_version": VERSION, "error": str(e)}, indent=2))
        sys.exit(2)


if __name__ == "__main__":
    main()
