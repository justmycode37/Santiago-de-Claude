"""Serve the app for local use or a phone, with gzip and browser caching.

Same as `python3 -m http.server`, but text files (index.html, platforms.js, ...) are sent gzipped,
about a quarter of their size, and the browser keeps every file: it checks back on each visit and gets a
short "not modified" answer when a file is unchanged. That makes the app open much faster on a phone.

    python3 tools/serve.py              # http://localhost:8000
    python3 tools/serve.py 8000 0.0.0.0 # also reachable from other devices on the network
"""
import gzip
import http.server
import io
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
COMPRESS = {".html", ".js", ".css", ".json", ".geojson", ".svg", ".txt"}
_gzipped = {}  # path -> (mtime, size, gzipped bytes)


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        # Revalidate on every visit, so edits show up at once; unchanged files come back as a short 304
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def send_head(self):
        path = self.translate_path(self.path)
        if os.path.isdir(path):
            if not self.path.split("?", 1)[0].endswith("/"):
                return super().send_head()  # redirects to the path with a slash
            path = os.path.join(path, "index.html")
        ext = os.path.splitext(path)[1].lower()
        if ext not in COMPRESS or "gzip" not in self.headers.get("Accept-Encoding", "") or not os.path.isfile(path):
            return super().send_head()

        st = os.stat(path)
        etag = f'"{st.st_mtime_ns:x}-{st.st_size:x}-gz"'
        if self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.end_headers()
            return None

        cached = _gzipped.get(path)
        if not cached or cached[:2] != (st.st_mtime_ns, st.st_size):
            with open(path, "rb") as f:
                cached = (st.st_mtime_ns, st.st_size, gzip.compress(f.read(), 6))
            _gzipped[path] = cached
        body = cached[2]

        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("ETag", etag)
        self.send_header("Vary", "Accept-Encoding")
        self.end_headers()
        return io.BytesIO(body)


class Server(http.server.ThreadingHTTPServer):
    # The app asks for some twenty files at once, and behind a proxy (tailscale serve) each request is a connection
    # of its own. With Python's default of 5 waiting connections the rest are refused and the proxy answers 502.
    request_queue_size = 128


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    bind = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    server = Server((bind, port), Handler)
    print(f"Serving {ROOT} at http://{'localhost' if bind in ('127.0.0.1', '0.0.0.0') else bind}:{port}/", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
