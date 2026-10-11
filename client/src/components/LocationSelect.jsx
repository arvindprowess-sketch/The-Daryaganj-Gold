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

// ═══════════════════════════════════════════════════════════════════════════
// Warehouse: the location is TYPED — a rack, bin or godown ("A-12",
// "Godown 2") that no fixed list could hold. Mandatory, like the list: Save
// stays disabled while it is blank, and the server refuses a blank one.
//
// The last location typed carries to the next entry (a counter works one
// rack at a time), and the places already typed in this audit are offered as
// suggestions so the same rack is not spelt three ways.
// ═══════════════════════════════════════════════════════════════════════════
const textKey = (auditId) => `audix_last_location_text_${auditId}`;
const recentKey = (auditId) => `audix_recent_locations_${auditId}`;

export function useStickyLocationText(auditId) {
  const [value, setValue] = useState(() => {
    try { return localStorage.getItem(textKey(auditId)) || ''; } catch { return ''; }
  });
  const set = (v) => {
    setValue(v);
    try { localStorage.setItem(textKey(auditId), v); } catch { /* private mode */ }
  };
  return [value, set];
}

// Remember a location once an entry has been SAVED with it.
export function rememberLocationText(auditId, text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return;
  try {
    const list = JSON.parse(localStorage.getItem(recentKey(auditId)) || '[]')
      .filter((x) => x.toLowerCase() !== t.toLowerCase());
    localStorage.setItem(recentKey(auditId), JSON.stringify([t, ...list].slice(0, 30)));
  } catch { /* private mode */ }
}

function recentLocations(auditId) {
  try { return JSON.parse(localStorage.getItem(recentKey(auditId)) || '[]'); } catch { return []; }
}

export function LocationInput({ auditId, value, onChange, label = 'Location' }) {
  const missing = !String(value || '').trim();
  const listId = `loc-recent-${auditId}`;
  const recent = recentLocations(auditId);
  return (
    <label className="block">
      <span className="text-sm font-medium text-slate-600">
        {label} <span className="text-red-600">*</span>
      </span>
      <input
        className={`field mt-1 text-lg ${missing ? 'border-amber-400' : ''}`}
        value={value || ''} list={listId} maxLength={100}
        autoCapitalize="characters" autoCorrect="off"
        placeholder="Rack / bin / area, e.g. A-12"
        onChange={(e) => onChange(e.target.value)}
      />
      <datalist id={listId}>
        {recent.map((r) => <option key={r} value={r} />)}
      </datalist>
      {missing && (
        <span className="text-xs text-amber-700">Required — type where this stock is kept. You cannot save without it.</span>
      )}
    </label>
  );
}
