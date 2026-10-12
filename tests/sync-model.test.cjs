const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../web/sync-model.js');
const original = {id:'WO-1',title:'Inspect',notes:'Initial',version:1};
const initial = () => model.refresh(model.empty(), [original]);

test('offline edits persist as one latest snapshot against the original revision', () => {
  let state = model.edit(initial(), {...original,notes:'Offline first'}, 'm1');
  state = model.edit(state, {...original,notes:'Offline latest'}, 'm2');
  // IndexedDB uses structured cloning; JSON roundtrip also preserves this data model.
  state = JSON.parse(JSON.stringify(state));
  assert.equal(state.pending['WO-1'].base_version, 1);
  assert.equal(state.pending['WO-1'].order.notes, 'Offline latest');
  assert.equal(Object.keys(state.pending).length, 1);
});
test('server refresh cannot overwrite queued offline edits', () => {
  const state = model.edit(initial(), {...original,notes:'Local'}, 'm1');
  const next = model.refresh(state, [{...original,notes:'Remote',version:2}]);
  assert.equal(next.orders['WO-1'].notes, 'Local');
  assert.equal(next.pending['WO-1'].mutation_id, 'm1');
});
test('acknowledgement removes only the matching mutation', () => {
  const state = model.edit(initial(), {...original,notes:'Local'}, 'm1');
  const next = model.applyResponse(state, state.pending['WO-1'], 200, {order:{...original,notes:'Local',version:2}});
  assert.equal(Object.keys(next.pending).length, 0);
  assert.equal(next.orders['WO-1'].version, 2);
  assert.equal(Object.keys(state.pending).length, 1);
});
test('stale acknowledgement never removes a newer local mutation', () => {
  const first = model.edit(initial(), {...original,notes:'First'}, 'm1');
  const next = model.edit(first, {...original,notes:'Second'}, 'm2');
  const result = model.applyResponse(next, first.pending['WO-1'], 200, {order:{...original,notes:'First',version:2}});
  assert.equal(result.orders['WO-1'].notes, 'Second');
  assert.equal(result.pending['WO-1'].mutation_id, 'm2');
});
test('conflict preserves both full records and requires explicit resolution', () => {
  const state = model.edit(initial(), {...original,notes:'Local'}, 'm1');
  const conflict = model.applyResponse(state, state.pending['WO-1'], 409, {current:{...original,notes:'Remote',version:2}});
  assert.equal(conflict.conflicts['WO-1'].local.notes, 'Local');
  assert.equal(conflict.conflicts['WO-1'].remote.notes, 'Remote');
  assert.throws(() => model.edit(conflict, original, 'm2'), /Resolve/);
  const keep = model.resolve(conflict, 'WO-1', 'local', 'm3');
  assert.equal(keep.pending['WO-1'].base_version, 2);
  assert.equal(keep.pending['WO-1'].order.notes, 'Local');
  assert.equal(keep.pending['WO-1'].mutation_id, 'm3');
  const discard = model.resolve(conflict, 'WO-1', 'remote', 'unused');
  assert.equal(discard.orders['WO-1'].notes, 'Remote');
  assert.equal(Object.keys(discard.pending).length, 0);
});
test('unrecognized server failure leaves the input state intact', () => {
  const state = model.edit(initial(), {...original,notes:'Local'}, 'm1');
  const saved = JSON.stringify(state);
  assert.throws(() => model.applyResponse(state, state.pending['WO-1'], 503, {error:'Busy'}), /Busy/);
  assert.equal(JSON.stringify(state), saved);
});
