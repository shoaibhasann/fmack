// ─── In-Memory Result Store ───────────────────────────────────────────────────
// Holds generated question sets temporarily (max 2h) so the frontend can fetch
// them with a short ID instead of receiving huge JSON over SSE.
// ─────────────────────────────────────────────────────────────────────────────

const resultStore = new Map();
let resultCounter = 0;

// Store a result and return its ID. Auto-expires after 2 hours.
export function storeResult(data) {
  const id = `r_${Date.now()}_${++resultCounter}`;
  resultStore.set(id, data);
  setTimeout(() => resultStore.delete(id), 2 * 60 * 60 * 1000);
  return id;
}

// Retrieve a stored result by ID (returns undefined if expired / not found)
export function getResult(id) {
  return resultStore.get(id);
}
