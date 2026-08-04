import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { api, bustCache } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { Spinner, PhotoThumb } from '../../components/ui.jsx';
import ItemEntry from '../../components/ItemEntry.jsx';
import useDebounced, { normalizeName } from '../../lib/useDebounced.js';

// M5 — Item list: category chips, search, sticky All/Not counted/Counted.
export default function ItemList() {
  const { auditId, sectionId } = useParams();
  const [items, setItems] = useState(null);
  const [categories, setCategories] = useState([]);
  const [section, setSection] = useState(null);
  const [cat, setCat] = useState('');       // category filter
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 250);
  const [active, setActive] = useState(null); // item open in the entry sheet
  const scrollRef = useRef(0);                // remembered scroll position

  const load = useCallback(() => {
    return api.get(`/audits/${auditId}/items?section_id=${sectionId}`).then(setItems);
  }, [auditId, sectionId]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/meta/categories').then(setCategories);
    api.get('/meta/sections').then((s) => setSection(s.find((x) => String(x.id) === String(sectionId))));
  }, [sectionId]);

  // Opening the sheet remembers where the user was; closing restores it so the
  // list does not jump back to the top after saving an entry (#6).
  function openItem(item) {
    scrollRef.current = window.scrollY;
    setActive(item);
  }
  function closeSheet() {
    setActive(null);
    requestAnimationFrame(() => window.scrollTo(0, scrollRef.current));
  }

  const sectionCats = useMemo(
    () => categories.filter((c) => String(c.section_id) === String(sectionId)),
    [categories, sectionId]
  );

  // Search, category chip and All/Counted/Not-counted all apply together.
  const filtered = useMemo(() => {
    if (!items) return [];
    const q = normalizeName(debouncedSearch);
    return items.filter((i) => {
      if (cat && String(i.category_id) !== String(cat)) return false;
      if (status === 'counted' && !i.counted) return false;
      if (status === 'notcounted' && i.counted) return false;
      if (q && !normalizeName(i.name).includes(q)) return false;
      return true;
    });
  }, [items, cat, status, debouncedSearch]);

  if (!items) return <Spinner label="Loading items…" />;

  return (
    <div className="min-h-full pb-6">
      <MobileHeader title={section?.name || 'Items'}
                    subtitle={`${items.filter((i) => i.counted).length} / ${items.length} counted`}
                    back={`/a/audit/${auditId}`} />

      <div className="sticky top-[56px] z-10 bg-slate-100/95 backdrop-blur px-3 pt-3 pb-2 space-y-2">
        <input className="field py-2.5" placeholder="Search item…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        {/* Category chips */}
        {sectionCats.length > 0 && (
          <div className="flex gap-2 overflow-x-auto no-scrollbar">
            <button className={cat === '' ? 'chip-on' : 'chip-off'} onClick={() => setCat('')}>All categories</button>
            {sectionCats.map((c) => (
              <button key={c.id} className={String(cat) === String(c.id) ? 'chip-on' : 'chip-off'}
                      onClick={() => setCat(String(c.id))}>{c.name}</button>
            ))}
          </div>
        )}
        {/* Status filter */}
        <div className="flex gap-2">
          {[['all', 'All'], ['notcounted', 'Not counted'], ['counted', 'Counted']].map(([k, label]) => (
            <button key={k} onClick={() => setStatus(k)}
                    className={`flex-1 ${status === k ? 'chip-on' : 'chip-off'} justify-center`}>{label}</button>
          ))}
        </div>
      </div>

      <div className="px-3 divide-y">
        {filtered.map((i) => (
          <button key={i.id} onClick={() => openItem(i)}
                  className="w-full flex items-center gap-3 py-3 text-left active:bg-slate-50">
            <PhotoThumb src={bustCache(i.photo_url, i.photo_version)} size={64} />
            <div className="flex-1 min-w-0">
              <div className="font-bold truncate">{i.name}</div>
              <div className="text-sm text-slate-500">{i.is_liquor ? 'Bottle · liquor' : i.unit}</div>
              {i.not_applicable && <div className="text-xs text-amber-600">Not applicable</div>}
            </div>
            <div className="text-right">
              {i.counted ? (
                <div className="flex items-center gap-1 justify-end">
                  <span className="text-green-600 text-lg">✓</span>
                  <span className="font-semibold">
                    {i.is_liquor
                      ? `${i.total_bottles ?? 0} btl`
                      : `${Number(i.total_qty ?? 0).toFixed(i.total_qty % 1 ? 3 : 0)}`}
                  </span>
                </div>
              ) : (
                <span className="inline-block h-3 w-3 rounded-full bg-slate-300" />
              )}
            </div>
          </button>
        ))}
        {filtered.length === 0 && <div className="p-8 text-center text-slate-400">No items match.</div>}
      </div>

      {active && (
        <ItemEntry auditId={auditId} item={active}
                   onClose={closeSheet}
                   onSaved={load} />
      )}
    </div>
  );
}
