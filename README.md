# Offline Maintenance App · Field Notes

A local-first maintenance work-order application with checklists, notes, offline saves, durable synchronization, and explicit conflict resolution. Built by Mahou Mehdi as an independent portfolio implementation.

**A real backend and a real offline queue:** Python/SQLite stores authoritative revisions; IndexedDB stores device records and pending changes; a service worker caches the interface for offline reloads. No external packages, accounts, or API keys are needed.

## Start

Requires Python 3.10+ and a modern browser with IndexedDB, service workers, `crypto.randomUUID`, and `AbortSignal.timeout`. Node 20+ is needed only for the JavaScript tests.

```sh
python server.py --port 8012
```

Open **http://127.0.0.1:8012**. The server binds only to localhost and creates `runtime/maintenance.sqlite3` with three clearly fictional demonstration work orders. Stop with Ctrl+C. `requirements.txt` deliberately contains no external dependencies.

Choose an order, edit its checklist or notes, and select **Save changes**. This first commits your changes to IndexedDB. **Sync now** sends saved changes to the server. Automatic sync runs every 12 seconds while the app is open and the form has no unsaved changes, and when the browser reports a restored connection.

## Implemented features

- Create and edit work orders, equipment labels, assignees, due dates, status, notes, and up to 30 checklist entries.
- Filter the work-order list by status; see active, complete, pending, and conflicted counts.
- Persist the current snapshot and pending mutations on the device before attempting the network.
- Reload the cached application shell while the server is unavailable after an initial successful visit.
- Replay interrupted sync requests without applying them twice.
- Detect stale revisions and preserve both local and server records for review.
- Choose the server record or explicitly queue your reviewed local record against the latest known revision.
- Export all saved device state, including queued edits and conflicts, as a JSON backup. Import is not implemented.
- Prevent simultaneous writers in tabs of the same browser profile using the Web Locks API. Separate browser profiles can act as separate clients.

## Reproduce the offline workflow

1. Start the server and visit the app once. Wait for **Offline app shell ready** and a completed sync.
2. Stop the server with Ctrl+C. Leave the browser tab open.
3. Edit an order's notes and checklist; choose **Save changes**. The pending counter increases. A network failure leaves that mutation queued.
4. Reload the page. The interface and your saved edit remain available through the service worker and IndexedDB. Browser storage must remain enabled.
5. Restart the server with the same command and database. Choose **Sync now**. The pending counter returns to zero and the order's revision increases.

The local page must be visited successfully before offline use. Keep the exact origin (`http://127.0.0.1:8012`); `localhost` and another port have different browser storage. Private browsing may remove data when the private session closes. The app does not sync while completely closed.

## Reproduce a conflict with two clients

Use two separate browser profiles (or one regular and one private session), not two tabs sharing the same IndexedDB:

1. Open the app in both profiles and load the same order at revision 1.
2. Stop the server. Save different notes for that order in each client. Both queues now reference revision 1.
3. Restart the server. Sync client A first, then client B. The first successful writer creates revision 2; the second receives `409 Conflict`.
4. In the conflicting client, inspect both complete records. No local saved edit has been silently overwritten.
5. **Keep my version & retry** queues the local snapshot against the reviewed remote revision. Choose **Sync now** to submit it. A further concurrent edit causes another conflict. **Use server version** explicitly discards the queued local version and adopts the reviewed server record.

Automatic sync can change which client wins, but one succeeds and the other must review. For a manual merge, copy the useful text from both records, select a version, then edit and save the combined notes. There is no automatic field merge.

## Synchronization contract

```text
Form → Save → IndexedDB {orders, pending, conflicts}
                       ↓ POST /api/sync
SQLite transaction → compare base_version with current revision
                       ├─ match: write next revision + record mutation response
                       └─ mismatch: 409 + current server record
```

`POST /api/sync` accepts:

```json
{
  "mutation_id": "a-new-uuid-for-this-edit",
  "base_version": 1,
  "order": {
    "id": "WO-1001",
    "title": "Quarterly conveyor inspection",
    "equipment": "Conveyor C20",
    "assignee": "Alex",
    "due": "2026-10-16",
    "status": "in_progress",
    "notes": "Demo observation",
    "checklist": [{"id":"c1","label":"Record operating hours","done":true}]
  }
}
```

`base_version: 0` creates a new ID. Order IDs must begin with `WO-` followed by letters, digits, underscores, or hyphens (80 characters total at most). Every successful write increments its revision. The client coalesces successive unsynced saves for one order into one latest snapshot while retaining the original base revision. It preserves the same mutation ID for retries of that snapshot. SQLite's `BEGIN IMMEDIATE` serializes the compare-and-write step. The revision update and replay response commit in the same transaction. A previously accepted mutation returns its stored response; reuse with different content is rejected with `422`.

`GET /api/orders` returns all current server records. Refresh never replaces an order with a pending local mutation or unresolved conflict. Network timeouts and server errors do not delete queued edits. A successful write followed by a lost response is safe to retry.

## Tests

From the repository root:

```sh
python -m unittest discover -s tests -v
node tests/sync-model.test.cjs
node --check web/app.js
node --check web/sw.js
```

Actual local validation: **13 Python tests and 6 JavaScript tests pass.** Python tests cover seed persistence, revisions, replay after later updates, duplicate mutation IDs, explicit conflict/retry, competing concurrent transactions, input validation, live HTTP API responses, and availability of all offline-shell assets. JavaScript tests cover queued snapshot preservation, refresh isolation, matching/stale acknowledgements, both conflict resolutions, and failure retention. CI repeats these on Python 3.12 and Node 22.

These automated tests verify the server and shared synchronization state transitions; they do not simulate a full browser or prove service-worker behavior in every browser. The manual offline/reload and two-client procedures above cover that integration boundary.

## Structure

```text
server.py             HTTP API, validation, SQLite transactions and replay log
seed.json             Original fictional maintenance records
web/index.html        Work-order interface
web/app.js            IndexedDB, forms, network orchestration, writer lock
web/sync-model.js     Pure, tested synchronization state transitions
web/sw.js             Offline application-shell cache; API calls stay network-only
tests/                Python integration tests and Node state-model tests
runtime/              Local database and temporary test files; ignored by Git
```

## Scope and limitations

This is a demonstrable local engineering prototype, not a production maintenance system. It has no login, role permissions, photo uploads, attachments, audit-history UI, push notifications, or background sync after closing the app. Assignees are plain labels. No database migrations or replay-log pruning are implemented. The full record is the unit of concurrency; choosing a local version can explicitly replace another client's fields, so review both versions first.

The server has basic body limits, field validation, same-origin write checks, and a static-file allowlist, but is not hardened for public hosting. Keep its localhost binding. Production use would need authentication, authorization, HTTPS, migrations, backup/restore, observability, and a retention policy. Browser storage can be cleared or evicted; export device backups for work you care about. Web Locks provide the single-writer guard where supported; on browsers without them, use one app tab only.

To inspect a fresh backend without changing your existing database, run `python server.py --port 8013 --db runtime/fresh-demo.sqlite3` and visit that new origin. Its browser state will also be separate.

## License

MIT · Copyright 2026 Mahou Mehdi. The fictional seed records are included under the same license.
