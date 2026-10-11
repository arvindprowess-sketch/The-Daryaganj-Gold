import { useEffect, useState } from 'react';
import { api } from './api.js';

// ═══════════════════════════════════════════════════════════════════════════
// Cafe or warehouse — decided by the STORE, never chosen by the user.
//
// Each store is marked Cafe or Warehouse by the admin (Stores & Users). An
// audit opens in its store's layout automatically: a cafe by super category
// with a blind count, a warehouse batch by batch. The admin console shows
// Item Master while a cafe store exists and Stock while a warehouse one does.
// ═══════════════════════════════════════════════════════════════════════════

const STORES_CHANGED = 'audix:stores-changed';

// Call after a store is added or its type changes, so the admin menu follows
// without a reload.
export function storesChanged() {
  window.dispatchEvent(new Event(STORES_CHANGED));
}

// { has_cafe, has_warehouse } across active stores; null until known.
export function useStoreKinds() {
  const [kinds, setKinds] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/meta/app')
      .then((r) => { if (alive) setKinds(r); })
      // Unknown (offline): the cafe layout, which is what every store was.
      .catch(() => { if (alive) setKinds((k) => k || { has_cafe: true, has_warehouse: false }); });
    load();
    window.addEventListener(STORES_CHANGED, load);
    return () => { alive = false; window.removeEventListener(STORES_CHANGED, load); };
  }, []);
  return kinds;
}

// The layout one audit is counted in. Remembered per audit, so a phone that
// loses signal mid-count reopens on the same screens.
const KEY = (auditId) => `audix_audit_mode_${auditId}`;
const memo = new Map();

function remembered(auditId) {
  if (memo.has(String(auditId))) return memo.get(String(auditId));
  try { return localStorage.getItem(KEY(auditId)); } catch { return null; }
}

export function useAuditMode(auditId) {
  const [mode, setMode] = useState(() => remembered(auditId));
  useEffect(() => {
    if (!auditId) return undefined;
    let alive = true;
    api.get(`/audits/${auditId}`)
      .then((a) => {
        const m = a?.inventory_mode === 'warehouse' ? 'warehouse' : 'cafe';
        memo.set(String(auditId), m);
        try { localStorage.setItem(KEY(auditId), m); } catch { /* private mode */ }
        if (alive) setMode(m);
      })
      .catch(() => { if (alive) setMode((m) => m || 'cafe'); });
    return () => { alive = false; };
  }, [auditId]);
  return mode; // null until known
}
