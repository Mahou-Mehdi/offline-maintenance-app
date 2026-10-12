from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
from pathlib import Path
import threading
import unittest
from uuid import uuid4
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from server import Store, make_server

TEMP_ROOT = Path(__file__).resolve().parents[1] / "runtime" / "tests"
TEMP_ROOT.mkdir(parents=True, exist_ok=True)


class TestDirectory:
    """Normal inherited permissions also work in restricted Windows sandboxes."""
    def __init__(self):
        self.path = TEMP_ROOT / ("run-" + uuid4().hex)
        self.path.mkdir()
        self.name = str(self.path)

    def cleanup(self):
        assert self.path.resolve().parent == TEMP_ROOT.resolve()
        for file in self.path.iterdir():
            file.unlink()
        self.path.rmdir()


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = TestDirectory()
        self.store = Store(Path(self.temp.name) / "test.sqlite3")
        self.order = self.store.list_orders()[0]

    def tearDown(self):
        self.temp.cleanup()

    def mutation(self, name, version=1, notes="Updated locally"):
        order = deepcopy(self.order)
        order["notes"] = notes
        return {"mutation_id":name, "base_version":version, "order":order}

    def test_seed_and_persistence(self):
        self.assertEqual(len(self.store.list_orders()), 3)
        self.assertEqual(Store(self.store.database).list_orders(), self.store.list_orders())

    def test_update_increments_revision(self):
        status, response = self.store.mutate(self.mutation("m1"))
        self.assertEqual(status, 200)
        self.assertEqual(response["order"]["version"], 2)
        self.assertEqual(self.store.list_orders()[0]["notes"], "Updated locally")

    def test_replayed_request_does_not_repeat_or_overwrite(self):
        request = self.mutation("m1")
        first = self.store.mutate(request)
        self.store.mutate(self.mutation("m2", version=2, notes="Later server edit"))
        self.assertEqual(self.store.mutate(request), first)
        self.assertEqual(self.store.list_orders()[0]["version"], 3)
        self.assertEqual(self.store.list_orders()[0]["notes"], "Later server edit")

    def test_mutation_id_reuse_with_different_content_rejected(self):
        self.store.mutate(self.mutation("m1"))
        self.assertEqual(self.store.mutate(self.mutation("m1", notes="Other payload"))[0], 422)

    def test_conflict_preserves_server_version_then_explicit_retry(self):
        self.store.mutate(self.mutation("client-a", notes="Client A"))
        status, response = self.store.mutate(self.mutation("client-b", notes="Client B offline edit"))
        self.assertEqual(status, 409)
        self.assertEqual(response["current"]["notes"], "Client A")
        self.assertEqual(self.store.list_orders()[0]["notes"], "Client A")
        status, response = self.store.mutate(self.mutation("client-b-resolved", version=2, notes="Reviewed merged notes"))
        self.assertEqual(status, 200)
        self.assertEqual(response["order"]["version"], 3)

    def test_concurrent_updates_have_one_winner(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(self.store.mutate, [self.mutation("parallel-a"),self.mutation("parallel-b")]))
        self.assertEqual(sorted(status for status, _ in results), [200, 409])
        self.assertEqual(self.store.list_orders()[0]["version"], 2)

    def test_create_requires_revision_zero(self):
        request = self.mutation("create", version=0)
        request["order"]["id"] = "WO-NEW"
        self.assertEqual(self.store.mutate(request)[0], 200)
        self.assertEqual(len(self.store.list_orders()), 4)

    def test_invalid_data_never_writes(self):
        for key, value in (("id","constructor"),("id","__proto__"),("status","invalid"),("due","2026-99-99"),("title"," "),("checklist",[{"id":"x","label":"Do it","done":"yes"}])):
            request = self.mutation("bad-" + key)
            request["order"][key] = value
            with self.assertRaises(ValueError):
                self.store.mutate(request)
        self.assertEqual(self.store.list_orders()[0]["version"], 1)


class HTTPTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TestDirectory()
        cls.server = make_server(0, Path(cls.temp.name) / "http.sqlite3")
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join(); cls.temp.cleanup()

    def post(self, body, headers=None):
        request = Request(self.base + "/api/sync", data=json.dumps(body).encode(), headers=headers or {"Content-Type":"application/json"})
        try:
            with urlopen(request) as response:
                return response.status, json.load(response)
        except HTTPError as error:
            return error.code, json.load(error)

    def test_http_sync_and_stale_conflict(self):
        with urlopen(self.base + "/api/orders") as response:
            order = json.load(response)["orders"][0]
        order["notes"] = "HTTP integration change"
        body = {"mutation_id":"http-1","base_version":order["version"],"order":order}
        self.assertEqual(self.post(body)[0], 200)
        body["mutation_id"] = "http-stale"
        status, data = self.post(body)
        self.assertEqual(status, 409)
        self.assertEqual(data["current"]["notes"], "HTTP integration change")

    def test_cross_origin_write_rejected(self):
        status, _ = self.post({}, {"Content-Type":"application/json","Origin":"https://untrusted.example"})
        self.assertEqual(status, 403)

    def test_non_json_write_rejected(self):
        self.assertEqual(self.post({}, {"Content-Type":"text/plain"})[0], 415)

    def test_invalid_payload(self):
        self.assertEqual(self.post({})[0], 400)

    def test_offline_shell_assets_available(self):
        for path in ("/", "/sw.js", "/app.js", "/sync-model.js", "/style.css", "/manifest.json", "/icon.svg"):
            with urlopen(self.base + path) as response:
                self.assertEqual(response.status, 200)
                self.assertTrue(response.read())


if __name__ == "__main__":
    unittest.main()
