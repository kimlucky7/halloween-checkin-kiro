// The subset of the Workers KV API used by @cloudflare/workers-oauth-provider,
// stored in a D1 table (migration 0003). Expired rows are invisible and removed lazily.

const MAX_LIST = 1000;

export function d1Kv(db, { now = () => Date.now() } = {}) {
  const live = "(expires_at IS NULL OR expires_at > ?)";
  const expiry = (options = {}) => {
    if (Number.isFinite(options.expiration)) return Math.floor(options.expiration * 1000);
    if (Number.isFinite(options.expirationTtl)) return now() + Math.floor(options.expirationTtl * 1000);
    return null;
  };

  return {
    async get(key, options) {
      const type = typeof options === "string" ? options : options?.type ?? "text";
      const row = await db.prepare(`SELECT value FROM hc_oauth_kv WHERE key = ? AND ${live}`).bind(String(key), now()).first();
      if (!row) return null;
      if (type === "json") {
        try {
          return JSON.parse(row.value);
        } catch {
          return null;
        }
      }
      return row.value;
    },

    async put(key, value, options = {}) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      const metadata = options.metadata === undefined ? null : JSON.stringify(options.metadata);
      await db
        .prepare(
          "INSERT INTO hc_oauth_kv (key, value, metadata, expires_at) VALUES (?, ?, ?, ?) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, metadata = excluded.metadata, expires_at = excluded.expires_at",
        )
        .bind(String(key), text, metadata, expiry(options))
        .run();
    },

    async delete(key) {
      await db.prepare("DELETE FROM hc_oauth_kv WHERE key = ?").bind(String(key)).run();
    },

    async list({ prefix = "", limit = MAX_LIST, cursor } = {}) {
      const size = Math.max(1, Math.min(MAX_LIST, Number(limit) || MAX_LIST));
      const after = cursor ? decodeURIComponent(atob(cursor)) : "";
      // Prefix match without LIKE wildcards: [prefix, prefix + U+FFFF).
      const rows = (
        await db
          .prepare(`SELECT key, metadata, expires_at FROM hc_oauth_kv WHERE key >= ? AND key < ? AND key > ? AND ${live} ORDER BY key LIMIT ?`)
          .bind(prefix, prefix + "\uffff", after, now(), size + 1)
          .all()
      ).results;
      const page = rows.slice(0, size);
      const done = rows.length <= size;
      return {
        keys: page.map((r) => ({
          name: r.key,
          ...(r.expires_at ? { expiration: Math.floor(r.expires_at / 1000) } : {}),
          ...(r.metadata ? { metadata: JSON.parse(r.metadata) } : {}),
        })),
        list_complete: done,
        ...(done ? {} : { cursor: btoa(encodeURIComponent(page.at(-1).key)) }),
      };
    },

    /** Remove expired rows (called opportunistically). */
    async sweep() {
      await db.prepare("DELETE FROM hc_oauth_kv WHERE expires_at IS NOT NULL AND expires_at <= ?").bind(now()).run();
    },
  };
}
