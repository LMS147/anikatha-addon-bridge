# AniKatha Add-on Bridge

An ASP.NET Core `net10.0` HTTP add-on for MangaDex manga discovery and reading. The old static GitHub Pages prototype is archived in `legacy/static-bridge/`; GitHub Pages cannot run this API and is **not** its deployment. The API does not serve that directory or any test fixtures.

## Current functionality and limits

The MangaDex v5 upstream supports a manga catalog with search/skip, manga details, chapter feeds, and ordered at-home pages. The manifest advertises anime and manga per the target contract, but **no anime source or verified mapping is configured**: anime meta and stream endpoints return 404. There is no dummy content in the production API. AniList/Jikan/SIMKL ID mapping and AniSkip are not implemented; no title or progress mapping is inferred from names or positions. AniKatha already provides AniList, Jikan, and its YouTube episode adapter. YouTube watch URLs are not generic MP4 streams.

Chapter feeds include all returned languages and scanlation variants; the title labels include language, and chapter IDs are stable MangaDex chapter IDs. The HTTP contract has no chapter pagination; a large response over 256 KiB returns 502 rather than silently truncating it. The upstream feed is paged until complete, subject to MangaDex's offset limit. MangaDex at-home page URLs come from each upstream response, with a conservative two-minute `expiresAt`; clients should resolve them again when expired. Metadata/search/feed responses are cached for five minutes. The process-wide upstream gate schedules at most four requests per second; **run only one replica** unless a shared, distributed rate limiter is added. 404 indicates an unknown resource; upstream failures are 502 and upstream timeouts 504 so clients can retry.

## Run and test

Requires the .NET 10 SDK (tests restore NuGet test packages). No Node/npm:

```sh
dotnet test tests/AniKathaAddonBridge.Tests/AniKathaAddonBridge.Tests.csproj
dotnet run --project src/AniKathaAddonBridge --urls http://0.0.0.0:8080
curl -i http://localhost:8080/anikatha/manifest.json
curl -i http://localhost:8080/anikatha/catalog/manga/mangadex.json
```

The tests run against an in-process HTTP server with a mocked upstream; CI also curls a real local Kestrel process without upstream calls. The checked-in test responses are **synthetic schema examples**, not recorded live responses; they never enter production. No tests call MangaDex. Local HTTP is for testing only; AniKatha requires public HTTPS. Actual search, reading, resume, downloads and upstream availability need separate validation against the deployed service. The external API's terms and rate limits must be observed.

## Deployment and install

Provide a public .NET 10-capable HTTPS host with a stable hostname and TLS termination. Configure its proxy to forward requests to the application on its configured `ASPNETCORE_URLS`/port; do not redirect the add-on endpoints. This repo does not provision a host or deploy automatically. Do not put credentials in manifests, URLs, or source control. Install `https://<your-host>/anikatha/manifest.json` in AniKatha → **Profile → Content & discovery → Manage add-ons**. Verify GET JSON without redirects, response size ≤256 KiB, and then test search → chapters → pages → resume → download on an actual device. Anime playback cannot pass until a verified mapping and licensed source (or AniKatha's existing YouTube adapter) are supplied. Optional live MangaDex checks must be explicitly authorized and rate-limited.

## Security and operations

The API does not redirect resource requests or follow upstream redirects. It returns absolute HTTPS page URLs after rejecting credentials, fragments, IP literals and `.local`/localhost hosts; it validates path segments and does not make server-side requests to the page hosts. Deploy behind a reverse proxy that enforces HTTPS, restricts direct access to internal HTTP, has request limits/timeouts, and prevents untrusted forwarded headers. The `User-Agent` identifies this bridge. For a production deployment, monitor upstream 429/5xx and ensure the upstream global rate policy is shared across every deployment. A hostname resolving to a private address is not checked by this application; clients and deployment infrastructure must apply their own DNS/network protections.

## License

GPL-3.0; see [LICENSE](LICENSE).
