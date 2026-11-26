import { it, expect, vi } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";

const title = "11111111-1111-4111-8111-111111111111";
const chapter = "22222222-2222-4222-8222-222222222222";
const sample = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");

it("runs Worker + real KV + global Durable Object with upstream fully mocked", async () => {
  const urls: string[] = [];
  const mf = new Miniflare({
    modules: true, scriptPath: ".wrangler/build/index.js", compatibilityDate: "2026-07-30",
    kvNamespaces: ["CACHE"], durableObjects: { RATE_GATE: { className: "RateGate", useSQLite: true }, PAGE_STORE: { className: "PageStore", useSQLite: true }, REPORT_QUEUE: { className: "ReportQueue", useSQLite: true } },
    outboundService: async (request: Request) => {
      urls.push(request.url);
      const url = new URL(request.url);
      if (url.hostname !== "api.mangadex.org") return new Response("Unexpected outbound host", { status: 500 });
      if (url.pathname === "/statistics/manga")
        return Response.json({ statistics: { [title]: { rating: { average: 8, bayesian: 7.9 } } } });
      const name = url.pathname === "/manga" ? "search" : url.pathname === `/manga/${title}` ? "manga" : url.pathname === `/manga/${title}/feed` ? "feed" : url.pathname === `/at-home/server/${chapter}` ? "at-home" : null;
      return name ? new Response(sample(name), { headers: { "content-type": "application/json" } }) : new Response(null, { status: 404 });
    }
  });
  try {
    const fetch = (path: string) => mf.dispatchFetch("https://bridge.example" + path);
    expect((await fetch("/anikatha/manifest.json")).status).toBe(200);
    const catalog = await fetch("/anikatha/catalog/manga/mangadex/search=one%26two&skip=20.json");
    expect(catalog.status, await catalog.clone().text() + JSON.stringify(urls)).toBe(200);
    expect((await catalog.json()).metas[0].id).toBe(`md:${title}`);
    expect(new URL(urls[0]).searchParams.get("title")).toBe("one&two");
    const manhwa = await fetch("/anikatha/catalog/manga/manhwa/search=story&skip=20.json");
    expect(manhwa.status).toBe(200);
    const manhwaRequest = new URL(urls.filter(url => new URL(url).pathname === "/manga")[1]);
    expect(manhwaRequest.searchParams.getAll("originalLanguage[]")).toEqual(["ko"]);
    expect(manhwaRequest.searchParams.get("title")).toBe("story");
    expect(manhwaRequest.searchParams.get("offset")).toBe("20");
    const chapters = await fetch(`/anikatha/chapters/manga/md%3A${title}.json`);
    expect(chapters.status).toBe(200);
    expect((await chapters.json()).chapters[0].id).toBe(`md:ch:${chapter}`);
    const pages = await fetch(`/anikatha/pages/manga/md%3Ach%3A${chapter}.json`);
    expect(pages.status).toBe(200);
    expect((await pages.json()).pages).toHaveLength(2);
    expect(urls.every(u => new URL(u).hostname === "api.mangadex.org")).toBe(true);
  } finally { await mf.dispose(); }
}, 30_000);

it("proxies an assigned network image and reports both success and failure", async () => {
  const reports: Array<{ url: string; success: boolean; bytes: number; cached: boolean; duration: number }> = [];
  let responseStatus = 200;
  const mf = new Miniflare({
    modules: true, scriptPath: ".wrangler/build/index.js", compatibilityDate: "2026-07-30",
    kvNamespaces: ["CACHE"], durableObjects: { RATE_GATE: { className: "RateGate", useSQLite: true }, PAGE_STORE: { className: "PageStore", useSQLite: true }, REPORT_QUEUE: { className: "ReportQueue", useSQLite: true } },
    outboundService: async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "api.mangadex.org" && url.pathname === `/at-home/server/${chapter}`) {
        const data = JSON.parse(sample("at-home"));
        data.baseUrl = "https://test-node.mangadex.network/abc";
        return Response.json(data);
      }
      if (url.hostname === "test-node.mangadex.network") {
        return responseStatus === 200
          ? new Response(Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a2AAAAAASUVORK5CYII=", "base64")), { headers: { "content-type": "image/png", "x-cache": "HIT from test" } })
          : new Response("error", { status: responseStatus });
      }
      if (url.hostname === "api.mangadex.network" && url.pathname === "/report" && request.method === "POST") {
        expect(request.headers.get("content-type")).toBe("application/json");
        reports.push(await request.json());
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }
  });
  try {
    const request = (path: string) => mf.dispatchFetch("https://bridge.example" + path);
    const pagesResponse = await request(`/anikatha/pages/manga/md%3Ach%3A${chapter}.json`);
    expect(pagesResponse.status).toBe(200);
    const pages = (await pagesResponse.json()).pages as string[];
    expect(pages[0]).toMatch(new RegExp(`^https://bridge\\.example/anikatha/media/manga/${chapter}/0\\?assignment=[0-9a-f-]{36}$`));
    const result = await mf.dispatchFetch(pages[0]);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await result.arrayBuffer())).toEqual(Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a2AAAAAASUVORK5CYII=", "base64")));
    responseStatus = 502;
    const failure = await mf.dispatchFetch(pages[1]);
    expect(failure.status).toBe(503);
    // waitUntil reports may complete after the image response.
    await vi.waitFor(() => expect(reports).toHaveLength(2), { timeout: 12000 });
    expect(reports[0]).toMatchObject({ success: true, bytes: 68, cached: true, url: "https://test-node.mangadex.network/abc/data/abc123/1-a.png" });
    expect(reports[1]).toMatchObject({ success: false, bytes: 0, cached: false });
    expect(reports[0].duration).toBeGreaterThanOrEqual(0);
    expect((await mf.dispatchFetch(pages[0].replace("/0?", "/999?"))).status).toBe(404);
    expect((await request("/anikatha/media/manga/invalid/0?assignment=invalid")).status).toBe(404);
  } finally { await mf.dispose(); }
}, 30_000);
