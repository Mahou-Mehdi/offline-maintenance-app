"""Local maintenance API with SQLite revisions and idempotent mutations."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timezone, date
from functools import partial
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import sqlite3
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
STATUSES = {"open", "in_progress", "done"}


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def validate_order(order):
    if not isinstance(order, dict):
        raise ValueError("order must be an object")
    result = {}
    for key, limit in (("id", 80), ("title", 160), ("equipment", 100), ("assignee", 100), ("notes", 5000), ("due", 10), ("status", 20)):
        value = order.get(key)
        if not isinstance(value, str) or len(value) > limit:
            raise ValueError(f"{key} must be a string of at most {limit} characters")
        result[key] = value.strip() if key != "notes" else value
    if not re.fullmatch(r"WO-[a-zA-Z0-9_-]{1,77}", result["id"]):
        raise ValueError("Order ID must start with WO- followed by letters, digits, underscores or hyphens")
    if not result["title"] or not result["equipment"]:
        raise ValueError("Title and equipment are required")
    if result["status"] not in STATUSES:
        raise ValueError("Invalid status")
    if result["due"]:
        date.fromisoformat(result["due"])
    checks = order.get("checklist")
    if not isinstance(checks, list) or len(checks) > 30:
        raise ValueError("Checklist must contain at most 30 entries")
    result["checklist"] = []
    identifiers = set()
    for check in checks:
        if not isinstance(check, dict) or not isinstance(check.get("id"), str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,80}", check["id"]):
            raise ValueError("Invalid checklist identifier")
        if check["id"] in identifiers or not isinstance(check.get("label"), str) or not 1 <= len(check["label"].strip()) <= 200 or type(check.get("done")) is not bool:
            raise ValueError("Invalid or duplicate checklist entry")
        identifiers.add(check["id"])
        result["checklist"].append({"id":check["id"], "label":check["label"].strip(), "done":check["done"]})
    return result


class Store:
    def __init__(self, database):
        self.database = str(database)
        Path(self.database).parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript("""
                CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, version INTEGER NOT NULL, data TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS mutations (id TEXT PRIMARY KEY, digest TEXT NOT NULL, response TEXT NOT NULL);
            """)
            if not conn.execute("SELECT 1 FROM orders LIMIT 1").fetchone():
                for order in json.loads((ROOT / "seed.json").read_text(encoding="utf-8")):
                    validated = validate_order(order)
                    validated.update(version=1, updated_at=now())
                    conn.execute("INSERT INTO orders VALUES (?, ?, ?)", (validated["id"], 1, json.dumps(validated)))

    @contextmanager
    def connect(self):
        conn = sqlite3.connect(self.database, timeout=10)
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def list_orders(self):
        with self.connect() as conn:
            return [json.loads(row[0]) for row in conn.execute("SELECT data FROM orders ORDER BY id")]

    def mutate(self, request):
        if not isinstance(request, dict):
            raise ValueError("Request must be an object")
        mutation_id = request.get("mutation_id")
        revision = request.get("base_version")
        if not isinstance(mutation_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,100}", mutation_id):
            raise ValueError("A valid mutation_id is required")
        if type(revision) is not int or revision < 0:
            raise ValueError("base_version must be a non-negative integer")
        order = validate_order(request.get("order"))
        digest = hashlib.sha256(json.dumps({"order":order, "base_version":revision}, sort_keys=True).encode()).hexdigest()
        with self.connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            replay = conn.execute("SELECT digest, response FROM mutations WHERE id = ?", (mutation_id,)).fetchone()
            if replay:
                if replay[0] != digest:
                    return 422, {"error":"Mutation ID was already used with a different payload"}
                return 200, json.loads(replay[1])
            existing = conn.execute("SELECT version, data FROM orders WHERE id = ?", (order["id"],)).fetchone()
            actual_version = existing[0] if existing else 0
            if actual_version != revision:
                return 409, {"error":"Revision conflict", "current":json.loads(existing[1]) if existing else None}
            order.update(version=actual_version + 1, updated_at=now())
            conn.execute("INSERT INTO orders VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET version=excluded.version, data=excluded.data", (order["id"], order["version"], json.dumps(order)))
            response = {"order":order, "mutation_id":mutation_id}
            conn.execute("INSERT INTO mutations VALUES (?, ?, ?)", (mutation_id, digest, json.dumps(response)))
            return 200, response


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, store, **kwargs):
        self.store = store
        super().__init__(*args, **kwargs)

    def send(self, status, data, mime="application/json; charset=utf-8"):
        raw = json.dumps(data).encode() if mime.startswith("application/json") else data
        self.send_response(status)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/orders":
            self.send(200, {"orders":self.store.list_orders(), "server_time":now()})
        elif path in {"/", "/app.js", "/sync-model.js", "/style.css", "/sw.js", "/manifest.json", "/icon.svg"}:
            filename = "index.html" if path == "/" else path[1:]
            suffix = filename.rsplit(".", 1)[1]
            mime = {"html":"text/html", "js":"text/javascript", "css":"text/css", "json":"application/manifest+json", "svg":"image/svg+xml"}[suffix]
            self.send(200, (ROOT / "web" / filename).read_bytes(), mime + "; charset=utf-8")
        else:
            self.send(404, {"error":"Not found"})

    def do_POST(self):
        if self.path != "/api/sync":
            self.send(404, {"error":"Not found"})
            return
        if self.headers.get_content_type() != "application/json":
            self.send(415, {"error":"Use application/json"})
            return
        origin = self.headers.get("Origin")
        if origin and origin != "http://" + self.headers.get("Host", ""):
            self.send(403, {"error":"Cross-origin writes are not allowed"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= 50000:
                self.send(413, {"error":"Request must be 1–50,000 bytes"})
                return
            status, data = self.store.mutate(json.loads(self.rfile.read(length)))
            self.send(status, data)
        except (ValueError, UnicodeError) as error:
            self.send(400, {"error":str(error)})
        except sqlite3.OperationalError:
            self.send(503, {"error":"Database busy; retry the same mutation"})


def make_server(port=8012, database=None):
    store = Store(database or ROOT / "runtime/maintenance.sqlite3")
    return ThreadingHTTPServer(("127.0.0.1", port), partial(Handler, store=store))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8012)
    parser.add_argument("--db", default=str(ROOT / "runtime/maintenance.sqlite3"))
    args = parser.parse_args()
    server = make_server(args.port, args.db)
    print(f"Field Notes: http://127.0.0.1:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
