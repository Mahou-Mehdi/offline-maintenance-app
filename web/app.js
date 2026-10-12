/* Local-first storage, single-tab writer lock, and explicit revision resolution. */
const $ = (id) => document.getElementById(id);
let db, state = SyncModel.empty(), selected = null, busy = false, dirty = false;
let reachable = false, writable = false;
const uid = () => crypto.randomUUID();
const say = (message) => { $('message').textContent = message; };

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('field-notes', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function readState() {
  return new Promise((resolve, reject) => {
    const request = db.transaction('workspace').objectStore('workspace').get('state');
    request.onsuccess = () => resolve(request.result || SyncModel.empty());
    request.onerror = () => reject(request.error);
  });
}
function persist(next) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('workspace', 'readwrite');
    tx.objectStore('workspace').put(next, 'state');
    tx.oncomplete = () => { state = next; resolve(); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('Local save aborted'));
  });
}
function setBusy(value) {
  busy = value;
  $('order-fields').disabled = busy || !writable || Boolean(state.conflicts[selected]);
  for (const id of ['sync', 'new-order', 'keep-local', 'use-remote']) $(id).disabled = busy || !writable;
  $('filter').disabled = busy;
}
async function run(action) {
  if (busy || !writable) return;
  setBusy(true);
  try { await action(); }
  catch (error) { say(`Action failed: ${error.message}. Previously saved data remains on this device.`); }
  finally { setBusy(false); }
}
function canLeaveEditor() { return !dirty || window.confirm('Discard the unsaved form changes? Saved offline changes will remain.'); }
function markDirty() { dirty = true; $('save-state').textContent = 'UNSAVED FORM'; say('Save changes to store this form on your device.'); }

function render() {
  const orders = Object.values(state.orders);
  $('metric-open').textContent = orders.filter((o) => o.status !== 'done').length;
  $('metric-done').textContent = orders.filter((o) => o.status === 'done').length;
  $('metric-pending').textContent = Object.keys(state.pending).length;
  $('metric-conflicts').textContent = Object.keys(state.conflicts).length;
  $('connection').textContent = reachable ? 'SERVER CONNECTED' : 'OFFLINE / SERVER UNAVAILABLE';
  $('connection').classList.toggle('warning', !reachable);
  $('last-sync').textContent = state.lastSync ? `Last completed sync: ${new Date(state.lastSync).toLocaleString()}` : 'No completed sync on this device yet.';
  const filtered = orders.filter((o) => $('filter').value === 'all' || o.status === $('filter').value).sort((a,b) => a.id.localeCompare(b.id));
  $('orders').replaceChildren(...filtered.map((order) => {
    const button = document.createElement('button');
    button.className = `order-card${order.id === selected ? ' active' : ''}`;
    button.setAttribute('aria-pressed', String(order.id === selected));
    const title = document.createElement('strong'); title.textContent = order.title;
    const equipment = document.createElement('small'); equipment.textContent = order.equipment;
    const meta = document.createElement('span'); meta.className = 'order-meta';
    meta.textContent = `${order.status.replace('_',' ')} · ${state.conflicts[order.id] ? 'Review conflict' : state.pending[order.id] ? 'Saved locally' : `Revision ${order.version}`}`;
    button.append(title, equipment, meta);
    button.addEventListener('click', () => { if (busy || !canLeaveEditor()) return; selected = order.id; dirty = false; render(); });
    return button;
  }));
  if (!filtered.length) { const p = document.createElement('p'); p.className = 'muted'; p.textContent = 'No work orders in this view.'; $('orders').append(p); }
  const order = state.orders[selected];
  $('empty-state').hidden = Boolean(order);
  $('order-form').hidden = !order;
  $('conflict').hidden = !state.conflicts[selected];
  if (order) showEditor(order);
  if (state.conflicts[selected]) {
    $('local-version').textContent = JSON.stringify(state.conflicts[selected].local, null, 2);
    $('remote-version').textContent = JSON.stringify(state.conflicts[selected].remote, null, 2);
  }
  setBusy(busy);
}
function showEditor(order) {
  $('order-id').textContent = order.id;
  $('save-state').textContent = state.conflicts[order.id] ? 'CONFLICT' : state.pending[order.id] ? 'SAVED ON DEVICE' : `SYNCED · REV ${order.version}`;
  for (const key of ['title','equipment','assignee','due','status','notes']) $(key).value = order[key];
  $('checklist').replaceChildren();
  for (const check of order.checklist) addCheck(check);
}
function addCheck(check) {
  const row = document.createElement('div'); row.className = 'check-row'; row.dataset.id = check.id;
  const box = document.createElement('input'); box.type = 'checkbox'; box.id = `check-${check.id}`; box.checked = check.done;
  const label = document.createElement('label'); label.htmlFor = box.id; label.textContent = check.label;
  const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove checklist item: ${check.label}`);
  remove.addEventListener('click', () => { row.remove(); markDirty(); });
  row.append(box, label, remove); $('checklist').append(row);
}
function formOrder() {
  const order = {id:selected, version:state.orders[selected]?.version ?? 0};
  for (const key of ['title','equipment','assignee','due','status','notes']) order[key] = $(key).value;
  for (const key of ['title','equipment','assignee']) order[key] = order[key].trim();
  order.checklist = Array.from($('checklist').children).map((row) => ({id:row.dataset.id, label:row.querySelector('label').textContent, done:row.querySelector('input').checked}));
  return order;
}
async function request(path, options = {}) {
  const response = await fetch(path, {...options, signal:AbortSignal.timeout(8000), cache:'no-store'});
  const data = await response.json();
  return {response, data};
}
async function sync() {
  if (dirty || busy || !writable) return;
  await run(async () => {
    try {
      for (const pending of Object.values(state.pending)) {
        if (state.conflicts[pending.order.id]) continue;
        const {response, data} = await request('/api/sync', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(pending)});
        if (response.status !== 200 && response.status !== 409) throw new Error(data.error || 'Sync failed');
        await persist(SyncModel.applyResponse(state, pending, response.status, data));
      }
      const {response, data} = await request('/api/orders');
      if (!response.ok) throw new Error(data.error || 'Could not refresh orders');
      const next = SyncModel.refresh(state, data.orders); next.lastSync = new Date().toISOString();
      await persist(next); reachable = true;
      if (!selected) selected = Object.keys(state.orders)[0] || null;
      say(Object.keys(state.conflicts).length ? 'Sync finished. Review the conflicting orders; your local edits have been preserved.' : 'All saved changes are synchronized.');
    } catch (error) {
      reachable = false;
      say(`Sync incomplete: ${error.message}. Saved changes remain queued on this device. Retry when the server is available.`);
    }
    render();
  });
}

$('order-form').addEventListener('input', markDirty);
$('order-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const order = formOrder();
  if (!order.title || !order.equipment) { say('Enter a title and equipment name before saving.'); return; }
  run(async () => { await persist(SyncModel.edit(state, order, uid())); dirty = false; render(); say('Saved on this device. Sync now or wait for the next connection check.'); });
});
$('new-order').addEventListener('click', () => {
  if (busy || !writable || !canLeaveEditor()) return;
  selected = `WO-${uid().slice(0,8)}`;
  $('empty-state').hidden = true; $('order-form').hidden = false; $('conflict').hidden = true;
  showEditor({id:selected,title:'',equipment:'',assignee:'',due:'',status:'open',notes:'',checklist:[],version:0});
  setBusy(false); markDirty(); $('title').focus();
});
$('add-check').addEventListener('click', () => {
  if ($('checklist').children.length >= 30) { say('A work order can contain up to 30 checklist items.'); return; }
  const label = window.prompt('Checklist item (up to 200 characters)');
  if (label?.trim()) { addCheck({id:uid(),label:label.trim().slice(0,200),done:false}); markDirty(); }
});
$('filter').addEventListener('change', () => { if (canLeaveEditor()) { dirty = false; render(); } });
$('sync').addEventListener('click', () => { if (dirty) say('Save your form changes before syncing.'); else sync(); });
for (const [id, choice] of [['keep-local','local'],['use-remote','remote']]) {
  $(id).addEventListener('click', () => run(async () => { await persist(SyncModel.resolve(state, selected, choice, uid())); render(); say(choice === 'local' ? 'Your version is queued against the reviewed server revision. Choose Sync now to retry.' : 'The server version is now saved on this device.'); }));
}
$('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({exported_at:new Date().toISOString(),state},null,2)], {type:'application/json'});
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = 'field-notes-device-backup.json'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
window.addEventListener('beforeunload', (event) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('online', sync);
window.addEventListener('offline', () => { reachable = false; $('connection').textContent = 'OFFLINE'; $('connection').classList.add('warning'); });

async function boot() {
  db = await openDatabase(); state = await readState(); writable = true;
  selected = Object.keys(state.orders)[0] || null; render();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
      $('offline-ready').textContent = 'Offline app shell ready';
    }).catch(() => { $('offline-ready').textContent = 'Offline reload unavailable; keep this tab open'; });
  } else $('offline-ready').textContent = 'Offline reload unsupported in this browser';
  await sync(); setInterval(sync, 12000);
}
async function start() {
  if (navigator.locks) {
    await navigator.locks.request('field-notes-single-writer', {ifAvailable:true}, async (lock) => {
      if (!lock) { say('Field Notes is already open in another tab. Close that tab, then reload this one.'); setBusy(false); return; }
      await boot(); await new Promise(() => {}); // release writer lock when the tab closes
    });
  } else {
    await boot(); say('This browser has no Web Locks support. Use only one Field Notes tab to avoid competing local saves.');
  }
}
start().catch((error) => { say(`Local storage unavailable: ${error.message}. Enable browser storage and reload.`); setBusy(false); });
