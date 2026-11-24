import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { RateGate } from "../src/rate";

const manga = "11111111-1111-4111-8111-111111111111";
const chapter = "22222222-2222-4222-8222-222222222222";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const store = new Map<string, string>();
const env = {
  CACHE: { get: vi.fn(async (key: string) => store.has(key) ? JSON.parse(store.get(key)!) : null), put: vi.fn(async (key: string, value: string) => { store.set(key, value); }) },
  RATE_GATE: { idFromName: vi.fn(() => "global"), get: vi.fn(() => ({ fetch: async () => Response.json({ delay: 0 }) })) }
} as unknown as import("../src/mangadex").Env;
const context = { waitUntil: (_p: Promise<unknown>) => {} } as ExecutionContext;
const call = (path: string, method = "GET") => worker.fetch(new Request("https://bridge.example" + path, { method }), env, context);
let calls: string[];

beforeEach(() => {
  store.clear(); calls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    calls.push(url);
    const u = new URL(url);
    let name = "";
    if (u.pathname === "/manga") name = "search";
    else if (u.pathname === `/manga/${manga}`) name = "manga";
    else if (u.pathname === `/manga/${manga}/feed`) name = "feed";
    else if (u.pathname === `/at-home/server/${chapter}`) name = "at-home";
    return name ? Response.json(fixture(name)) : new Response(null, { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("AniKatha Worker contract (mocked upstream)", () => {
  it("resolves search, encoded ids, chapters, and ordered pages", async () => {
    let r = await call("/anikatha/manifest.json");
    const manifest = await r.json();
    expect(manifest.types).toEqual(["anime", "manga"]); expect(manifest.anikathaProtocolVersion).toBe(1);
    r = await call("/anikatha/catalog/manga/mangadex/search=one%26two&skip=20.json");
    expect(r.status).toBe(200);
    const item = (await r.json()).metas[0];
    expect(item.id).toBe(`md:${manga}`);
    expect(item.poster).toBe(`https://uploads.mangadex.org/covers/${manga}/example-cover.jpg.512.jpg`);
    expect(new URL(calls[0]).searchParams.get("includes[]")).toBe("cover_art");
    expect(new URL(calls[0]).searchParams.get("title")).toBe("one&two");
    expect(new URL(calls[0]).searchParams.get("offset")).toBe("20");
    const meta = (await (await call(`/anikatha/meta/manga/md%3A${manga}.json`)).json()).meta;
    expect(meta.id).toBe(`md:${manga}`);
    expect(meta.poster).toBe(item.poster);
    const details = await (await call(`/anikatha/chapters/manga/md%3A${manga}.json`)).json();
    expect(details.chapters[0].id).toBe(`md:ch:${chapter}`);
    expect(details.meta.poster).toBe(item.poster);
    r = await call(`/anikatha/pages/manga/md%3Ach%3A${chapter}.json`);
    expect(r.status).toBe(200); expect(r.headers.get("cache-control")).toBe("no-store");
    const data = await r.json();
    expect(data.pages).toEqual(["https://uploads.mangadex.org/data/abc123/1-a.png", "https://uploads.mangadex.org/data/abc123/2-b.png"]);
    expect(Date.parse(data.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    expect(calls.some(u => u.includes("forcePort443=true"))).toBe(true);
    expect(env.CACHE.put).toHaveBeenCalledWith(expect.any(String), expect.any(String), { expirationTtl: 600 });
  });
  it("omits missing or unsafe cover filenames", async () => {
    const source = fixture("search");
    source.data[0].relationships[0].attributes.fileName = "../../bad.jpg";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(source)));
    expect((await (await call("/anikatha/catalog/manga/mangadex.json")).json()).metas[0].poster).toBeUndefined();
    store.clear();
    delete source.data[0].relationships;
    expect((await (await call("/anikatha/catalog/manga/mangadex.json")).json()).metas[0].poster).toBeUndefined();
  });
  it("returns 404 for unknown units and unconfigured anime; rejects writes", async () => {
    expect((await call("/anikatha/stream/anime/ep%3Anone.json")).status).toBe(404);
    expect((await call("/anikatha/meta/anime/anilist%3A1.json")).status).toBe(404);
    expect((await call("/anikatha/pages/manga/md%3Ach%3A33333333-3333-4333-8333-333333333333.json")).status).toBe(404);
    expect((await call("/anikatha/manifest.json", "POST")).status).toBe(405);
  });
  it("fails closed for third-party at-home servers rather than bypass required reporting", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...fixture("at-home"), baseUrl: "https://node.mangadex.network" })));
    const response = await call(`/anikatha/pages/manga/md%3Ach%3A${chapter}.json`);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/reporting/);
  });
  it("returns retryable failure for upstream errors and malformed data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("no", { status: 429 })));
    expect((await call("/anikatha/catalog/manga/mangadex.json")).status).toBe(503);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ broken: true })));
    expect((await call("/anikatha/catalog/manga/mangadex.json")).status).toBe(502);
  });
});

describe("global rate reservations", () => {
  it("spaces global reservations and refuses those past deadline", async () => {
    const data = new Map<string, unknown>();
    const state = { storage: { get: async (key: string) => data.get(key), put: async (items: Record<string, unknown>) => { for (const [k,v] of Object.entries(items)) data.set(k, v); } }, blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn() } as unknown as DurableObjectState;
    const gate = new RateGate(state);
    const request = (deadline: number) => new Request("https://rate.internal", { method: "POST", body: JSON.stringify({ home: false, deadline }) });
    const first = await gate.fetch(request(Date.now() + 10_000));
    const second = await gate.fetch(request(Date.now() + 10_000));
    expect((await first.json()).delay).toBe(0);
    expect((await second.json()).delay).toBeGreaterThan(200);
    expect((await gate.fetch(request(Date.now() + 10))).status).toBe(503);
  });
});
