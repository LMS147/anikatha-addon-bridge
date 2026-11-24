# AniKatha Add-on Bridge — Cloudflare Worker

Native TypeScript Cloudflare Worker for AniKatha HTTP add-ons. MangaDex API v5 is the first upstream. GitHub Pages, the static fixtures and the .NET prototype under `legacy/` are **not** the dynamic provider and are not served by the Worker. No dummy content is shipped in production responses.

## What works and what is not yet available

The Worker exposes `/anikatha/manifest.json`, MangaDex manga and manhwa catalogs with `search`/`skip`, manga metadata with cover art, a chapter feed, and page resolution. The Manhwa catalog uses MangaDex’s `originalLanguage[]=ko` filter (Korean originals) and remains type `manga` for AniKatha compatibility. This filter does not guarantee that every result has chapters in your preferred translation language; available chapters come from MangaDex. MangaDex covers are returned when its expanded cover relationship contains a valid filename. IDs use `md:<uuid>` and `md:ch:<uuid>`; encoded IDs and catalog extras are supported. The manifest advertises only manga because there is **no verified anime catalog, mapping, or licensed source yet**. Anime meta/stream endpoints return 404; no placeholder catalog or YouTube watch URL is exposed. AniList/Jikan/SIMKL mappings and AniSkip are not implemented. AniKatha's existing AniList, Jikan and YouTube functionality is not re-exposed.

**MangaDex@Home reporting:** The Worker obtains at-home assignments from MangaDex without putting them in KV. Its `/anikatha/media/manga/{chapterId}/{index}?assignment=…` endpoint streams supported images through a restricted proxy, validates MIME type and AniKatha-compatible image signatures, and queues a report containing URL, success, cache status, bytes and duration for every image retrieval. The assignment parameter is a public identifier, not a secret. The durable report queue sends at most one request every 6.1 seconds, retries failures with backoff, and fails closed before image retrieval if full or unavailable. Reports are at-least-once: a crash after a successful upstream POST can cause a duplicate. Queue failures require monitoring; delivery is not guaranteed while MangaDex is unavailable.

For SSRF protection, only HTTPS port 443 image hosts under `mangadex.org` and `*.mangadex.network` are accepted. Other at-home hosts still return **503**, rather than becoming an arbitrary image proxy. Assignments expire after ten minutes; use Refresh Sources when a page URL expires. The Worker checks image signatures that match AniKatha's detection logic; complete-image validation, live reading, resume and downloads must still be verified in AniKatha on a device.

## Architecture and limits

- `src/index.ts`: native Worker `fetch` routing; GET/JSON only for add-on resources, no redirects.
- `src/mangadex.ts`: MangaDex API client, 10-minute Workers KV metadata/search/feed cache. Pages never enter KV. Per-location Cache API caches successful manifest/catalog/meta/chapter responses for 60 seconds; page responses are `no-store`.
- `src/pages.ts`: a short-lived Durable Object per assignment stores upstream page URLs for ten minutes; the Worker streams the image and checks supported MIME types and signatures. Image responses are binary, not JSON.
- `src/reports.ts`: a global Durable Object persists and rate-limits at-home reports, with bounded admission and retries. A reserved image retrieval that never completes becomes a failure report after 20 seconds.
- `src/rate.ts`: a single named Durable Object coordinates all API calls across isolates, scheduling at most four per second and at most 40 at-home calls per rolling minute. Queues that would exceed the request deadline fail with 503. Other consumers sharing Cloudflare egress IPs can still trigger upstream limits. Monitor 429s and deploy one Worker namespace per upstream budget; this limiter cannot coordinate independent deployments.
- JSON is capped at 256 KiB; oversized chapter feeds fail with 502 rather than being silently truncated. Unknown units return 404; upstream failures return 503. The Worker has a 19-second response deadline, under AniKatha's 20-second timeout. No AniList IDs/progress are invented or matched by title/position.

The API validates page hosts, credentials, fragments and path segments and only emits HTTPS URLs. The image proxy only accesses allowlisted upstream URLs obtained from the MangaDex API, not arbitrary user-supplied hosts; it does not resolve arbitrary domains. The Cloudflare hostname must be a public HTTPS URL without redirects, credentials, fragments, private addresses or `.local`. A custom domain or workers.dev URL is suitable. Secrets belong in Worker secrets, never install URLs or checked-in files; this implementation needs no provider credentials.

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

## Deployment

The existing Cloudflare deployment uses **https://anikatha.mletsoalo.co.za/anikatha/manifest.json**. Deployment of this branch is still required; the currently live version may differ. The KV ID in `wrangler.toml` belongs to the existing account; create a separate KV namespace and update that ID only if deploying to another account.

1. Merge the branch and allow the existing Cloudflare Git deployment to run, or use `npm run deploy` with an authenticated Wrangler session. The `v3` migration adds the SQLite-backed report queue; do not share tokens in chat.
2. Ensure Cloudflare Access stays off for these paths and the custom domain serves the manifest and resources over HTTPS without redirects. This repository cannot verify or change account Access settings.
3. Refresh the installed manifest in AniKatha. Verify manga and manhwa search → chapters → pages → read/resume/download, including complete image signature validation. No verified anime catalog is advertised.
4. Monitor the report queue and Worker logs for repeated MangaDex errors and 503s. Confirm actual MangaDex hosts and report delivery against the deployed Worker; unsupported hosts require a separately reviewed SSRF-safe design.

Vitest/Miniflare use mocked upstreams; passing tests do not prove that live MangaDex delivery, Android WebView or AniKatha downloads work.
Do not connect EverythingMoe, Comix, KotoPlay, scrapers, torrents/XDCC/DDL, generic Stremio execution or JavaScript plugins. Verified mapping and AniSkip are future work, not implemented integrations.

## License

GPL-3.0; see [LICENSE](LICENSE).
