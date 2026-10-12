// Pure view logic for the site: no DOM, no network. Everything that decides
// *what* is shown (caption wording, time semantics, edition fallback) lives
// here so it can be unit-tested.

export const EDITIONS = ["normal", "halloween"];

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
    back: "Back",
    normal: "Normal",
    halloween: "Halloween",
    noEdition: (e) => `No ${e} edition for this place yet.`,
    toDark: "Night",
    toLight: "Day",
    schemeLabel: (night) => (night ? "Switch to day" : "Switch to night"),
    mood: "Mood",
    moodLabel: "Halloween mood (decoration only)",
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
    back: "返回",
    normal: "普通",
    halloween: "万圣节",
    noEdition: (e) => `这个地方还没有${e}版。`,
    toDark: "夜晚",
    toLight: "白天",
    schemeLabel: (night) => (night ? "切换到白天" : "切换到夜晚"),
    mood: "氛围",
    moodLabel: "万圣节氛围（仅装饰）",
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

export function editionsOf(checkin) {
  return EDITIONS.filter((e) => checkin.variants.some((v) => v.theme === e));
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
