import { Failure, id, json } from "./contract";
import { manifest, parseExtras } from "./catalog";
import { MangaDex, type Env } from "./mangadex";
export { RateGate } from "./rate";
export { PageStore } from "./pages";
export { ReportQueue } from "./reports";
import { image } from "./pages";
import { cover } from "./covers";

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const u = new URL(request.url);
  const path = u.pathname;
  if (path === "/anikatha/manifest.json") return json(manifest, 200, true);
  const md = new MangaDex(env, Date.now() + 17_000, fetch, ctx, u.origin);
  try {
    const catalog = path.match(/^\/anikatha\/catalog\/manga\/([a-z-]+)(?:\/([^/]+))?\.json$/);
    if (catalog && manifest.catalogs.some(entry => entry.id === catalog[1]))
      return json(await md.search(catalog[1], parseExtras(catalog[2])), 200, !manifest.catalogs.find(entry => entry.id === catalog[1])?.ranking);
    const coverMatch = path.match(/^\/anikatha\/media\/cover\/([0-9a-f-]+)\/([^/]+)$/i);
    if (coverMatch) {
      const uuid = id(coverMatch[1], "");
      if (!uuid) return json({ error: "Cover not found" }, 404);
      return await cover(uuid, decodeURIComponent(coverMatch[2]));
    }
    const imageMatch = path.match(/^\/anikatha\/media\/manga\/([0-9a-f-]+)\/(\d+)$/i);
    if (imageMatch) return await image(env, ctx, imageMatch[1].toLowerCase(), (u.searchParams.get("assignment") ?? "").toLowerCase(), imageMatch[2]);
    const match = path.match(/^\/anikatha\/(meta|chapters|pages)\/manga\/([^/]+)\.json$/);
    if (match) {
      const [, resource, raw] = match;
      const identifier = id(decodeURIComponent(raw), resource === "pages" ? "md:ch:" : "md:");
      if (!identifier) return json({ error: "Not found" }, 404);
      const data = resource === "meta" ? await md.meta(identifier) : resource === "chapters" ? await md.chapters(identifier) : await md.pages(identifier, u.origin);
      return data === null ? json({ error: "Not found" }, 404) : json(data, 200, resource !== "pages");
    }
    return json({ error: "Not found" }, 404); // Includes unconfigured anime endpoints.
  } catch (error) {
    if (error instanceof URIError) return json({ error: "Invalid encoding" }, 400);
    if (error instanceof Failure) return json({ error: error.message }, error.status);
    return json({ error: "Upstream or internal service unavailable" }, 503);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") return json({ error: "GET only" }, 405);
    const path = new URL(request.url).pathname;
    // Per-location HTTP caching supplements KV. Never cache at-home page URLs.
    const ranked = /^\/anikatha\/catalog\/manga\/(top-rated|popular-manga|popular-manhwa)[./]/.test(path);
    const eligible = path === "/anikatha/manifest.json" || (path.startsWith("/anikatha/catalog/") && !ranked)
      || path.startsWith("/anikatha/media/cover/") || path.startsWith("/anikatha/meta/manga/") || path.startsWith("/anikatha/chapters/manga/");
    const cache = eligible && typeof caches !== "undefined" ? (caches as unknown as { default: Cache }).default : undefined;
    if (cache) { try { const hit = await cache.match(request); if (hit) return hit; } catch { /* cache unavailable */ } }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<Response>(resolve => { timer = setTimeout(() => resolve(json({ error: "Request deadline exceeded" }, 503)), 19_000); });
    const result = await Promise.race([route(request, env, ctx), timeout]);
    if (timer) clearTimeout(timer);
    if (cache && result.ok) ctx.waitUntil(cache.put(request, result.clone()).catch(() => {}));
    return result;
  }
};
