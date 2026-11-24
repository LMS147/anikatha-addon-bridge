# AniKatha Bridge

Static Stremio add-on that **AniKatha** (Android) can also install. One public
HTTPS manifest URL works in both apps. There is no backend, no build step, and
no dependencies — every response is a plain JSON file served as-is.

## What this is

- A **static add-on**: `manifest.json` + catalog/meta/stream JSON files,
  following the [Stremio static add-on example](https://github.com/Stremio/stremio-static-addon-example).
- A **bridge**: Stremio installs it as a normal add-on; AniKatha installs the
  same manifest URL via **Profile → Content & discovery → Manage add-ons**
  (AniKatha validates that the manifest has an `id` and stores it locally).
- Sample content is **Big Buck Bunny** (`tt1254207`) — the same title AniKatha
  uses as its built-in trailer sample — with a public HTTPS sample stream.

## Repository layout

```
manifest.json                        Add-on manifest (id, version, catalogs, resources)
index.html                           Landing page with Stremio install link + AniKatha steps
catalog/movie/anikatha-bridge.json   Catalog response (must match catalog id in manifest)
meta/movie/tt1254207.json            Details response for the catalog entry
stream/movie/tt1254207.json          Stream response for the catalog entry
scripts/validate.py                  Stdlib-only checks (manifest shape + cross-references)
scripts/serve.py                     Dev server with CORS + no-cache headers
.github/workflows/pages.yml          GitHub Pages deploy on push to main
.nojekyll                            Serve files as-is (no Jekyll processing)
```

## 1. Test locally (before deploying)

Requires Python 3 (stdlib only — nothing to install).

```bash
python3 scripts/validate.py          # manifest + cross-reference checks
python3 scripts/serve.py 8080        # CORS + no-cache dev server
```

Then verify each endpoint:

```bash
curl -s http://localhost:8080/manifest.json
curl -s http://localhost:8080/catalog/movie/anikatha-bridge.json
curl -s http://localhost:8080/meta/movie/tt1254207.json
curl -s http://localhost:8080/stream/movie/tt1254207.json
```

Expected: all return HTTP 200 with valid JSON. The dev server sends
`Access-Control-Allow-Origin: *` and `Cache-Control: no-store`, matching
GitHub Pages behaviour and preventing stale caches while you edit.

**Stremio (desktop) local test:** open Stremio → Add-ons → Add-on Repository
URL → paste `http://localhost:8080/manifest.json` → Install. You should see
the **AniKatha Bridge** catalog with Big Buck Bunny, and playback should start
the sample stream.

> Android (Stremio or AniKatha) requires a public **HTTPS** URL — use the
> deployed GitHub Pages URL from step 2, or a tunnel (e.g. `localtunnel`).

## 2. Deploy to GitHub Pages

1. Merge this branch into `main` and push (the workflow deploys from `main`).
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. Wait for the **Deploy static add-on to GitHub Pages** Actions run to finish
   (Actions tab). The environment URL is printed in the run summary.
4. Open the Pages URL, e.g. `https://<user>.github.io/anikatha-addon-bridge/`
   — the landing page should load with the install button.
5. Confirm `https://<user>.github.io/anikatha-addon-bridge/manifest.json`
   returns the manifest JSON. That URL is your add-on repository URL.

Every push to `main` redeploys automatically. To force a refresh in Stremio
after changes, bump `version` in `manifest.json` (Stremio caches manifests).

## 3. Install in Stremio

- Open the landing page and click **Install in Stremio** (uses the
  `stremio://` link), **or**
- Stremio → Add-ons → Add-on Repository URL → paste
  `https://<user>.github.io/anikatha-addon-bridge/manifest.json` → Install.

## 4. Install in AniKatha (Android)

1. Copy the public HTTPS manifest URL from the landing page.
2. Open AniKatha → **Profile → Content & discovery → Manage add-ons**.
3. Paste the URL and tap **Add source**. “AniKatha Bridge” appears in the list.
4. Close and reopen AniKatha — the entry must still be listed (persistence).
5. Submit the same URL again — the list must still show only one entry
   (de-duplication). Remove it and reopen — it must stay removed.

> Note: AniKatha’s add-on catalog playback is handled by its own adapters
> (e.g. Jikan, YouTube episodes). This bridge proves the shared install/store
> flow; content playback in AniKatha is a separate implementation.

## Testing checklist

| # | Check | Expected |
|---|-------|----------|
| 1 | `python3 scripts/validate.py` | All checks PASS |
| 2 | `curl` each of the 4 JSON endpoints locally | HTTP 200, valid JSON |
| 3 | Pages URL loads landing page | Install button + manifest URL shown |
| 4 | `/manifest.json` on Pages | Valid JSON, `id` = `org.anikatha.addon-bridge` |
| 5 | Stremio install from Pages URL | Catalog appears, BBB plays |
| 6 | AniKatha Add source with Pages URL | Entry listed, persists after reopen |
| 7 | Re-add same URL in AniKatha | Still exactly one entry |
| 8 | Remove entry in AniKatha, reopen | Entry stays removed |

## Extending

To add a title, add one entry to `catalog/movie/anikatha-bridge.json` and
create matching `meta/movie/<id>.json` and `stream/movie/<id>.json` files
(`<id>` must match exactly — `validate.py` checks this). Then bump `version`
in `manifest.json` and push to `main`.

## Troubleshooting

- **Stremio shows old data:** bump `version` in `manifest.json`, push, then
  reinstall the add-on.
- **404 on Pages:** confirm Pages source is **GitHub Actions** and the Actions
  run succeeded; `.nojekyll` is already in place.
- **AniKatha rejects the URL:** it must be public HTTPS ending in
  `/manifest.json`. The raw GitHub URL
  (`https://raw.githubusercontent.com/<user>/anikatha-addon-bridge/main/manifest.json`)
  also works as a fallback.
- **Android cleartext errors:** always use the HTTPS Pages URL, never
  `http://localhost` from a phone.

## License

GPL-3.0 — see [LICENSE](LICENSE).
