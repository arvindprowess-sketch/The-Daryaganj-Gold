import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { api, bustCache } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { liquorBadge } from '../../lib/liquor.js';
import { Spinner, PhotoThumb, VoidMark } from '../../components/ui.jsx';
import ItemEntry from '../../components/ItemEntry.jsx';
import VirtualList from '../../components/VirtualList.jsx';
import useDebounced, { normalizeName } from '../../lib/useDebounced.js';

// ═══════════════════════════════════════════════════════════════════════════
// M5 — Item list for one SUPER CATEGORY.
//
//  * Rows show item name, unit and photo only. The CATEGORY IS NOT SHOWN —
//    the auditor does not need it (it is on the admin console and in reports).
//  * Search covers the WHOLE STORE, not just the current super category, so a
//    counter who finds an item in the wrong place can still record it.
//  * The list is virtualised: FOOD alone has ~299 items.
// ═══════════════════════════════════════════════════════════════════════════
export default function ItemList() {
  const { auditId, superCategoryId } = useParams();
  const [items, setItems] = useState(null);        // this super category
  const [allItems, setAllItems] = useState(null);  // whole store, for search
  const [superCategory, setSuperCategory] = useState(null);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 250);
  const [active, setActive] = useState(null);
  const scrollRef = useRef(0);

  const load = useCallback(() => {
    return Promise.all([
      api.get(`/audits/${auditId}/items?super_category_id=${superCategoryId}`).then(setItems),
      api.get(`/audits/${auditId}/items`).then(setAllItems),
    ]);
  }, [auditId, superCategoryId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/meta/super-categories')
      .then((list) => setSuperCategory(list.find((x) => String(x.id) === String(superCategoryId))));
  }, [superCategoryId]);

  // Opening the sheet remembers the scroll position; closing restores it, so
  // the list does not jump to the top after saving an entry.
  function openItem(item) {
    scrollRef.current = window.scrollY;
    setActive(item);
  }
  function closeSheet() {
    setActive(null);
    requestAnimationFrame(() => window.scrollTo(0, scrollRef.current));
  }

  const searching = normalizeName(debouncedSearch).length > 0;

  const filtered = useMemo(() => {
    // While searching, look across the whole store; otherwise stay within the
    // chosen super category.
    const source = (searching ? allItems : items) || [];
    const q = normalizeName(debouncedSearch);
    return source.filter((i) => {
      if (status === 'counted' && !i.counted) return false;
      if (status === 'notcounted' && i.counted) return false;
      if (q && !normalizeName(i.name).includes(q)) return false;
      return true;
    });
  }, [items, allItems, status, debouncedSearch, searching]);

  if (!items) return <Spinner label="Loading items…" />;

  const renderRow = (i) => (
    <button onClick={() => openItem(i)}
            className="w-full h-full flex items-center gap-3 px-3 text-left active:bg-slate-50 border-b border-slate-100">
      <PhotoThumb src={bustCache(i.photo_url, i.photo_version)} size={60} />
      <div className="flex-1 min-w-0">
        <div className="font-bold truncate">{i.name}</div>
        {/* Unit is shown exactly as the master supplies it. */}
        <div className="text-sm text-slate-500 truncate">{i.unit}</div>
        {i.not_applicable && <div className="text-xs text-amber-600">Not applicable</div>}
      </div>
      <VoidMark count={i.void_count} />
      <div className="text-right shrink-0">
        {i.counted ? (
          <div className="flex items-center gap-1 justify-end">
            <span className="text-green-600 text-lg">✓</span>
            <span className="font-semibold">
              {i.is_liquor
                ? liquorBadge(i.total_bottles, i.total_open_ml)
                : `${Number(i.total_qty ?? 0).toFixed(i.total_qty % 1 ? 3 : 0)}`}
            </span>
          </div>
        ) : (
          <span className="inline-block h-3 w-3 rounded-full bg-slate-300" />
        )}
      </div>
    </button>
  );

  return (
    <div className="min-h-full pb-6">
      <MobileHeader title={superCategory?.name || 'Items'}
                    subtitle={`${items.filter((i) => i.counted).length} / ${items.length} counted`}
                    back={`/a/audit/${auditId}`} />

      {/* Sticky search + status filter — stays put while the list scrolls. */}
      <div className="sticky top-[56px] z-10 bg-slate-100/95 backdrop-blur px-3 pt-3 pb-2 space-y-2">
        <input className="field py-2.5" placeholder="Search item (whole store)…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex gap-2">
          {[['all', 'All'], ['notcounted', 'Not counted'], ['counted', 'Counted']].map(([k, label]) => (
            <button key={k} onClick={() => setStatus(k)}
                    className={`flex-1 ${status === k ? 'chip-on' : 'chip-off'} justify-center`}>{label}</button>
          ))}
        </div>
        {searching && (
          <p className="text-xs text-slate-500">
            Searching all super categories — {filtered.length} match{filtered.length === 1 ? '' : 'es'}.
          </p>
        )}
      </div>

      <VirtualList items={filtered} rowHeight={80} renderRow={renderRow} />

      {active && (
        <ItemEntry auditId={auditId} item={active} onClose={closeSheet} onSaved={load} />
      )}
    </div>
  );
}
