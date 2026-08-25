import { Fragment, useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, bustCache } from '../../lib/api.js';
import { Spinner, PhotoThumb } from '../../components/ui.jsx';
import ItemEntry from '../../components/ItemEntry.jsx';
import { useToast } from '../../components/Toast.jsx';
import useDebounced, { normalizeName } from '../../lib/useDebounced.js';
import { liquorBadge } from '../../lib/liquor.js';
import { fmtDateTime, fmtDate } from '../../lib/datetime.js';

// D5 — Count entry on desktop: wide table for fast keyboard entry.
//
// This is the ADMIN WORKING VIEW: each item expands to show every individual
// entry (quantity, location, user, timestamp), with voided entries struck
// through and excluded from the total. This is where an admin verifies how a
// total was arrived at — client reports show totals only.
export default function CountEntry() {
  const { auditId } = useParams();
  const [items, setItems] = useState(null);
  const [audit, setAudit] = useState(null);
  const [entriesByItem, setEntriesByItem] = useState({});
  const [expanded, setExpanded] = useState({});
  const [rowState, setRowState] = useState({});
  const [active, setActive] = useState(null);
  const [savingId, setSavingId] = useState(null);
  const [categories, setCategories] = useState([]);
  const [supers, setSupers] = useState([]);
  const [superCat, setSuperCat] = useState('');
  const [grouped, setGrouped] = useState(true);
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState('all');
  const debouncedSearch = useDebounced(search, 250);
  const toast = useToast();

  const load = useCallback(async () => {
    const [list, detail] = await Promise.all([
      api.get(`/audits/${auditId}/items`),
      api.get(`/audits/${auditId}/entries`),
    ]);
    setItems(list);
    const map = {};
    for (const d of detail) map[d.item_id] = d;
    setEntriesByItem(map);
  }, [auditId]);

  useEffect(() => { load(); api.get(`/audits/${auditId}`).then(setAudit); }, [load, auditId]);
  useEffect(() => {
    api.get('/meta/categories').then(setCategories);
    api.get('/meta/super-categories').then(setSupers);
  }, []);

  // Search + super category + category + All/Counted/Not-counted all combine.
  const filtered = useMemo(() => {
    if (!items) return [];
    const q = normalizeName(debouncedSearch);
    return items.filter((i) => {
      if (superCat && String(i.super_category_id) !== String(superCat)) return false;
      if (cat && String(i.category_id) !== String(cat)) return false;
      if (status === 'counted' && !i.counted) return false;
      if (status === 'notcounted' && i.counted) return false;
      if (q && !normalizeName(i.name).includes(q)) return false;
      return true;
    });
  }, [items, superCat, cat, status, debouncedSearch]);

  // Category chips follow the chosen super category.
  const visibleCats = superCat
    ? categories.filter((c) => String(c.super_category_id) === String(superCat))
    : categories;

  // Grouped super category → category, with subtotals at both levels.
  const groups = useMemo(() => {
    const bySuper = new Map();
    for (const i of filtered) {
      const sKey = i.super_category_name || '—';
      const cKey = i.category_name || '—';
      if (!bySuper.has(sKey)) bySuper.set(sKey, { name: sKey, items: [], categories: new Map() });
      const s = bySuper.get(sKey);
      s.items.push(i);
      if (!s.categories.has(cKey)) s.categories.set(cKey, { name: cKey, items: [] });
      s.categories.get(cKey).items.push(i);
    }
    return [...bySuper.values()].map((s) => ({ ...s, categories: [...s.categories.values()] }));
  }, [filtered]);

  // Subtotal helper: counted-of-total plus summed physical quantity.
  const subtotal = (list) => ({
    items: list.length,
    counted: list.filter((i) => i.counted).length,
    qty: list.filter((i) => !i.is_liquor).reduce((s, i) => s + Number(i.total_qty || 0), 0),
    bottles: list.filter((i) => i.is_liquor).reduce((s, i) => s + Number(i.total_bottles || 0), 0),
    openMl: list.filter((i) => i.is_liquor).reduce((s, i) => s + Number(i.total_open_ml || 0), 0),
  });

  const fmtSub = (t) =>
    [t.qty ? `${Number(t.qty.toFixed(3))}` : null,
     t.bottles ? `${t.bottles} btl` : null,
     t.openMl ? `${t.openMl} ml` : null].filter(Boolean).join(' · ') || '—';

  // Rows grouped super category → category, with a subtotal after each
  // category and after each super category.
  function groupedRows() {
    const out = [];
    for (const g of groups) {
      const gt = subtotal(g.items);
      out.push(
        <tr key={`s-${g.name}`} className="bg-slate-100">
          <td colSpan={8} className="px-3 py-2 font-bold text-slate-700">{g.name}</td>
        </tr>
      );
      for (const c of g.categories) {
        const ct = subtotal(c.items);
        out.push(
          <tr key={`c-${g.name}-${c.name}`} className="bg-slate-50">
            <td colSpan={8} className="px-3 py-1.5 pl-8 font-semibold text-slate-600 text-xs uppercase tracking-wide">
              {c.name}
            </td>
          </tr>
        );
        for (const i of c.items) out.push(renderItemRow(i));
        out.push(
          <tr key={`ct-${g.name}-${c.name}`} className="bg-slate-50/60 text-slate-600">
            <td></td><td></td>
            <td className="px-3 py-1.5 text-xs font-semibold">{c.name} subtotal</td>
            <td className="px-3 py-1.5 text-xs">{ct.counted}/{ct.items} counted</td>
            <td className="px-3 py-1.5 text-xs font-semibold" colSpan={4}>{fmtSub(ct)}</td>
          </tr>
        );
      }
      out.push(
        <tr key={`gt-${g.name}`} className="bg-slate-100 text-slate-800">
          <td></td>
          <td className="px-3 py-2 text-sm font-bold" colSpan={2}>{g.name} subtotal</td>
          <td className="px-3 py-2 text-sm">{gt.counted}/{gt.items} counted</td>
          <td className="px-3 py-2 text-sm font-bold" colSpan={4}>{fmtSub(gt)}</td>
        </tr>
      );
    }
    return out;
  }

  // One item row (plus its expanded per-entry detail when open).
  function renderItemRow(i) {
              const r = rowState[i.id] || {};
              const detail = entriesByItem[i.id];
              const isOpen = !!expanded[i.id];
              return (
                <Fragment key={i.id}>
                  <tr>
                    <td className="px-3 py-2"><PhotoThumb src={bustCache(i.photo_url, i.photo_version)} size={40} /></td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{i.super_category_name || '—'}</td>
                    <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{i.category_name || '—'}</td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{i.name}</div>
                      {/* Unit shown exactly as the master supplies it. */}
                      <div className="text-xs text-slate-400">{i.unit}</div>
                    </td>
                    <td className="px-3 py-2">
                      {i.counted
                        ? <span className="text-green-600 font-semibold">
                            {i.is_liquor ? liquorBadge(i.total_bottles, i.total_open_ml) : Number(i.total_qty ?? 0)}
                          </span>
                        : <span className="text-slate-300">—</span>}
                      {detail && detail.entries.length > 0 && (
                        <button className="ml-2 text-xs text-brand underline"
                                onClick={() => setExpanded((e) => ({ ...e, [i.id]: !isOpen }))}>
                          {isOpen ? 'hide' : `${detail.entries.length} ${detail.entries.length === 1 ? 'entry' : 'entries'}`}
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {i.is_liquor ? (
                        <div className="flex gap-1">
                          <input className="field py-1.5 px-2 w-20" placeholder="btl" disabled={closed}
                                 value={r.bottles ?? ''} onChange={(e) => setRow(i.id, { bottles: e.target.value.replace(/[^0-9]/g, '') })}
                                 onKeyDown={(e) => e.key === 'Enter' && saveRow(i)} />
                          <input className="field py-1.5 px-2 w-24" placeholder="open ml" disabled={closed}
                                 value={r.open_ml ?? ''} onChange={(e) => setRow(i.id, { open_ml: e.target.value.replace(/[^0-9]/g, '') })}
                                 onKeyDown={(e) => e.key === 'Enter' && saveRow(i)} />
                        </div>
                      ) : (
                        <input className="field py-1.5 px-2 w-28" placeholder="qty (0 ok)" disabled={closed}
                               value={r.qty ?? ''} onChange={(e) => setRow(i.id, { qty: e.target.value.replace(/[^0-9.]/g, '') })}
                               onKeyDown={(e) => e.key === 'Enter' && saveRow(i)} />
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <input className="field py-1.5 px-2 w-40" placeholder="location" disabled={closed}
                             value={r.location ?? ''} onChange={(e) => setRow(i.id, { location: e.target.value })}
                             onKeyDown={(e) => e.key === 'Enter' && saveRow(i)} />
                    </td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <button className="btn-primary py-1.5 px-3 text-sm" disabled={closed || savingId === i.id}
                              onClick={() => saveRow(i)}>{savingId === i.id ? '…' : 'Save'}</button>
                      <button className="text-brand font-medium ml-3" onClick={() => setActive(i)}>Details</button>
                    </td>
                  </tr>

                  {/* Expanded: every individual entry, voided ones struck through */}
                  {isOpen && detail && (
                    <tr className="bg-slate-50">
                      <td></td>
                      <td colSpan={7} className="px-3 py-3">
                        <table className="w-full text-xs">
                          <thead className="text-slate-500 text-left">
                            <tr>
                              <th className="py-1">Quantity</th><th className="py-1">Location</th>
                              <th className="py-1">Counted by</th><th className="py-1">When</th>
                              <th className="py-1">Status</th><th className="py-1"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {detail.entries.map((e) => (
                              <tr key={e.id} className={e.status === 'void' ? 'text-slate-400' : ''}>
                                <td className={`py-1 ${e.status === 'void' ? 'line-through' : 'font-medium'}`}>
                                  {i.is_liquor ? `${e.bottles ?? 0} btl · ${e.open_ml ?? 0} ml` : `${Number(e.qty)} ${i.unit}`}
                                </td>
                                <td className={`py-1 ${e.status === 'void' ? 'line-through' : ''}`}>{e.location_text || '—'}</td>
                                <td className="py-1">{e.counted_by_name}</td>
                                <td className="py-1">{fmtDateTime(e.counted_at, '')}</td>
                                <td className="py-1">
                                  {e.status === 'void'
                                    ? <span className="text-red-500">void: {e.void_reason}</span>
                                    : <span className="text-green-600">active</span>}
                                </td>
                                <td className="py-1 text-right">
                                  {e.status === 'active' && !closed && (
                                    <button className="text-red-600" onClick={() => voidEntry(e, i)}>void</button>
                                  )}
                                </td>
                              </tr>
                            ))}
                            <tr className="border-t">
                              <td className="py-1.5 font-bold">
                                Total: {i.is_liquor
                                  ? liquorBadge(detail.total_bottles, detail.total_open_ml)
                                  : `${detail.total_qty} ${i.unit}`}
                              </td>
                              <td colSpan={5} className="py-1.5 text-slate-400">voided entries excluded</td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
  }

  function setRow(id, patch) { setRowState((p) => ({ ...p, [id]: { ...p[id], ...patch } })); }

  async function saveRow(item) {
    const r = rowState[item.id] || {};
    const payload = { item_id: item.id, location_text: r.location || null };
    if (item.is_liquor) {
      if ((r.bottles ?? '') === '' && (r.open_ml ?? '') === '') return;
      payload.bottles = r.bottles === '' || r.bottles == null ? 0 : Number(r.bottles);
      payload.open_ml = r.open_ml === '' || r.open_ml == null ? 0 : Number(r.open_ml);
    } else {
      if ((r.qty ?? '') === '') return;
      payload.qty = Number(r.qty);
    }
    setSavingId(item.id);
    try {
      await api.post(`/audits/${auditId}/entries`, payload);
      setRowState((p) => ({ ...p, [item.id]: {} }));
      await load();
      toast(`Entry added — ${item.name}`);
    } catch (e) { toast(e.message, 'error'); } finally { setSavingId(null); }
  }

  async function voidEntry(entry, item) {
    const reason = window.prompt(`Reason for voiding this entry of "${item.name}"?`);
    if (!reason || !reason.trim()) return;
    try {
      await api.post(`/entries/${entry.id}/void`, { reason: reason.trim() });
      await load();
      toast('Entry voided');
    } catch (e) { toast(e.message, 'error'); }
  }

  if (!items) return <Spinner />;
  const closed = audit && audit.status !== 'open';

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Count entry — {audit?.store_name}</h1>
          <p className="text-slate-500 text-sm">
            {audit && fmtDate(audit.audit_date)} · {audit?.status}
          </p>
        </div>
        <Link className="btn-ghost" to="/admin/audits">← Audits</Link>
      </div>
      {closed && (
        <div className="mb-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 px-4 py-2 text-sm">
          This audit is {audit.status} — new entries are disabled.
        </div>
      )}

      {/* Search + filters. Sticky so they stay reachable while the list scrolls
          (on mobile this sits below the admin top bar). */}
      <div className="sticky top-0 md:top-0 z-20 -mx-4 md:mx-0 px-4 md:px-0 py-2
                      bg-slate-100/95 md:bg-transparent backdrop-blur md:backdrop-blur-0 space-y-2 mb-3">
        <input className="field py-2.5 md:max-w-sm" placeholder="Search item…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        {/* Super category filter */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          <button className={superCat === '' ? 'chip-on' : 'chip-off'}
                  onClick={() => { setSuperCat(''); setCat(''); }}>All super categories</button>
          {supers.map((s) => (
            <button key={s.id} className={String(superCat) === String(s.id) ? 'chip-on' : 'chip-off'}
                    onClick={() => { setSuperCat(String(s.id)); setCat(''); }}>{s.name}</button>
          ))}
        </div>
        {/* Category filter — narrowed by the chosen super category */}
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          <button className={cat === '' ? 'chip-on' : 'chip-off'} onClick={() => setCat('')}>All categories</button>
          {visibleCats.map((c) => (
            <button key={c.id} className={String(cat) === String(c.id) ? 'chip-on' : 'chip-off'}
                    onClick={() => setCat(String(c.id))}>{c.name}</button>
          ))}
        </div>
        <div className="flex gap-2 items-center">
          {[['all', 'All'], ['notcounted', 'Not counted'], ['counted', 'Counted']].map(([k, label]) => (
            <button key={k} onClick={() => setStatus(k)}
                    className={`flex-1 md:flex-none justify-center ${status === k ? 'chip-on' : 'chip-off'}`}>{label}</button>
          ))}
          <label className="flex items-center gap-2 text-sm text-slate-600 select-none ml-2 shrink-0">
            <input type="checkbox" className="h-5 w-5 accent-teal-700"
                   checked={grouped} onChange={(e) => setGrouped(e.target.checked)} />
            Group &amp; subtotal
          </label>
        </div>
      </div>

      <p className="text-sm text-slate-500 mb-2">
        Showing {filtered.length} of {items.length} items.
      </p>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-3 py-3"></th>
            <th className="px-3 py-3">Super Category</th>
            <th className="px-3 py-3">Category</th>
            <th className="px-3 py-3">Item</th>
            <th className="px-3 py-3">Total</th><th className="px-3 py-3 w-64">Add entry</th>
            <th className="px-3 py-3">Location</th><th className="px-3 py-3"></th></tr></thead>
          <tbody className="divide-y">
            {(grouped ? groupedRows() : filtered.map(renderItemRow))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="p-8 text-center text-slate-400">No items match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {active && (
        <ItemEntry auditId={auditId} item={active} uploadOnly
                   onClose={() => setActive(null)} onSaved={load} />
      )}
    </div>
  );
}
