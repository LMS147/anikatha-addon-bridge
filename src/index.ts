import { Failure, id, json, manifest } from "./contract";
import { MangaDex, type Env } from "./mangadex";
export { RateGate } from "./rate";
export { PageStore } from "./pages";
import { image } from "./pages";

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (request.method !== "GET") return json({ error: "GET only" }, 405);
  const u = new URL(request.url);
  const path = u.pathname;
  if (path === "/anikatha/manifest.json") return json(manifest, 200, true);
  const md = new MangaDex(env, Date.now() + 17_000);
  try {
    const browse = path.match(/^\/anikatha\/catalog\/manga\/(mangadex|manhwa)\.json$/);
    if (browse) return json(await md.search("", 0, browse[1] === "manhwa"), 200, true);
    const catalog = path.match(/^\/anikatha\/catalog\/manga\/(mangadex|manhwa)\/([^/]+)\.json$/);
    if (catalog) {
      let q = "", skip = 0;
      const seen = new Set<string>();
      for (const part of catalog[2].split("&")) {
        const i = part.indexOf("=");
        if (i < 0) throw new Failure(400, "Invalid extras");
        const key = decodeURIComponent(part.slice(0, i)), value = decodeURIComponent(part.slice(i + 1));
        if (seen.has(key)) throw new Failure(400, "Duplicate extras");
        seen.add(key);
        if (key === "search" && value.length <= 200) q = value;
        else if (key === "skip" && /^\d{1,4}$/.test(value) && Number(value) <= 9980) skip = Number(value);
        else throw new Failure(400, "Invalid extras");
      }
      return json(await md.search(q, skip, catalog[1] === "manhwa"), 200, true);
    }
    const imageMatch = path.match(/^\/anikatha\/image\/([0-9a-f-]+)\/([0-9a-f-]+)\/(\d+)\.jpg$/i);
    if (imageMatch) return await image(env, ctx, imageMatch[1].toLowerCase(), imageMatch[2].toLowerCase(), imageMatch[3]);
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
    const eligible = path === "/anikatha/manifest.json" || path.startsWith("/anikatha/catalog/") || path.startsWith("/anikatha/meta/manga/") || path.startsWith("/anikatha/chapters/manga/");
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
