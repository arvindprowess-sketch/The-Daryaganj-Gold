import { Fragment, useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, bustCache } from '../../lib/api.js';
import { Spinner, PhotoThumb } from '../../components/ui.jsx';
import ItemEntry from '../../components/ItemEntry.jsx';
import { useToast } from '../../components/Toast.jsx';
import useDebounced, { normalizeName } from '../../lib/useDebounced.js';

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
  useEffect(() => { api.get('/meta/categories').then(setCategories); }, []);

  // Search + category + All/Counted/Not-counted all apply together.
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
            {audit && new Date(audit.audit_date).toLocaleDateString()} · {audit?.status}
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
        <div className="flex gap-2 overflow-x-auto no-scrollbar">
          <button className={cat === '' ? 'chip-on' : 'chip-off'} onClick={() => setCat('')}>All categories</button>
          {categories.map((c) => (
            <button key={c.id} className={String(cat) === String(c.id) ? 'chip-on' : 'chip-off'}
                    onClick={() => setCat(String(c.id))}>{c.name}</button>
          ))}
        </div>
        <div className="flex gap-2">
          {[['all', 'All'], ['notcounted', 'Not counted'], ['counted', 'Counted']].map(([k, label]) => (
            <button key={k} onClick={() => setStatus(k)}
                    className={`flex-1 md:flex-none justify-center ${status === k ? 'chip-on' : 'chip-off'}`}>{label}</button>
          ))}
        </div>
      </div>

      <p className="text-sm text-slate-500 mb-2">
        Showing {filtered.length} of {items.length} items.
      </p>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-3 py-3"></th><th className="px-3 py-3">Item</th>
            <th className="px-3 py-3">Total</th><th className="px-3 py-3 w-64">Add entry</th>
            <th className="px-3 py-3">Location</th><th className="px-3 py-3"></th></tr></thead>
          <tbody className="divide-y">
            {filtered.map((i) => {
              const r = rowState[i.id] || {};
              const detail = entriesByItem[i.id];
              const isOpen = !!expanded[i.id];
              return (
                <Fragment key={i.id}>
                  <tr>
                    <td className="px-3 py-2"><PhotoThumb src={bustCache(i.photo_url, i.photo_version)} size={40} /></td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{i.name}</div>
                      <div className="text-xs text-slate-400">{i.is_liquor ? 'Bottle' : i.unit}</div>
                    </td>
                    <td className="px-3 py-2">
                      {i.counted
                        ? <span className="text-green-600 font-semibold">
                            {i.is_liquor ? `${i.total_bottles ?? 0} btl / ${i.total_open_ml ?? 0} ml` : Number(i.total_qty ?? 0)}
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
                      <td colSpan={5} className="px-3 py-3">
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
                                <td className="py-1">{new Date(e.counted_at).toLocaleString()}</td>
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
                                  ? `${detail.total_bottles} btl · ${detail.total_open_ml} ml`
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
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="p-8 text-center text-slate-400">No items match.</td></tr>
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
