import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

// ═══════════════════════════════════════════════════════════════════════════
// The location picker, and the memory behind it.
//
// Location used to be typed. Two auditors writing "Store Room" and "store
// room" produced two columns in the report, and 618 items meant 618 chances
// to spell one differently. It is now a fixed list, chosen not typed.
// ═══════════════════════════════════════════════════════════════════════════

// The list is global and changes rarely, so it is fetched once per page load
// and shared by every entry sheet rather than re-requested per item.
let cache = null;
let inFlight = null;

export function useLocations() {
  const [locations, setLocations] = useState(cache);
  useEffect(() => {
    if (cache) return;
    inFlight = inFlight || api.get('/meta/locations/active');
    let alive = true;
    inFlight.then((rows) => { cache = rows; if (alive) setLocations(rows); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  return locations;
}

// Clears the cache after an admin edits the list, so the entry screen picks up
// a rename without a reload.
export function refreshLocations() { cache = null; inFlight = null; }

// ── Sticky selection ───────────────────────────────────────────────────────
// An auditor stands in one place and counts everything there before moving on,
// so the last location carries to the next item. Keyed by AUDIT, which is what
// makes it reset when they switch store or audit — a location remembered
// across stores would silently mis-file a count.
const key = (auditId) => `audix_last_location_${auditId}`;

export function useStickyLocation(auditId) {
  const [value, setValue] = useState(() => {
    try { return localStorage.getItem(key(auditId)) || ''; } catch { return ''; }
  });
  const set = (v) => {
    setValue(v);
    try { if (v) localStorage.setItem(key(auditId), String(v)); } catch { /* private mode */ }
  };
  return [value, set];
}

export default function LocationSelect({ value, onChange, label = 'Location' }) {
  const locations = useLocations();
  const missing = !value;
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-600">
        {label} <span className="text-red-600">*</span>
      </span>
      <select
        className={`field mt-1 text-lg ${missing ? 'border-amber-400' : ''}`}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">Choose a location…</option>
        {(locations || []).map((l) => (
          <option key={l.id} value={l.id}>{l.name}</option>
        ))}
      </select>
      {missing && (
        <span className="text-xs text-amber-700">Required — pick where you are counting.</span>
      )}
    </label>
  );
}
