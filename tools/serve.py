# Dev server: like `python3 -m http.server` but tells the browser never to cache,
# so a reload always runs the latest code (ES modules are otherwise cached
# aggressively). The page loads ~60 modules at once with no bundler, and the
# stock listen backlog of 5 resets most of them -- hence request_queue_size.
#   python3 tools/serve.py [port]      (default 8321)
import http.server, sys
class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()
    def log_message(self, *a): pass
class Server(http.server.ThreadingHTTPServer):
    request_queue_size = 256
    daemon_threads = True
port = int(sys.argv[1]) if len(sys.argv) > 1 else 8321
Server(("", port), NoCache).serve_forever()
