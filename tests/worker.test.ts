import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import worker from "../src/index";
import { RateGate } from "../src/rate";

const manga = "11111111-1111-4111-8111-111111111111";
const chapter = "22222222-2222-4222-8222-222222222222";
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));
const store = new Map<string, string>();
const assignments = new Map<string, string>();
const env = {
  CACHE: { get: vi.fn(async (key: string) => store.has(key) ? JSON.parse(store.get(key)!) : null), put: vi.fn(async (key: string, value: string) => { store.set(key, value); }) },
  PAGE_STORE: { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { assignments.set(name, String(init.body)); return new Response(null, { status: 204 }); }
    const value = assignments.get(name); return value ? new Response(value, { headers: { "content-type": "application/json" } }) : new Response(null, { status: 404 });
  } }) },
  RATE_GATE: { idFromName: vi.fn(() => "global"), get: vi.fn(() => ({ fetch: async () => Response.json({ delay: 0 }) })) }
} as unknown as import("../src/mangadex").Env;
const context = { waitUntil: (_p: Promise<unknown>) => {} } as ExecutionContext;
const call = (path: string, method = "GET") => worker.fetch(new Request("https://bridge.example" + path, { method }), env, context);
let calls: string[];

beforeEach(() => {
  store.clear(); assignments.clear(); calls = [];
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
    expect(manifest.types).toEqual(["manga"]); expect(manifest.anikathaProtocolVersion).toBe(1);
    expect(manifest.catalogs.map((catalog: { id: string }) => catalog.id)).toEqual(["mangadex", "manhwa"]);
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
    expect(data.pages).toHaveLength(2);
    expect(data.pages[0]).toMatch(new RegExp(`^https://bridge\\.example/anikatha/media/manga/${chapter}/0\\?assignment=[0-9a-f-]{36}$`));
    expect(data.pages[1]).toMatch(new RegExp(`^https://bridge\\.example/anikatha/media/manga/${chapter}/1\\?assignment=[0-9a-f-]{36}$`));
    expect(Date.parse(data.expiresAt) - Date.now()).toBeGreaterThan(590_000);
    expect(calls.some(u => u.includes("forcePort443=true"))).toBe(true);
    expect(env.CACHE.put).toHaveBeenCalledWith(expect.any(String), expect.any(String), { expirationTtl: 600 });
  });
  it("supports browsing and searching the Korean-original manhwa catalog separately", async () => {
    const browse = await call("/anikatha/catalog/manga/manhwa.json");
    expect(browse.status).toBe(200);
    expect((await browse.json()).metas[0].type).toBe("manga");
    expect(new URL(calls[0]).searchParams.getAll("originalLanguage[]")).toEqual(["ko"]);
    const search = await call("/anikatha/catalog/manga/manhwa/search=love%20%26%20war&skip=40.json");
    expect(search.status).toBe(200);
    const query = new URL(calls[1]).searchParams;
    expect(query.get("title")).toBe("love & war");
    expect(query.get("offset")).toBe("40");
    expect(query.getAll("originalLanguage[]")).toEqual(["ko"]);
    expect((await call("/anikatha/catalog/manga/manhwa/skip=20.json")).status).toBe(200);
    expect(new URL(calls[2]).searchParams.get("offset")).toBe("20");
    expect((await call("/anikatha/catalog/manga/mangadex.json")).status).toBe(200);
    expect(new URL(calls[3]).searchParams.has("originalLanguage[]")).toBe(false);
    expect((await call("/anikatha/catalog/manga/not-a-catalog.json")).status).toBe(404);
    expect((await call("/anikatha/catalog/manga/manhwa/skip=99999.json")).status).toBe(400);
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
  it("fails closed for unknown at-home server hosts", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ ...fixture("at-home"), baseUrl: "https://untrusted.example.com" })));
    const response = await call(`/anikatha/pages/manga/md%3Ach%3A${chapter}.json`);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toMatch(/Unsupported/);
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

it("page assignments expire and are removed by the alarm", async () => {
  const { PageStore } = await import("../src/pages");
  const storage = new Map<string, unknown>();
  let alarm = 0;
  const state = { storage: {
    put: async (key: string, value: unknown) => { storage.set(key, value); },
    get: async (key: string) => storage.get(key),
    setAlarm: async (time: number) => { alarm = time; },
    deleteAll: async () => { storage.clear(); }
  } } as unknown as DurableObjectState;
  const page = new PageStore(state);
  const expiry = Date.now() + 1000;
  expect((await page.fetch(new Request("https://pages.internal", { method: "POST", body: JSON.stringify({ expiresAt: expiry, urls: ["https://node.mangadex.network/data/x/a.png"] }) }))).status).toBe(204);
  expect(alarm).toBe(expiry);
  expect((await page.fetch(new Request("https://pages.internal"))).status).toBe(200);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(expiry + 1);
    expect((await page.fetch(new Request("https://pages.internal"))).status).toBe(404);
    await page.alarm();
    expect(storage.size).toBe(0);
  } finally { vi.useRealTimers(); }
});

it("accepts only signatures recognised by AniKatha for each supported image type", async () => {
  const { imageSignature } = await import("../src/pages");
  const ascii = (v: string) => new TextEncoder().encode(v);
  expect(imageSignature(new Uint8Array([137,80,78,71,13,10,26,10]), "image/png")).toBe(true);
  expect(imageSignature(new Uint8Array([255,216,255]), "image/jpeg")).toBe(true);
  expect(imageSignature(ascii("GIF89a"), "image/gif")).toBe(true);
  expect(imageSignature(ascii("RIFF1234WEBP"), "image/webp")).toBe(true);
  expect(imageSignature(ascii("1234ftypavif"), "image/avif")).toBe(true);
  expect(imageSignature(ascii("not an image"), "image/png")).toBe(false);
  expect(imageSignature(ascii("GIF89a"), "image/jpeg")).toBe(false);
});

it("queues reports and enforces the global interval, including retries", async () => {
  const { ReportQueue } = await import("../src/reports");
  const data = new Map<string, unknown>();
  let alarmTime: number | null = null;
  const state = { storage: {
    get: async (key: string) => structuredClone(data.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") data.set(key, structuredClone(value));
      else for (const [k,v] of Object.entries(key)) data.set(k, structuredClone(v));
    },
    getAlarm: async () => alarmTime,
    setAlarm: async (time: number) => { alarmTime = time; }
  }, blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn() } as unknown as DurableObjectState;
  const queue = new ReportQueue(state);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const reportFetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", reportFetch);
    for (let n = 0; n < 2; n++) {
      const reserve = await queue.fetch(new Request("https://queue/reserve", { method: "POST", body: JSON.stringify({ url: `https://uploads.mangadex.org/${n}` }) }));
      const ticket = await reserve.json();
      await queue.fetch(new Request("https://queue/complete", { method: "POST", body: JSON.stringify({ id: ticket.id, success: true, cached: false, bytes: 68, duration: 42 }) }));
    }
    alarmTime = null; await queue.alarm();
    expect(reportFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(reportFetch.mock.calls[0][1].body)).toMatchObject({ success: true, bytes: 68, duration: 42 });
    alarmTime = null; vi.advanceTimersByTime(6099); await queue.alarm();
    expect(reportFetch).toHaveBeenCalledTimes(1);
    alarmTime = null; vi.advanceTimersByTime(1); await queue.alarm();
    expect(reportFetch).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});

it("keeps failed reports queued and applies Retry-After without exceeding the rate", async () => {
  const { ReportQueue } = await import("../src/reports");
  const storage = new Map<string, unknown>();
  let alarmTime: number | null = null;
  const state = { storage: {
    get: async (key: string) => structuredClone(storage.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      if (typeof key === "string") storage.set(key, structuredClone(value));
      else for (const [k,v] of Object.entries(key)) storage.set(k, structuredClone(v));
    }, getAlarm: async () => alarmTime, setAlarm: async (time: number) => { alarmTime = time; }
  }, blockConcurrencyWhile: async <T>(fn: () => Promise<T>) => fn() } as unknown as DurableObjectState;
  const queue = new ReportQueue(state);
  vi.useFakeTimers();
  try {
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const reportFetch = vi.fn().mockResolvedValueOnce(new Response(null, { status: 429, headers: { "Retry-After": "30" } })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", reportFetch);
    const result = await queue.fetch(new Request("https://queue/reserve", { method: "POST", body: JSON.stringify({ url: "https://uploads.mangadex.org/test" }) }));
    const ticket = await result.json();
    await queue.fetch(new Request("https://queue/complete", { method: "POST", body: JSON.stringify({ id: ticket.id, success: false, cached: false, bytes: 0, duration: 12 }) }));
    alarmTime = null; await queue.alarm();
    expect((storage.get("jobs") as unknown[]).length).toBe(1);
    alarmTime = null; vi.advanceTimersByTime(29_999); await queue.alarm();
    expect(reportFetch).toHaveBeenCalledTimes(1);
    alarmTime = null; vi.advanceTimersByTime(1); await queue.alarm();
    expect(reportFetch).toHaveBeenCalledTimes(2);
    expect((storage.get("jobs") as unknown[]).length).toBe(0);
  } finally { vi.useRealTimers(); vi.unstubAllGlobals(); }
});
