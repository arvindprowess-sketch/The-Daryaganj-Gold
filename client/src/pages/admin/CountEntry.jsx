import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Spinner, PhotoThumb } from '../../components/ui.jsx';
import ItemEntry from '../../components/ItemEntry.jsx';

// D5 — Count entry on desktop: wide table for fast keyboard entry.
// Inline qty/bottles fields post an append-only entry; the sheet opens for
// prior entries, void, and photo (upload-only). Same rules as mobile.
export default function CountEntry() {
  const { auditId } = useParams();
  const [items, setItems] = useState(null);
  const [audit, setAudit] = useState(null);
  const [rowState, setRowState] = useState({}); // { [itemId]: {qty,bottles,open_ml,location} }
  const [active, setActive] = useState(null);
  const [savingId, setSavingId] = useState(null);

  const load = useCallback(() => {
    api.get(`/audits/${auditId}/items`).then(setItems);
  }, [auditId]);
  useEffect(() => { load(); api.get(`/audits/${auditId}`).then(setAudit); }, [load, auditId]);

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
    } catch (e) { alert(e.message); } finally { setSavingId(null); }
  }

  if (!items) return <Spinner />;
  const closed = audit && audit.status !== 'open';

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">Count entry — {audit?.store_name}</h1>
          <p className="text-slate-500 text-sm">{audit && new Date(audit.audit_date).toLocaleDateString()} · {audit?.status}</p>
        </div>
        <Link className="btn-ghost" to="/admin/audits">← Audits</Link>
      </div>
      {closed && <div className="mb-3 rounded-xl bg-amber-50 border border-amber-200 text-amber-700 px-4 py-2 text-sm">This audit is closed — new entries are disabled.</div>}

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-3 py-3"></th><th className="px-3 py-3">Item</th>
            <th className="px-3 py-3">Counted</th><th className="px-3 py-3 w-64">Add entry</th>
            <th className="px-3 py-3">Location</th><th className="px-3 py-3"></th></tr></thead>
          <tbody className="divide-y">
            {items.map((i) => {
              const r = rowState[i.id] || {};
              return (
                <tr key={i.id}>
                  <td className="px-3 py-2"><PhotoThumb src={i.photo_url} size={40} /></td>
                  <td className="px-3 py-2"><div className="font-medium">{i.name}</div><div className="text-xs text-slate-400">{i.code} · {i.is_liquor ? 'Bottle' : i.unit}</div></td>
                  <td className="px-3 py-2">
                    {i.counted
                      ? <span className="text-green-600 font-semibold">{i.is_liquor ? `${i.total_bottles ?? 0} btl / ${i.total_open_ml ?? 0} ml` : Number(i.total_qty ?? 0)}</span>
                      : <span className="text-slate-300">—</span>}
                    {i.entry_count > 1 && <span className="ml-1 text-xs text-slate-400">({i.entry_count} entries)</span>}
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
                    <button className="btn-primary py-1.5 px-3 text-sm" disabled={closed || savingId === i.id} onClick={() => saveRow(i)}>
                      {savingId === i.id ? '…' : 'Save'}
                    </button>
                    <button className="text-brand font-medium ml-3" onClick={() => setActive(i)}>Details</button>
                  </td>
                </tr>
              );
            })}
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
