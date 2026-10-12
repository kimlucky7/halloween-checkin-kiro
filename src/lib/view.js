// Pure view logic for the site: no DOM, no network. Everything that decides
// *what* is shown (caption wording, time semantics, edition fallback) lives
// here so it can be unit-tested.

export const STRINGS = {
  en: {
    spotted: "Spotted at",
    spottedNoPlace: "Spotted somewhere",
    added: "Added",
    addedNoPlace: "Added a place",
    with: "with",
    and: "and",
    end: ".",
    sep: " · ",
    unknownCapture: "Capture time unknown — this is when it was published",
    share: "Share",
    shared: "Saved",
    all: (n) => `Show all ${n} places`,
    schemeLabel: (night) => (night ? "Switch to day" : "Switch to night (Halloween)"),
    lang: "中文",
    langLabel: "切换到中文",
    empty: "Nothing here yet.",
    error: "Could not load the places.",
    retry: "Retry",
    view: (name) => `Show ${name}`,
    alt: (edition, lighting, place) =>
      `${edition === "halloween" ? "Halloween " : ""}${lighting === "night" ? "night" : "day"} miniature of ${place ?? "a place"}`,
    footnote: "Pictures are made by an AI image tool outside this site and reviewed before they are published.",
  },
  zh: {
    spotted: "出没于",
    spottedNoPlace: "出没于某处",
    added: "收藏了",
    addedNoPlace: "收藏了一个地方",
    with: "和",
    and: "、",
    end: "。",
    sep: " · ",
    unknownCapture: "拍摄时间未知，这是发布时间",
    share: "分享",
    shared: "已保存",
    all: (n) => `展开全部 ${n} 个地点`,
    schemeLabel: (night) => (night ? "切换到白天" : "切换到夜晚（万圣节）"),
    lang: "EN",
    langLabel: "Switch to English",
    empty: "这里还没有内容。",
    error: "无法加载地点。",
    retry: "重试",
    view: (name) => `查看${name}`,
    alt: (edition, lighting, place) =>
      `${place ?? "某个地方"}的${edition === "halloween" ? "万圣节" : ""}${lighting === "night" ? "夜景" : "白天"}微缩模型`,
    footnote: "图片由站外的 AI 图像工具生成，审核后才发布。",
  },
};

const UNITS = [
  ["year", 365 * 86400],
  ["month", 30 * 86400],
  ["week", 7 * 86400],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];

export function relativeTime(iso, now, lang = "en") {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  const rtf = new Intl.RelativeTimeFormat(lang === "zh" ? "zh-CN" : "en", { numeric: "auto" });
  for (const [unit, size] of UNITS) {
    if (seconds >= size) return rtf.format(-Math.floor(seconds / size), unit);
  }
  return lang === "zh" ? "刚刚" : "just now";
}

/** Newest first; stable for equal times. */
export function sortCheckins(checkins) {
  return [...checkins].sort((a, b) => (timeOf(b) - timeOf(a)) || (a.id < b.id ? -1 : 1));
}

function timeOf(c) {
  return Date.parse(c.capturedAt ?? c.publishedAt) || 0;
}

/** Which variant to show. Never invents one; reports when the wish is unavailable. */
export function pickVariant(checkin, edition) {
  const exact = checkin.variants.find((v) => v.theme === edition);
  if (exact) return { variant: exact, available: true };
  const fallback = checkin.variants.find((v) => v.theme === "normal") ?? checkin.variants[0] ?? null;
  return { variant: fallback, available: false };
}

/**
 * The sentence under the picture, as a list of parts so the DOM layer can
 * style them without parsing text.
 * Capture time known → "Spotted at …"; unknown → "Added …" with the publication time,
 * so a publication time is never presented as the moment the photo was taken.
 */
export function caption(checkin, now, lang = "en") {
  const s = STRINGS[lang];
  const known = Boolean(checkin.capturedAt);
  const place = checkin.place?.name ?? null;
  const parts = [];
  if (place) {
    parts.push({ kind: "text", value: `${known ? s.spotted : s.added} ` });
    parts.push({ kind: "place", value: place, href: mapsUrl(checkin.place) });
  } else {
    parts.push({ kind: "text", value: known ? s.spottedNoPlace : s.addedNoPlace });
  }
  const people = checkin.companions ?? [];
  if (people.length) {
    parts.push({ kind: "text", value: ` ${s.with} ` });
    people.forEach((name, i) => {
      if (i > 0) parts.push({ kind: "text", value: i === people.length - 1 && lang === "en" ? ` ${s.and} ` : lang === "en" ? ", " : s.and });
      parts.push({ kind: "person", value: name });
    });
  }
  parts.push({ kind: "text", value: s.sep });
  parts.push({
    kind: "time",
    value: relativeTime(known ? checkin.capturedAt : checkin.publishedAt, now, lang),
    datetime: known ? checkin.capturedAt : checkin.publishedAt,
    title: known ? null : s.unknownCapture,
  });
  parts.push({ kind: "text", value: s.end });
  return parts;
}

/** A map search link built only from facts the record states. */
export function mapsUrl(place) {
  if (!place?.name) return null;
  const hasPoint = Number.isFinite(place.lat) && Number.isFinite(place.lng);
  const query = hasPoint ? `${place.lat},${place.lng}` : [place.name, place.address].filter(Boolean).join(", ");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

export function shareFileName(checkin, edition, lighting) {
  const safe = String(checkin.id).replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "checkin";
  return `halloween-checkin-${safe}-${edition}-${lighting}.png`;
}

export function shortDate(iso, lang = "en") {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  return new Intl.DateTimeFormat(lang === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", year: "numeric" }).format(ms);
}

/**
 * How large and how opaque a picture in the strip is, from its distance to the
 * middle measured in picture widths (0 = centred).
 */
export function depthFor(offset) {
  const d = Math.min(Math.abs(offset), 2);
  const side = Math.sign(offset);
  return {
    scale: 1 - Math.min(d, 1.5) * 0.14,
    opacity: 1 - d * 0.28,
    // Turn slightly toward the middle, like pictures on a curved shelf.
    tilt: -side * Math.min(d, 1.2) * 14,
    // Labels drift a little against the motion for depth.
    shift: -offset * 10 * Math.min(1, d),
  };
}

/** Night shows the Halloween edition (when a place has one), day shows the normal edition. */
export function modeEdition(night) {
  return night ? "halloween" : "normal";
}

/**
 * Next index when moving through places that wrap around.
 * `dir` +1 moves right, toward newer places; -1 moves left, toward older ones.
 * Index 0 is the newest place.
 */
export function stepIndex(index, dir, count) {
  if (count <= 0) return 0;
  return dir > 0 ? (index - 1 + count) % count : (index + 1) % count;
}

/** Index of the value closest to `target` (first one wins a tie). -1 for an empty list. */
export function nearestTo(values, target) {
  let best = -1;
  let distance = Infinity;
  values.forEach((v, i) => {
    const d = Math.abs(v - target);
    if (d < distance) {
      distance = d;
      best = i;
    }
  });
  return best;
}

/** How far to move the scroll position to land on the home copy of a looped list. */
export function loopShift(copy, home, period) {
  return (home - copy) * period;
}
