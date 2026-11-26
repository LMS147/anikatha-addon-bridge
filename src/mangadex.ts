import { Failure, MAX_BYTES, imageBase, segment } from "./contract";
export interface Env { CACHE: KVNamespace; RATE_GATE: DurableObjectNamespace; PAGE_STORE: DurableObjectNamespace; REPORT_QUEUE: DurableObjectNamespace; }
import { pageStore } from "./pages";
import { verifiedShelf, type VerifiedShelf } from "./verified-formats";
import { applyFilters, normalizedTags, title, PAGE_SIZE, RATED_LIMIT, type CatalogTitle, type Entity } from "./catalog";

type Collection = { data: Entity[]; total: number };
type Rating = { average?: unknown; bayesian?: unknown };
type Statistics = { statistics?: Record<string, { rating?: Rating }> };
const API = "https://api.mangadex.org/";

function guard(condition: unknown): asserts condition { if (!condition) throw new Failure(502, "Invalid MangaDex response"); }

function communityScore(rating: Rating | undefined): number | null | undefined {
  if (rating?.average === null) return null;
  const weighted = rating?.bayesian;
  if (typeof rating?.average === "number" && rating.average >= 1 && rating.average <= 10 &&
      typeof weighted === "number" && weighted >= 1 && weighted <= 10)
    return Math.round(weighted * 10);
}

export class MangaDex {
  constructor(private env: Env, private deadline: number, private upstream: typeof fetch = fetch,
              private context?: Pick<ExecutionContext, "waitUntil">, private origin?: string) {}
  private async cacheKey(path: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(path));
    return "md:v1:" + [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, "0")).join("");
  }
  private async get<T>(path: string, cacheable: boolean, home = false, deadline = this.deadline): Promise<T | null> {
    const key = cacheable ? await this.cacheKey(path) : "";
    if (key) {
      const hit = await this.readCache<T>(key);
      if (hit !== null) return hit;
    }
    if (!this.env.RATE_GATE) throw new Failure(503, "Global limiter is not configured");
    const gate = this.env.RATE_GATE.get(this.env.RATE_GATE.idFromName("global"));
    const reservation = await gate.fetch("https://rate.internal/", { method: "POST", body: JSON.stringify({ home, deadline }) });
    if (!reservation.ok) throw new Failure(503, "Upstream rate limit queue full");
    const { delay } = await reservation.json<{ delay: number }>();
    if (!Number.isFinite(delay) || delay < 0 || Date.now() + delay >= deadline - 1000) throw new Failure(503, "Upstream deadline exceeded");
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    let response: Response;
    try {
      const upstream = this.upstream;
      response = await upstream(API + path, { headers: { "user-agent": "AniKathaAddonBridge/3.0 (+https://github.com/LMS147/anikatha-addon-bridge)", accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())) });
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
    if (key) await this.writeCache(key, result);
    return result;
  }
  private async readCache<T>(key: string): Promise<T | null> {
    try { return (await this.env.CACHE?.get<T>(key, "json")) ?? null; }
    catch { return null; }
  }

  private async writeCache(key: string, value: unknown) {
    try { await this.env.CACHE?.put(key, JSON.stringify(value), { expirationTtl: 600 }); }
    catch { /* KV is a best-effort cache. */ }
  }

  private async batchScores(titles: CatalogTitle[], deadline: number) {
    if (!titles.length) return new Map<string, number | null>();
    const ids = [...new Set(titles.map(item => item.id.slice(3)))].sort();
    const params = new URLSearchParams(ids.map(uuid => ["manga[]", uuid]));
    const data = await this.get<Statistics>(`statistics/manga?${params}`, false, false, deadline);
    guard(data?.statistics && typeof data.statistics === "object" && !Array.isArray(data.statistics));
    const scores = new Map<string, number | null>();
    for (const uuid of ids) {
      const score = communityScore(data.statistics[uuid]?.rating);
      if (score !== undefined) scores.set(`md:${uuid}`, score);
    }
    await Promise.all([...scores].map(([id, score]) => this.writeCache(`md:score:v1:${id}`, { score })));
    return scores;
  }

  private async enrich(titles: CatalogTitle[]) {
    const cached = await Promise.all(titles.map(item => this.readCache<{ score: number | null }>(`md:score:v1:${item.id}`)));
    const missing = titles.filter((_, index) => cached[index] === null);
    const scores = new Map(titles.map((item, index) => [item.id, cached[index]?.score]));
    if (missing.length && Date.now() < this.deadline - 1000) {
      const deadline = Math.min(this.deadline, Date.now() + 3_000);
      const update = this.batchScores(missing, deadline).catch(() => new Map<string, number | null>());
      this.context?.waitUntil(update);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const budget = new Promise<undefined>(resolve => { timer = setTimeout(resolve, 250); });
      const result = await Promise.race([update, budget]);
      if (timer) clearTimeout(timer);
      for (const [id, score] of result ?? []) scores.set(id, score);
    }
    return titles.map(item => {
      const communityScore = scores.get(item.id);
      return typeof communityScore === "number" ? { ...item, communityScore } : item;
    });
  }

  async search(catalog: string, extras: ReadonlyMap<string, string>) {
    const verified = verifiedShelf(catalog);
    const rated = catalog === "top-rated";
    const ranked = rated || verified !== undefined;
    const limit = verified?.ids.size ?? (rated ? RATED_LIMIT : PAGE_SIZE);
    const offset = Number(extras.get("skip") ?? 0);
    if (ranked && offset >= limit) return { metas: [] };
    const params = new URLSearchParams({ limit: String(limit), offset: String(ranked ? 0 : offset) });
    for (const uuid of verified?.ids.keys() ?? []) params.append("ids[]", uuid);
    params.append("contentRating[]", "safe"); params.append("contentRating[]", "suggestive");
    params.append("includes[]", "cover_art");
    if (catalog === "manhwa") params.append("originalLanguage[]", "ko");
    if (extras.get("search")) params.set("title", extras.get("search")!);
    const needsTags = ["genre", "tag", "format"].some(filter => extras.has(filter));
    const taxonomy = needsTags ? await this.get<Collection>("manga/tag", true) : null;
    if (needsTags) guard(Array.isArray(taxonomy?.data));
    applyFilters(params, extras, normalizedTags(taxonomy?.data));
    params.set(verified ? "order[followedCount]" : rated ? "order[rating]" : "order[latestUploadedChapter]", "desc");
    params.set("order[createdAt]", "asc");
    if (ranked) {
      const page = (await this.rankedTitles(params, verified)).slice(offset, offset + PAGE_SIZE);
      return { metas: verified ? await this.enrich(page) : page };
    }
    const data = await this.get<Collection>(`manga?${params}`, true);
    guard(Array.isArray(data?.data));
    return { metas: await this.enrich(data.data.map(item => title(item, this.origin))) };
  }

  private async rankedTitles(params: URLSearchParams, verified?: VerifiedShelf) {
    const path = `manga?${params}`;
    // Cache a single eligible ranked snapshot for all offsets of these filters.
    const key = await this.cacheKey(`ranked:v2:${this.origin ?? ""}:${path}`);
    const saved = await this.readCache<CatalogTitle[]>(key);
    if (saved) return saved;
    const data = await this.get<Collection>(path, false);
    guard(Array.isArray(data?.data));
    const candidates = [...new Map(data.data.flatMap(raw => {
      if (verified) {
        const expected = typeof raw?.id === "string" ? verified.ids.get(raw.id.toLowerCase()) : undefined;
        const links = raw.attributes?.links as Record<string, unknown> | undefined;
        if (!expected || links?.mu !== expected) return [];
      }
      const item = title(raw, this.origin);
      return [[item.id, verified ? { ...item, format: verified.format } : item] as const];
    })).values()];
    // The upstream order applies before slicing, and remains independent of the score badges.
    const scores = verified ? null : await this.batchScores(candidates, this.deadline);
    const eligible = candidates.flatMap(item => {
      if (!scores) return [item];
      const score = scores.get(item.id);
      return typeof score === "number" ? [{ ...item, communityScore: score }] : [];
    }).map((item, index) => ({ ...item, rank: index + 1 }));
    await this.writeCache(key, eligible);
    return eligible;
  }

  async meta(id: string) {
    const data = await this.get<{ data: Entity }>(`manga/${id}?includes%5B%5D=cover_art`, true);
    return data ? { meta: (await this.enrich([title(data.data, this.origin)]))[0] } : null;
  }
  async chapters(id: string) {
    const manga = await this.get<{ data: Entity }>(`manga/${id}?includes%5B%5D=cover_art`, true);
    if (!manga) return null;
    const meta = title(manga.data, this.origin);
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
      if (new TextEncoder().encode(JSON.stringify({ meta, chapters })).length > MAX_BYTES) throw new Failure(502, "Chapter response too large");
      if (offset + data.data.length >= data.total) return { meta: (await this.enrich([meta]))[0], chapters };
      guard(data.data.length > 0);
    }
    throw new Failure(502, "MangaDex feed exceeds supported pagination");
  }
  async pages(id: string, origin: string) {
    // No KV caching: assignments are client/location sensitive and expire.
    const data = await this.get<{ baseUrl: unknown; chapter: { hash: unknown; data: unknown[] } }>(`at-home/server/${id}?forcePort443=true`, false, true);
    if (!data) return null;
    const base = imageBase(data.baseUrl);
    if (!base) throw new Failure(503, "Unsupported MangaDex at-home host");
    guard(data.chapter && segment(data.chapter.hash) && Array.isArray(data.chapter.data));
    const hash = data.chapter.hash;
    guard(data.chapter.data.length <= 500);
    const urls = data.chapter.data.map(filename => { guard(segment(filename)); return `${base.url}/data/${hash}/${filename}`; });
    if (!urls.length) return null;
    const expiresAt = Date.now() + 600_000;
    const publicOrigin = new URL(origin);
    if (publicOrigin.protocol !== "https:" || publicOrigin.username || publicOrigin.password ||
        publicOrigin.hostname === "localhost" || publicOrigin.hostname.endsWith(".local") ||
        publicOrigin.hostname.includes(":") || /^\d+(?:\.\d+){3}$/.test(publicOrigin.hostname))
      throw new Failure(503, "A public HTTPS Worker origin is required for page proxying");
    // Assignment IDs distinguish concurrent resolutions; they are public identifiers, not credentials.
    const assignmentId = crypto.randomUUID();
    const result = await pageStore(this.env, id, assignmentId).fetch("https://pages.internal/", {
      method: "POST", body: JSON.stringify({ expiresAt, urls })
    });
    if (!result.ok) throw new Failure(503, "Could not store page assignment");
    const pages = urls.map((_, index) => `${publicOrigin.origin}/anikatha/media/manga/${id}/${index}?assignment=${assignmentId}`);
    return { pages, expiresAt: new Date(expiresAt).toISOString() };
  }
}
