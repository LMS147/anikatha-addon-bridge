#!/usr/bin/env python3
"""Dev server for the static bridge with CORS + no-cache headers (stdlib only).

GitHub Pages sends CORS headers automatically; this mimics that locally so
browser-based testing behaves like production. No-cache headers prevent
Stremio/browser caching from hiding your edits while developing.

Usage: python3 scripts/serve.py [port]   (default 8080)
"""

import http.server
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8080


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class Server(socketserver.ThreadingTCPServer):
    # Allow instant restart after a previous run: without SO_REUSEADDR the
    # port stays unbindable while old connections sit in TIME_WAIT.
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with Server(("0.0.0.0", PORT), Handler) as httpd:
        print(f"Serving {ROOT} on http://0.0.0.0:{PORT} (CORS on, no-cache on)")
        print(f"Manifest: http://localhost:{PORT}/manifest.json")
        httpd.serve_forever()
