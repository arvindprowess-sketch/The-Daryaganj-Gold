import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { Spinner, VoidMark } from '../../components/ui.jsx';
import BatchSheet from '../../components/BatchSheet.jsx';
import VirtualList from '../../components/VirtualList.jsx';
import useDebounced, { normalizeName } from '../../lib/useDebounced.js';

// ═══════════════════════════════════════════════════════════════════════════
// Warehouse — the articles of one SUPER CATEGORY, the warehouse counterpart of
// the cafe's item list. The auditor gets here the same way: audit → super
// category cards → tap a card.
//
//   card → article (name + description) → its batches (with system stock)
//   → pick or create a batch → physical quantity and location → save
//
// Search covers the WHOLE STORE, not just this category, and matches the
// material description (what a counter usually types) and the material — a
// counter who finds one in the wrong place can still record it. The MATERIAL
// is the identity: every batch and count hangs off it. Typing a whole
// material and pressing Enter opens it directly.
// ═══════════════════════════════════════════════════════════════════════════
export default function StockCount() {
  const { auditId, superCategoryId } = useParams();
  const [items, setItems] = useState(null);        // this super category
  const [allItems, setAllItems] = useState(null);  // whole store, for search
  const [superCategory, setSuperCategory] = useState(null);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 250);
  const [active, setActive] = useState(null);
  const scrollRef = useRef(0);

  const load = useCallback(() => Promise.all([
    api.get(`/audits/${auditId}/items?super_category_id=${superCategoryId}`).then(setItems),
    api.get(`/audits/${auditId}/items`).then(setAllItems),
  ]), [auditId, superCategoryId]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (superCategoryId === 'none') { setSuperCategory({ name: 'UNCATEGORISED' }); return; }
    api.get('/meta/super-categories')
      .then((list) => setSuperCategory(list.find((x) => String(x.id) === String(superCategoryId))));
  }, [superCategoryId]);

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
    const q = normalizeName(debouncedSearch);
    return ((searching ? allItems : items) || []).filter((i) => {
      if (status === 'counted' && !i.counted) return false;
      if (status === 'notcounted' && i.counted) return false;
      if (q && !normalizeName(i.name).includes(q) && !normalizeName(i.description).includes(q)) return false;
      return true;
    });
  }, [items, allItems, status, debouncedSearch, searching]);

  // Enter on an exact material (or the only match) opens it.
  function openExact() {
    const q = normalizeName(search);
    if (!q) return;
    const hit = (allItems || []).find((i) => normalizeName(i.name) === q)
      || (filtered.length === 1 ? filtered[0] : null);
    if (hit) openItem(hit);
  }

  if (!items) return <Spinner label="Loading stock…" />;

  const renderRow = (i) => (
    <button onClick={() => openItem(i)}
            className="w-full h-full flex items-center gap-3 px-3 text-left active:bg-slate-50 border-b border-slate-100">
      <div className="flex-1 min-w-0">
        <div className="font-bold truncate">{i.name}</div>
        <div className="text-sm text-slate-600 truncate">{i.description || '—'}</div>
        <div className="text-xs text-slate-400 truncate">
          {searching && i.category_name ? `${i.category_name} · ` : ''}
          {i.unit ? `${i.unit} · ` : ''}
          {i.batch_count ? `${i.batch_count} ${i.batch_count === 1 ? 'batch' : 'batches'}` : 'no batches'}
        </div>
      </div>
      <VoidMark count={i.void_count} />
      <div className="text-right shrink-0">
        {i.counted ? (
          <div className="flex items-center gap-1 justify-end">
            <span className="text-green-600 text-lg">✓</span>
            <span className="text-sm font-semibold">
              {i.entry_count} {i.entry_count === 1 ? 'entry' : 'entries'}
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
      <MobileHeader title={superCategory?.name || 'Stock'}
                    subtitle={`${items.filter((i) => i.counted).length} / ${items.length} counted`}
                    back={`/a/audit/${auditId}`} />

      <div className="sticky top-[56px] z-10 bg-slate-100/95 backdrop-blur px-3 pt-3 pb-2 space-y-2">
        <input className="field py-2.5" placeholder="Material description or material…"
               value={search} onChange={(e) => setSearch(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && openExact()} enterKeyHint="search" />
        <div className="flex gap-2">
          {[['all', 'All'], ['notcounted', 'Not counted'], ['counted', 'Counted']].map(([k, label]) => (
            <button key={k} onClick={() => setStatus(k)}
                    className={`flex-1 ${status === k ? 'chip-on' : 'chip-off'} justify-center`}>{label}</button>
          ))}
        </div>
        {searching && (
          <p className="text-xs text-slate-500">
            Searching all categories — {filtered.length} match{filtered.length === 1 ? '' : 'es'}.
          </p>
        )}
      </div>

      <VirtualList items={filtered} rowHeight={80} renderRow={renderRow} emptyMessage="No articles match." />

      {active && (
        <BatchSheet auditId={auditId} item={active} onClose={closeSheet} onSaved={load} />
      )}
    </div>
  );
}
