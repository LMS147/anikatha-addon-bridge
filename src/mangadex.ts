import { Failure, MAX_BYTES, officialImageBase, segment } from "./contract";
export interface Env { CACHE: KVNamespace; RATE_GATE: DurableObjectNamespace; }
type Item = { id: string; attributes: Record<string, unknown> };
type Collection = { data: Item[]; total: number };
const API = "https://api.mangadex.org/";

function guard(condition: unknown): asserts condition { if (!condition) throw new Failure(502, "Invalid MangaDex response"); }
function title(item: Item) {
  guard(item && typeof item.id === "string" && /^[\da-f-]{36}$/i.test(item.id));
  const titles = item.attributes?.title as Record<string, string> | undefined;
  guard(titles && typeof titles === "object");
  const name = titles.en || Object.values(titles).find(x => typeof x === "string" && x.length);
  guard(typeof name === "string" && name.length > 0);
  return { id: `md:${item.id.toLowerCase()}`, type: "manga", name };
}

export class MangaDex {
  constructor(private env: Env, private deadline: number, private upstream: typeof fetch = fetch) {}
  private async cacheKey(path: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
    return "md:v1:" + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
  }
  private async get<T>(path: string, cacheable: boolean, home = false): Promise<T | null> {
    const key = cacheable ? await this.cacheKey(path) : "";
    if (key && this.env.CACHE) {
      try { const hit = await this.env.CACHE.get<T>(key, "json"); if (hit !== null) return hit; } catch { /* KV is a best-effort cache */ }
    }
    if (!this.env.RATE_GATE) throw new Failure(503, "Global limiter is not configured");
    const gate = this.env.RATE_GATE.get(this.env.RATE_GATE.idFromName("global"));
    const reservation = await gate.fetch("https://rate.internal/", { method: "POST", body: JSON.stringify({ home, deadline: this.deadline }) });
    if (!reservation.ok) throw new Failure(503, "Upstream rate limit queue full");
    const { delay } = await reservation.json<{ delay: number }>();
    if (!Number.isFinite(delay) || delay < 0 || Date.now() + delay >= this.deadline - 1000) throw new Failure(503, "Upstream deadline exceeded");
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    let response: Response;
    try {
      const upstream = this.upstream;
      response = await upstream(API + path, { headers: { "user-agent": "AniKathaAddonBridge/3.0 (+https://github.com/LMS147/anikatha-addon-bridge)", accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(Math.max(1, this.deadline - Date.now())) });
    } catch { throw new Failure(503, "MangaDex unavailable or timed out"); }
    if (response.status === 404) return null;
    if (!response.ok) throw new Failure(503, "MangaDex unavailable");
    const size = Number(response.headers.get("content-length") || 0);
    if (size > 2 * 1024 * 1024) throw new Failure(502, "MangaDex response too large");
    let result: T;
    try {
      const data = await response.arrayBuffer();
      if (data.byteLength > 2 * 1024 * 1024) throw new Failure(502, "MangaDex response too large");
      result = JSON.parse(new TextDecoder().decode(data)) as T;
    } catch (e) { if (e instanceof Failure) throw e; throw new Failure(502, "Invalid MangaDex JSON"); }
    if (key && this.env.CACHE) {
      try { await this.env.CACHE.put(key, JSON.stringify(result), { expirationTtl: 600 }); } catch { /* cache failure is not an upstream failure */ }
    }
    return result;
  }
  async search(q: string, skip: number) {
    const params = new URLSearchParams({ limit: "20", offset: String(skip) });
    params.append("contentRating[]", "safe"); params.append("contentRating[]", "suggestive");
    if (q) params.set("title", q);
    const data = await this.get<Collection>(`manga?${params}`, true);
    guard(data && Array.isArray(data.data));
    return { metas: data.data.map(title) };
  }
  async meta(id: string) {
    const data = await this.get<{ data: Item }>(`manga/${id}`, true);
    return data ? { meta: title(data.data) } : null;
  }
  async chapters(id: string) {
    if (!await this.get(`manga/${id}`, true)) return null;
    const chapters: { id: string; title: string }[] = [];
    for (let offset = 0; offset < 10_000; offset += 100) {
      const data = await this.get<Collection>(`manga/${id}/feed?limit=100&offset=${offset}&order%5Bchapter%5D=asc`, true);
      if (!data) return null;
      guard(Array.isArray(data.data) && Number.isInteger(data.total));
      for (const row of data.data) {
        guard(row && typeof row.id === "string" && /^[\da-f-]{36}$/i.test(row.id) && row.attributes);
        const { chapter, title: name, translatedLanguage } = row.attributes;
        chapters.push({ id: `md:ch:${row.id.toLowerCase()}`, title: `Chapter${typeof chapter === "string" ? " " + chapter : ""}${typeof name === "string" && name ? " — " + name : ""}${typeof translatedLanguage === "string" && translatedLanguage ? " [" + translatedLanguage + "]" : ""}` });
      }
      if (new TextEncoder().encode(JSON.stringify({ chapters })).length > MAX_BYTES) throw new Failure(502, "Chapter response too large");
      if (offset + data.data.length >= data.total) return { chapters };
      guard(data.data.length > 0);
    }
    throw new Failure(502, "MangaDex feed exceeds supported pagination");
  }
  async pages(id: string) {
    // No KV caching: assignments are client/location sensitive and expire.
    const data = await this.get<{ baseUrl: unknown; chapter: { hash: unknown; data: unknown[] } }>(`at-home/server/${id}?forcePort443=true`, false, true);
    if (!data) return null;
    const base = officialImageBase(data.baseUrl);
    // AniKatha does not report image retrievals. Never return third-party @Home
    // nodes without compliant per-image reporting; a safe proxy is future work.
    if (!base) throw new Failure(503, "MangaDex at-home reporting is required for this server; page proxy not configured");
    guard(data.chapter && segment(data.chapter.hash) && Array.isArray(data.chapter.data));
    const hash = data.chapter.hash;
    const pages = data.chapter.data.map(filename => { guard(segment(filename)); return `${base}/data/${hash}/${filename}`; });
    if (!pages.length) return null;
    return { pages, expiresAt: new Date(Date.now() + 600_000).toISOString() };
  }
}
