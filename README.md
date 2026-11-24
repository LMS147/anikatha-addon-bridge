# AniKatha Add-on Bridge — Cloudflare Worker

Native TypeScript Cloudflare Worker for AniKatha HTTP add-ons. MangaDex API v5 is the first upstream. GitHub Pages, the static fixtures and the .NET prototype under `legacy/` are **not** the dynamic provider and are not served by the Worker. No dummy content is shipped in production responses.

## What works and what is not yet available

The Worker exposes `/anikatha/manifest.json`, MangaDex manga and manhwa catalogs with `search`/`skip`, manga metadata with cover art, a chapter feed, and page resolution. The Manhwa catalog uses MangaDex’s `originalLanguage[]=ko` filter (Korean originals) and remains type `manga` for AniKatha compatibility. This filter does not guarantee that every result has chapters in your preferred translation language; available chapters come from MangaDex. MangaDex covers are returned when its expanded cover relationship contains a valid filename. IDs use `md:<uuid>` and `md:ch:<uuid>`; encoded IDs and catalog extras are supported. The manifest advertises anime and manga, but there is **no verified anime catalog, mapping, or licensed source yet**. Anime meta/stream endpoints return 404; no placeholder catalog or YouTube watch URL is exposed. AniList/Jikan/SIMKL mappings and AniSkip are not implemented. AniKatha's existing AniList, Jikan and YouTube functionality is not re-exposed.

**MangaDex@Home reporting:** [MangaDex's documentation](https://api.mangadex.org/docs/04-chapter/retrieving-chapter/) requires per-image success/failure reports for non-`mangadex.org` hosts. For `*.mangadex.network` assignments the Worker serves images through a restricted proxy and asynchronously attempts the documented report for each retrieval. Only URLs obtained from MangaDex are stored; arbitrary proxy URLs are not accepted. The proxy does not follow redirects and accepts HTTPS port 443, allowlisted hosts, supported image MIME types and images up to 20 MiB. Other at-home hosts still return **503** because they cannot be safely proxied with this allowlist. Network/report delivery, live reading, resume and download remain to be verified on a device. At-home assignments expire after 10 minutes; use Refresh Sources when a page URL expires.

## Architecture and limits

- `src/index.ts`: native Worker `fetch` routing; GET/JSON only for add-on resources, no redirects.
- `src/mangadex.ts`: MangaDex API client, 10-minute Workers KV metadata/search/feed cache. Pages never enter KV. Per-location Cache API caches successful manifest/catalog/meta/chapter responses for 60 seconds; page responses are `no-store`.
- `src/pages.ts`: a separate short-lived Durable Object per image assignment holds the upstream URLs for ten minutes, then deletes them; the Worker proxies assigned images and attempts reports for network hosts. Image responses are binary, not JSON. The public image path contains identifiers, not provider credentials.
- `src/rate.ts`: a single named Durable Object coordinates all API calls across isolates, scheduling at most four per second and at most 40 at-home calls per rolling minute. Queues that would exceed the request deadline fail with 503. Other consumers sharing Cloudflare egress IPs can still trigger upstream limits. Monitor 429s and deploy one Worker namespace per upstream budget; this limiter cannot coordinate independent deployments.
- JSON is capped at 256 KiB; oversized chapter feeds fail with 502 rather than being silently truncated. Unknown units return 404; upstream failures return 503. The Worker has a 19-second response deadline, under AniKatha's 20-second timeout. No AniList IDs/progress are invented or matched by title/position.

The API validates page hosts, credentials, fragments and path segments and only emits HTTPS URLs. The image proxy only accesses upstream URLs obtained from the MangaDex API on `*.mangadex.network`, not arbitrary user-supplied hosts; it does not resolve arbitrary domains. The Cloudflare hostname must be a public HTTPS URL without redirects, credentials, fragments, private addresses or `.local`. A custom domain or workers.dev URL is suitable. Secrets belong in Worker secrets, never install URLs or checked-in files; this implementation needs no provider credentials.

## Local tests

Node.js 22+ and npm are **development/deployment tooling**; the application is a native Worker, not a Node server. No Express, Fastify, Node compatibility flag, Python Worker or Docker is required.

```sh
npm ci
npm run typecheck
npm test
npm run dev -- --ip 127.0.0.1 --port 8787
curl -i http://127.0.0.1:8787/anikatha/manifest.json
curl -i http://127.0.0.1:8787/anikatha/stream/anime/ep%3Anone.json
```

Vitest unit tests plus Miniflare exercise the Worker, KV, Durable Object and catalog → chapters → pages using **synthetic schema examples** in `tests/fixtures/` and a strictly mocked outbound transport. They are not recorded production responses. Local curl checks above do not call MangaDex. The preview URL is HTTP and must not be used as the AniKatha install URL. The Wrangler dry-run performed by `npm test` does not deploy.

## Deployment (not yet performed)

1. Use a Cloudflare Workers account with KV and Durable Objects available; check the plan/limits for your use. Authenticate Wrangler through Cloudflare's supported login flow, without sharing tokens in chat.
2. Create a KV namespace, for example `npx wrangler kv namespace create CACHE`. Replace `REPLACE_WITH_KV_NAMESPACE_ID` in `wrangler.toml` with the returned namespace ID. This placeholder is intentionally not a working production binding. KV data is disposable cache, not a verified ID map.
3. Run `npm run typecheck && npm test`, then `npm run deploy`. The `v1` and `v2` migrations create the SQLite-backed rate-limiting and page-assignment Durable Objects. Configure workers.dev or a stable custom domain; no account, domain or deployment is provisioned by this repository.
4. Confirm HTTPS requests to `/anikatha/manifest.json` and resource paths return JSON directly without redirects. Install that exact manifest URL in AniKatha. In AniKatha, refresh the installed add-on manifest and find **Manhwa (Korean originals)** under Manga sources. Confirm real search → chapters → pages → resume/download; some pages will return 503 for unsupported at-home hosts or upstream image failures. Report delivery is attempted asynchronously with one retry and failures are logged; it cannot change an image response already sent.
5. Only after verified anime mappings and licensed sources exist, verify anime metadata and playback. Also test disable/enable persistence, Refresh Sources, WebView/Android, and absence of dummy data. No live upstream smoke test has been run.

Do not connect EverythingMoe, Comix, KotoPlay, scrapers, torrents/XDCC/DDL, generic Stremio execution or JavaScript plugins. Verified mapping and AniSkip are future work, not implemented integrations.

## License

GPL-3.0; see [LICENSE](LICENSE).
