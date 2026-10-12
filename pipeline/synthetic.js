// Synthetic miniature fixtures. Everything here is drawn from code: no photos,
// no real places, no external service. Output is labelled synthetic wherever it
// is surfaced (see SYNTHETIC_LABEL).
import sharp from "sharp";

export const SYNTHETIC_LABEL = "synthetic-demo";
const SIZE = 720;

function palette(lighting, theme) {
  const day = lighting === "day";
  return {
    wall: day ? (theme === "halloween" ? "#d9a066" : "#e8d9b5") : "#3b3a5c",
    roof: day ? (theme === "halloween" ? "#5a2d82" : "#b5543c") : "#241f3d",
    door: day ? "#7a4a2b" : "#2a1d2e",
    window: day ? "#9fd0ee" : "#ffd36a",
    sign: day ? "#2f6f4f" : "#1f4a37",
    trim: day ? "#ffffff" : "#c8c8e0",
  };
}

// Shared geometry for day and night: night only relights, as the design requires.
function houseSvg({ lighting, theme, variant = 0 }) {
  const c = palette(lighting, theme);
  const wide = variant % 2 === 0 ? 400 : 340;
  const left = (SIZE - wide) / 2;
  const bottom = 651;
  const bodyTop = bottom - 250;
  const pumpkin =
    theme === "halloween"
      ? `<g><ellipse cx="${left + wide + 10}" cy="${bottom - 28}" rx="34" ry="28" fill="${lighting === "day" ? "#e8791c" : "#c4630f"}"/>
         <rect x="${left + wide + 7}" y="${bottom - 62}" width="7" height="12" fill="#3b5a1f"/>
         <polygon points="${left + wide - 6},${bottom - 36} ${left + wide + 4},${bottom - 36} ${left + wide - 1},${bottom - 26}" fill="${lighting === "day" ? "#5a2d0a" : "#ffd36a"}"/>
         <polygon points="${left + wide + 16},${bottom - 36} ${left + wide + 26},${bottom - 36} ${left + wide + 21},${bottom - 26}" fill="${lighting === "day" ? "#5a2d0a" : "#ffd36a"}"/></g>`
      : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
    <rect x="${left}" y="${bodyTop}" width="${wide}" height="250" rx="6" fill="${c.wall}"/>
    <polygon points="${left - 24},${bodyTop} ${SIZE / 2},${bodyTop - 110} ${left + wide + 24},${bodyTop}" fill="${c.roof}"/>
    <rect x="${left + 40}" y="${bodyTop + 24}" width="${wide - 80}" height="48" rx="4" fill="${c.sign}"/>
    <rect x="${left + 52}" y="${bodyTop + 36}" width="${wide - 104}" height="24" rx="2" fill="${c.trim}" opacity="0.9"/>
    <rect x="${left + 36}" y="${bodyTop + 110}" width="86" height="76" rx="3" fill="${c.window}"/>
    <rect x="${left + wide - 122}" y="${bodyTop + 110}" width="86" height="76" rx="3" fill="${c.window}"/>
    <rect x="${SIZE / 2 - 30}" y="${bodyTop + 150}" width="60" height="100" rx="3" fill="${c.door}"/>
    ${pumpkin}
  </svg>`;
}

/** @returns {Promise<Buffer>} 720x720 RGBA PNG with a real transparent background */
export async function syntheticMiniature({ lighting, theme = "normal", variant = 0 }) {
  return sharp(Buffer.from(houseSvg({ lighting, theme, variant })))
    .ensureAlpha()
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * A raw "generator output" for preparation tests: the same house, placed off-centre
 * at another scale on a flat backdrop (or real transparency), like an image tool
 * would return it. `detail` adds a backdrop-coloured window inside the building.
 */
export async function syntheticRaw({ lighting, theme = "normal", variant = 0, size = 1024, backdrop = "#ff00ff", scale = 1.1, dx = -60, dy = -90, detail = false, speck = false, height }) {
  const inner = houseSvg({ lighting, theme, variant })
    .replace(/^<svg[^>]*>/, "")
    .replace(/<\/svg>\s*$/, "");
  const h = height ?? size;
  const extra = detail ? `<rect x="250" y="530" width="40" height="40" fill="${backdrop}"/>` : "";
  const dot = speck ? `<rect x="${size - 30}" y="20" width="3" height="3" fill="#222"/>` : "";
  const bg = backdrop ? `<rect width="${size}" height="${h}" fill="${backdrop}"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${h}">${bg}
    <g transform="translate(${(size - SIZE * scale) / 2 + dx} ${(h - SIZE * scale) / 2 + dy}) scale(${scale})">${inner}${extra}</g>${dot}</svg>`;
  return sharp(Buffer.from(svg)).ensureAlpha().png().toBuffer();
}

export async function syntheticPair({ theme = "normal", variant = 0 } = {}) {
  const [day, night] = await Promise.all([
    syntheticMiniature({ lighting: "day", theme, variant }),
    syntheticMiniature({ lighting: "night", theme, variant }),
  ]);
  return { day, night, label: SYNTHETIC_LABEL };
}
