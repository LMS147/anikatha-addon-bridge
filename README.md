# AniKatha Bridge: static compatibility fixtures

**Phase 1 is static-only. Providers: `none / static-local-fixture`.** No live provider APIs, scraping, plugins or server runtime are integrated. This repository hosts separate JSON fixtures for AniKatha and Stremio, without dependencies or a build step. It is not a real anime catalogue.

## AniKatha fixture

Install the **public HTTPS** manifest (after deployment):

`https://lms147.github.io/anikatha-addon-bridge/anikatha/manifest.json`

The original root `/manifest.json` remains the Stremio `movie` fixture; AniKatha does **not** route its movie resources. The separate AniKatha manifest declares `anime` and `catalog`, `meta`, `stream`, matching [AniKatha's HTTP contract](https://github.com/LMS147/AniKatha/blob/c00cc8e56a266644d0eb31f4eba8f63c0367fac6/docs/HTTP-ADDONS.md). Paths relative to the AniKatha manifest directory are:

- `catalog/anime/static-fixture.json` → title `bridge-fixture-bbb`
- `meta/anime/bridge-fixture-bbb.json` → episode `bridge-fixture-bbb-clip`
- `stream/anime/bridge-fixture-bbb-clip.json` → direct HTTPS MP4

Big Buck Bunny is a Blender Foundation short, **not anime**. We classify this one fixture as `anime` only to exercise AniKatha's routing. The Google Cloud Storage MP4 and existing TMDB image URLs are static media hosts, not API integrations. No AniList mapping is asserted. The root movie fixture's IMDb ID is only an identifier.

### Install and read test

1. After deploying, check that the manifest and three paths above return HTTP 200 JSON over HTTPS without redirects. Unknown units should return 404.
2. AniKatha → **Profile → Content & discovery → Manage add-ons** → add the AniKatha URL above.
3. Browse its **Static compatibility fixture** catalogue, open Big Buck Bunny, select **Sample clip**, and try playback (and optionally download). Confirm the source persists after reopening the app.
4. If something fails, record the AniKatha version, endpoint and error. Local tests check the HTTP shapes, not the actual Android installation, media availability or playback.

Manifest and resource responses must stay under 256 KiB. Use public HTTPS URLs without redirects, credentials, fragments, private IPs or `.local` hosts. Downloadable streams require a stable ID and direct HTTPS MP4; subtitles must be HTTPS VTT/SRT. Future expiring stream/page URLs must declare `expiresAt`. Static file hosting returns 404 for missing resources.

## Local verification

Python 3 only:

```sh
python3 scripts/validate.py
python3 -m unittest discover -s tests -v
python3 scripts/serve.py 8080
```

The tests start a temporary local server and check the manifest → catalog → meta → episode stream chain, JSON size and missing-resource 404s. Local HTTP is for automated checks only; AniKatha requires public HTTPS. The development server adds CORS and no-store headers.

## Deployment

Merge the working branch into `main`, then under **Settings → Pages** select **GitHub Actions**. `.github/workflows/pages.yml` validates both fixtures, uploads the repository, and deploys in a separate job. Only `main` may deploy to the protected `github-pages` environment. The duplicate `static.yml` is removed by this change. Check the Actions run and then the URLs; the test branch cannot demonstrate production deployment under that protection rule.

The root `https://lms147.github.io/anikatha-addon-bridge/manifest.json` remains the Stremio fixture. Use its landing page install link or paste that URL in Stremio; it is not the AniKatha install URL. The landing page lists both.

## Later phases (not implemented)

Only **after the static AniKatha install/read test passes**, the first planned new upstream is MangaDex API v5 chapter feeds and at-home page URLs, using `expiresAt` for short-lived URLs. Phase 2 is planned as C# / ASP.NET Core Minimal API, not Node. AniList and Jikan are already built into AniKatha and may be considered only for verified cross-service mappings; SIMKL mapping and AniSkip enrichment are later considerations. YouTube episodes are also already built in. This bridge does not re-expose these built-ins or use EverythingMoe (a directory), Comix, KotoPlay, torrents, XDCC, DDL or scraper sites. No secrets belong in manifests, install URLs, or checked-in environment files.

## License

GPL-3.0 — see [LICENSE](LICENSE).
