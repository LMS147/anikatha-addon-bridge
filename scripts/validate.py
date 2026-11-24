#!/usr/bin/env python3
"""Validate the static AniKatha Bridge add-on files (stdlib only).

Checks manifest shape, catalog/meta/stream JSON, and cross-references
(catalog entries must have matching meta and stream files).

Usage: python3 scripts/validate.py
Exit code 0 = all checks passed, 1 = failures found.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FAILURES = []


def check(condition, message):
    status = "PASS" if condition else "FAIL"
    print(f"[{status}] {message}")
    if not condition:
        FAILURES.append(message)


def load_json(path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001 - report any parse problem
        print(f"[FAIL] {path.relative_to(ROOT)} is not valid JSON: {exc}")
        FAILURES.append(str(path))
        return None


def main():
    manifest = load_json(ROOT / "manifest.json")
    if manifest is None:
        print("Cannot continue without a valid manifest.json")
        return 1

    for field in ("id", "version", "name", "types", "catalogs", "resources"):
        check(field in manifest and bool(manifest[field]),
              f"manifest has non-empty '{field}'")

    catalogs = manifest.get("catalogs") or []
    check(len(catalogs) > 0, "manifest declares at least one catalog")

    for catalog in catalogs:
        ctype = catalog.get("type")
        cid = catalog.get("id")
        check(bool(ctype and cid), f"catalog entry has type+id ({catalog!r})")
        if not (ctype and cid):
            continue
        cat_path = ROOT / "catalog" / ctype / f"{cid}.json"
        check(cat_path.is_file(), f"catalog file exists: {cat_path.relative_to(ROOT)}")
        data = load_json(cat_path) if cat_path.is_file() else None
        if data is None:
            continue
        metas = data.get("metas") or []
        check(len(metas) > 0, f"catalog '{cid}' has at least one meta")
        for meta in metas:
            mid = meta.get("id")
            check(bool(mid and meta.get("name") and meta.get("type")),
                  f"catalog meta has id/name/type ({mid!r})")
            if not mid:
                continue
            meta_path = ROOT / "meta" / ctype / f"{mid}.json"
            check(meta_path.is_file(),
                  f"meta file exists for {mid}: {meta_path.relative_to(ROOT)}")
            mdata = load_json(meta_path) if meta_path.is_file() else None
            if mdata is not None:
                check((mdata.get("meta") or {}).get("id") == mid,
                      f"meta file id matches catalog id for {mid}")
            stream_path = ROOT / "stream" / ctype / f"{mid}.json"
            check(stream_path.is_file(),
                  f"stream file exists for {mid}: {stream_path.relative_to(ROOT)}")
            sdata = load_json(stream_path) if stream_path.is_file() else None
            if sdata is not None:
                streams = sdata.get("streams") or []
                check(len(streams) > 0, f"stream file for {mid} has at least one stream")
                for stream in streams:
                    url = stream.get("url", "")
                    check(url.startswith(("http://", "https://")),
                          f"stream url is http(s) for {mid}: {url[:60]}")

    check((ROOT / "index.html").is_file(), "landing page index.html exists")

    print()
    if FAILURES:
        print(f"{len(FAILURES)} check(s) failed.")
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
