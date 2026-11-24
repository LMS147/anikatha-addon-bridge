import { it, expect } from "vitest";
import { Miniflare } from "miniflare";
import { readFileSync } from "node:fs";

const title = "11111111-1111-4111-8111-111111111111";
const chapter = "22222222-2222-4222-8222-222222222222";
const sample = (name: string) => readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8");

it("runs Worker + real KV + global Durable Object with upstream fully mocked", async () => {
  const urls: string[] = [];
  const mf = new Miniflare({
    modules: true, scriptPath: ".wrangler/build/index.js", compatibilityDate: "2026-07-30",
    kvNamespaces: ["CACHE"], durableObjects: { RATE_GATE: { className: "RateGate", useSQLite: true } },
    outboundService: async (request: Request) => {
      urls.push(request.url);
      const url = new URL(request.url);
      if (url.hostname !== "api.mangadex.org") return new Response("Unexpected outbound host", { status: 500 });
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
    const chapters = await fetch(`/anikatha/chapters/manga/md%3A${title}.json`);
    expect(chapters.status).toBe(200);
    expect((await chapters.json()).chapters[0].id).toBe(`md:ch:${chapter}`);
    const pages = await fetch(`/anikatha/pages/manga/md%3Ach%3A${chapter}.json`);
    expect(pages.status).toBe(200);
    expect((await pages.json()).pages).toHaveLength(2);
    expect(urls.every(u => new URL(u).hostname === "api.mangadex.org")).toBe(true);
  } finally { await mf.dispose(); }
}, 20_000);
