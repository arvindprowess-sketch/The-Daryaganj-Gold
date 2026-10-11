// ═══════════════════════════════════════════════════════════════════════════
// NETWORK SAFETY NET (not offline mode — only prevents losing typed data)
//   * Drafts: each in-progress entry is mirrored to localStorage as the user
//     types, and never cleared on a failed save.
//   * Queue: a failed submit is queued and auto-retried when the connection
//     returns. A banner reflects the pending count.
// ═══════════════════════════════════════════════════════════════════════════
import { api, getToken } from './api.js';

const DRAFT_PREFIX = 'audix_draft_';
const QUEUE_KEY = 'audix_pending_entries';
// Entries the server refused outright. Parked, never dropped — see below.
const REJECT_KEY = 'audix_rejected_entries';

// ── Client reference ────────────────────────────────────────────────────────
// Stamped on every save. The server treats the same reference from the same
// person as the same entry, so a save that is retried — after a lost reply,
// from the queue, or by a second tap — can never be recorded twice.
// crypto.randomUUID needs a secure context, which a phone on a LAN IP is not.
export function newClientRef() {
  try { if (crypto?.randomUUID) return crypto.randomUUID(); } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

// Entries still waiting to reach the server for one audit. Submitting while
// any exist would leave them out of the submission without anyone noticing.
export function pendingFor(auditId) {
  return readQueue().filter((j) => String(j.auditId) === String(auditId)).length;
}
export function rejectedFor(auditId) {
  return readRejects().filter((j) => String(j.auditId) === String(auditId));
}

// ── Drafts ──────────────────────────────────────────────────────────────────
export function draftKey(auditId, itemId) {
  return `${DRAFT_PREFIX}${auditId}_${itemId}`;
}
export function saveDraft(auditId, itemId, data) {
  try { localStorage.setItem(draftKey(auditId, itemId), JSON.stringify(data)); } catch {}
}
export function loadDraft(auditId, itemId) {
  try { return JSON.parse(localStorage.getItem(draftKey(auditId, itemId)) || 'null'); }
  catch { return null; }
}
export function clearDraft(auditId, itemId) {
  try { localStorage.removeItem(draftKey(auditId, itemId)); } catch { /* private mode */ }
}

// ── Storage that cannot silently fail ───────────────────────────────────────
// The browser gives a site a few MB. A write that does not fit THROWS — and a
// queued count that throws on the way into storage is a count that is gone,
// with nothing on screen to say so. So a write first tries as is; if storage
// is full it makes room by dropping drafts (half-typed forms — the least
// valuable thing stored here, never a queued or refused entry) and tries once
// more; and if it still cannot, it says so to the caller instead of throwing.
function safeSet(key, value) {
  try { localStorage.setItem(key, value); return true; } catch { /* full, or blocked */ }
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(DRAFT_PREFIX)) localStorage.removeItem(k);
    }
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

// ── Pending queue ────────────────────────────────────────────────────────────
const listeners = new Set();
function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function writeQueue(q) {
  const ok = safeSet(QUEUE_KEY, JSON.stringify(q));
  if (ok) listeners.forEach((fn) => fn(q.length));
  return ok;
}
export function pendingCount() { return readQueue().length; }
export function onPendingChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// The job records WHO counted it. The retry may run in a different session —
// after a logout, or on a shared phone — and an entry must never be filed
// under whoever happens to be signed in when the network returns.
//
// Returns TRUE only when the entry is really stored on this phone. FALSE means
// it could not be kept (storage full or blocked) — the caller must tell the
// auditor it is NOT saved anywhere and keep the form as it is.
export function queueEntry(auditId, payload, userId) {
  const q = readQueue();
  // The same save tapped twice while offline is one queued entry: the server
  // would treat the second as a duplicate anyway (same client_ref).
  if (payload?.client_ref && q.some((j) => j.payload?.client_ref === payload.client_ref)) return true;
  q.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
           auditId, payload, userId: userId ?? null, queuedAt: Date.now() });
  return writeQueue(q);
}

// ── Rejected entries ────────────────────────────────────────────────────────
// A queued entry the server refuses on its merits cannot be retried, but it is
// still a count somebody took in a store. It is parked here with the reason
// rather than deleted, so it can be shown and re-entered.
function readRejects() {
  try { return JSON.parse(localStorage.getItem(REJECT_KEY) || '[]'); } catch { return []; }
}
function writeRejects(list) {
  const ok = safeSet(REJECT_KEY, JSON.stringify(list));
  if (!ok) return false;
  rejectListeners.forEach((fn) => fn(list.length));
  return true;
}
const rejectListeners = new Set();
export function rejectedEntries() { return readRejects(); }
export function onRejectedChange(fn) { rejectListeners.add(fn); return () => rejectListeners.delete(fn); }
export function clearRejected(id) {
  writeRejects(id ? readRejects().filter((r) => r.id !== id) : []);
}

// A refusal that says "not now", not "never". Retrying these is the whole
// point of a queue:
//   401/403  no token or not accepted yet — the auditor is signed out, or
//            signing back in. THIS is what silently destroyed entries: the
//            retry timer runs on the login screen, where every POST is a 401,
//            and a 401 counted as "will never succeed".
//   408/425/429  timeout, too early, rate limited.
//   5xx      the server is having a bad minute.
const RETRY_LATER = new Set([401, 403, 408, 425, 429]);
const retryLater = (s) => !s || s >= 500 || RETRY_LATER.has(s);

let processing = false;
// Attempts to flush the queue. Resolves to the number successfully sent.
export async function flushQueue() {
  if (processing) return 0;
  // Signed out: there is nobody to file these under. Keep them and wait.
  if (!getToken()) return 0;
  processing = true;
  let sent = 0;
  try {
    let q = readQueue();
    for (const job of [...q]) {
      // Queued by someone else on this device — leave it for them.
      if (job.userId != null && currentUserId != null && job.userId !== currentUserId) continue;
      try {
        await api.post(`/audits/${job.auditId}/entries`, job.payload);
        q = readQueue().filter((j) => j.id !== job.id);
        writeQueue(q);
        sent++;
      } catch (err) {
        if (retryLater(err.status)) {
          // Nothing is discarded. Stop and try the whole queue again later.
          break;
        }
        // A real refusal (bad data, audit closed, item gone). It cannot be
        // retried — but it is still somebody's count, so it is parked with the
        // reason instead of vanishing.
        // Parked FIRST, removed from the queue only once parking has worked —
        // the other order loses the entry if storage is full in between.
        const parked = writeRejects([...readRejects(),
          { ...job, error: err.message || `Refused (${err.status})`, status: err.status }]);
        if (!parked) break;
        q = readQueue().filter((j) => j.id !== job.id);
        writeQueue(q);
      }
    }
  } finally {
    processing = false;
  }
  return sent;
}

// Who the retry is allowed to file entries for. Set from the session.
let currentUserId = null;
export function setQueueUser(id) { currentUserId = id ?? null; }

// Auto-retry hooks: on reconnect and on a slow interval.
export function startQueueAutoRetry() {
  window.addEventListener('online', flushQueue);
  const timer = setInterval(() => { if (pendingCount() > 0) flushQueue(); }, 15000);
  return () => { window.removeEventListener('online', flushQueue); clearInterval(timer); };
}
