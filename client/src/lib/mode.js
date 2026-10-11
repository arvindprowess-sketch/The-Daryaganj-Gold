import { useEffect, useState } from 'react';
import { api } from './api.js';

// ═══════════════════════════════════════════════════════════════════════════
// Which flavour of the app this deployment runs: `cafe` or `warehouse`.
//
// Decided by INVENTORY_MODE on the server and read once per page load. The
// last answer is remembered so a reload — or a phone with no signal — opens
// on the right screens rather than flashing the cafe layout first.
// ═══════════════════════════════════════════════════════════════════════════
const KEY = 'audix_inventory_mode';
let cache = null;
let inFlight = null;

function remembered() {
  try { return localStorage.getItem(KEY); } catch { return null; }
}

export function useInventoryMode() {
  const [mode, setMode] = useState(() => cache || remembered());
  useEffect(() => {
    if (cache) return;
    inFlight = inFlight || api.get('/meta/app');
    let alive = true;
    inFlight
      .then((r) => {
        cache = r?.inventory_mode === 'warehouse' ? 'warehouse' : 'cafe';
        try { localStorage.setItem(KEY, cache); } catch { /* private mode */ }
        if (alive) setMode(cache);
      })
      // Offline with nothing remembered: the cafe layout is the safe default.
      .catch(() => { inFlight = null; if (alive) setMode((m) => m || 'cafe'); });
    return () => { alive = false; };
  }, []);
  return mode; // null until known
}

export const isWarehouse = (mode) => mode === 'warehouse';
