export const MAX_BYTES = 256 * 1024;
export const manifest = {
  id: "org.anikatha.addon-bridge.mangadex", version: "3.1.0", anikathaProtocolVersion: 1,
  name: "AniKatha MangaDex Bridge", description: "MangaDex manga discovery. Anime sources are not yet configured.",
  types: ["anime", "manga"],
  resources: [
    { name: "catalog", types: ["manga"] },
    { name: "meta", types: ["manga"], idPrefixes: ["md:"] },
    { name: "meta", types: ["anime"], idPrefixes: ["anilist:"] },
    { name: "stream", types: ["anime"], idPrefixes: ["ep:"] },
    { name: "chapters", types: ["manga"], idPrefixes: ["md:"] },
    { name: "pages", types: ["manga"], idPrefixes: ["md:ch:"] }
  ],
  catalogs: [
    { type: "manga", id: "mangadex", name: "MangaDex", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] },
    { type: "manga", id: "manhwa", name: "Manhwa (Korean originals)", extra: [{ name: "search", isRequired: false }, { name: "skip", isRequired: false }] }
  ]
};

export class Failure extends Error { constructor(public status: number, message: string) { super(message); } }
export function json(data: unknown, status = 200, cache = false): Response {
  const text = JSON.stringify(data);
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) return json({ error: "Response exceeds 256 KiB" }, 502);
  return new Response(text, { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache ? "public, max-age=60" : "no-store", "access-control-allow-origin": "*" } });
}
export function id(value: string, prefix: string): string | null {
  if (!value.startsWith(prefix)) return null;
  const raw = value.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw) ? raw.toLowerCase() : null;
}
export function imageBase(value: unknown): { url: string; proxy: boolean } | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (u.protocol !== "https:" || u.username || u.password || u.hash || u.search || u.port) return null;
    const official = u.hostname === "mangadex.org" || u.hostname.endsWith(".mangadex.org");
    const network = u.hostname.endsWith(".mangadex.network");
    if (!official && !network) return null;
    return { url: u.toString().replace(/\/$/, ""), proxy: network };
  } catch { return null; }
}
export function segment(value: unknown): value is string {
  return typeof value === "string" && value.length <= 255 && value !== "." && value !== ".." && /^[a-zA-Z0-9._-]+$/.test(value);
}
