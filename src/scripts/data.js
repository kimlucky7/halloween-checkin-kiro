// The only network access of the site. Both calls are GETs of public data.

export async function loadCheckins() {
  const res = await fetch("/api/checkins", { headers: { accept: "application/json" }, cache: "no-store" });
  if (!res.ok) throw new Error(`list returned ${res.status}`);
  const body = await res.json();
  return Array.isArray(body?.checkins) ? body.checkins.filter((c) => Array.isArray(c.variants) && c.variants.length) : [];
}

/** Used only when the visitor presses Share: fetches the picture already on screen. */
export async function loadImageBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image returned ${res.status}`);
  return res.blob();
}
