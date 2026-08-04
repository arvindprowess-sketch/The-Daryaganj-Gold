import { useEffect, useState } from 'react';

// Returns `value` delayed by `delay` ms. Used for search boxes so filtering
// does not re-run on every keystroke while an auditor types on a phone.
export default function useDebounced(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

// Normalises a name for comparison: trims, collapses internal double spaces,
// and lower-cases. Mirrors the server-side rule so client filtering matches.
export function normalizeName(s) {
  return String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
}
