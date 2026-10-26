"""Ephemeral backend for two-device browser checks. Never uses production data."""
import hashlib
import json
from pathlib import Path
import signal
import sys
import tempfile
from wsgiref.simple_server import make_server, WSGIRequestHandler

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from homes_api import Application


class QuietHandler(WSGIRequestHandler):
    def log_message(self, *args):
        pass


signal.signal(signal.SIGTERM, lambda *args: sys.exit(0))
with tempfile.TemporaryDirectory(prefix='homes-browser-') as directory:
    token = 'browser-test-' + 'x' * 40
    app = Application(directory, hashlib.sha256(token.encode()).hexdigest(), [sys.argv[1]])
    seed = Path(__file__).resolve().parents[1] / 'news/assets/home-candidates.json'
    Path(directory, 'candidates.json').write_bytes(seed.read_bytes())
    with make_server('127.0.0.1', 0, app, handler_class=QuietHandler) as server:
        print(json.dumps({'port': server.server_port, 'token': token}), flush=True)
        server.serve_forever()
