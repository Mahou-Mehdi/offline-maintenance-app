/* Pure state transitions shared by the UI and Node's built-in test runner. */
(function (root) {
  const copy = (value) => JSON.parse(JSON.stringify(value));
  const empty = () => ({orders:{}, pending:{}, conflicts:{}, lastSync:null});
  function edit(state, order, mutationId) {
    const next = copy(state);
    const id = order.id;
    if (next.conflicts[id]) throw new Error('Resolve the existing conflict before editing');
    const base = next.pending[id]?.base_version ?? next.orders[id]?.version ?? 0;
    next.orders[id] = copy(order);
    next.pending[id] = {mutation_id:mutationId, base_version:base, order:copy(order)};
    return next;
  }
  function applyResponse(state, request, status, response) {
    const next = copy(state), id = request.order.id;
    // A stale response must never erase a newer locally queued change.
    if (next.pending[id]?.mutation_id !== request.mutation_id) return next;
    if (status === 200) {
      next.orders[id] = response.order;
      delete next.pending[id]; delete next.conflicts[id];
    } else if (status === 409) {
      next.conflicts[id] = {local:copy(request.order), remote:copy(response.current)};
    } else throw new Error(response.error || `Sync returned ${status}`);
    return next;
  }
  function refresh(state, remoteOrders) {
    const next = copy(state);
    for (const order of remoteOrders) {
      if (!next.pending[order.id] && !next.conflicts[order.id]) next.orders[order.id] = copy(order);
    }
    return next;
  }
  function resolve(state, id, choice, mutationId) {
    const next = copy(state), conflict = next.conflicts[id];
    if (!conflict) throw new Error('No conflict to resolve');
    delete next.conflicts[id]; delete next.pending[id];
    if (choice === 'remote') {
      if (conflict.remote) next.orders[id] = copy(conflict.remote);
      else delete next.orders[id];
    } else if (choice === 'local') {
      const version = conflict.remote?.version ?? 0;
      const order = {...copy(conflict.local), version};
      next.orders[id] = order;
      next.pending[id] = {mutation_id:mutationId, base_version:version, order:copy(order)};
    } else throw new Error('Unknown resolution');
    return next;
  }
  const api = {empty, edit, applyResponse, refresh, resolve};
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SyncModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
