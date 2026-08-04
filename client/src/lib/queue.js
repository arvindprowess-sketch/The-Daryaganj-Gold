// ═══════════════════════════════════════════════════════════════════════════
// NETWORK SAFETY NET (not offline mode — only prevents losing typed data)
//   * Drafts: each in-progress entry is mirrored to localStorage as the user
//     types, and never cleared on a failed save.
//   * Queue: a failed submit is queued and auto-retried when the connection
//     returns. A banner reflects the pending count.
// ═══════════════════════════════════════════════════════════════════════════
import { api } from './api.js';

const DRAFT_PREFIX = 'audix_draft_';
const QUEUE_KEY = 'audix_pending_entries';

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
  localStorage.removeItem(draftKey(auditId, itemId));
}

// ── Pending queue ────────────────────────────────────────────────────────────
const listeners = new Set();
function readQueue() {
  try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; }
}
function writeQueue(q) {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(q));
  listeners.forEach((fn) => fn(q.length));
}
export function pendingCount() { return readQueue().length; }
export function onPendingChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function queueEntry(auditId, payload) {
  const q = readQueue();
  q.push({ id: `${Date.now()}_${Math.random().toString(36).slice(2)}`, auditId, payload });
  writeQueue(q);
}

let processing = false;
// Attempts to flush the queue. Resolves to number successfully sent.
export async function flushQueue() {
  if (processing) return 0;
  processing = true;
  let sent = 0;
  try {
    let q = readQueue();
    for (const job of [...q]) {
      try {
        await api.post(`/audits/${job.auditId}/entries`, job.payload);
        q = readQueue().filter((j) => j.id !== job.id);
        writeQueue(q);
        sent++;
      } catch (err) {
        // Validation errors (4xx) will never succeed on retry — drop them so the
        // queue doesn't wedge. Network/5xx errors stay queued for retry.
        if (err.status && err.status >= 400 && err.status < 500) {
          q = readQueue().filter((j) => j.id !== job.id);
          writeQueue(q);
        }
        // stop on the first network failure; try again later
        if (!err.status) break;
      }
    }
  } finally {
    processing = false;
  }
  return sent;
}

// Auto-retry hooks: on reconnect and on a slow interval.
export function startQueueAutoRetry() {
  window.addEventListener('online', flushQueue);
  const timer = setInterval(() => { if (pendingCount() > 0) flushQueue(); }, 15000);
  return () => { window.removeEventListener('online', flushQueue); clearInterval(timer); };
}
