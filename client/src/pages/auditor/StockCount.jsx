import { useEffect, useState, useCallback, useMemo, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { Spinner, ProgressBar, VoidMark } from '../../components/ui.jsx';
import BatchSheet from '../../components/BatchSheet.jsx';
import VirtualList from '../../components/VirtualList.jsx';
import useDebounced, { normalizeName } from '../../lib/useDebounced.js';
import { fmtDate } from '../../lib/datetime.js';

// ═══════════════════════════════════════════════════════════════════════════
// Warehouse — the auditor's counting screen. Takes the place of the super
// category cards and item list the cafe uses.
//
//   Search article → select article → its batches (with system stock)
//   → select batch → enter physical quantity and location → save
//
// Search matches the article name AND its description, and every row shows
// both, so two articles with similar names can be told apart before tapping.
// ═══════════════════════════════════════════════════════════════════════════
export default function StockCount() {
  const { auditId } = useParams();
  const nav = useNavigate();
  const [items, setItems] = useState(null);
  const [audit, setAudit] = useState(null);
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounced(search, 250);
  const [active, setActive] = useState(null);
  const scrollRef = useRef(0);

  const load = useCallback(() => api.get(`/audits/${auditId}/items`).then(setItems), [auditId]);
  useEffect(() => { load(); api.get(`/audits/${auditId}`).then(setAudit); }, [load, auditId]);

  function openItem(item) {
    scrollRef.current = window.scrollY;
    setActive(item);
  }
  function closeSheet() {
    setActive(null);
    requestAnimationFrame(() => window.scrollTo(0, scrollRef.current));
  }

  const filtered = useMemo(() => {
    const q = normalizeName(debouncedSearch);
    return (items || []).filter((i) => {
      if (status === 'counted' && !i.counted) return false;
      if (status === 'notcounted' && i.counted) return false;
      if (q && !normalizeName(i.name).includes(q) && !normalizeName(i.description).includes(q)) return false;
      return true;
    });
  }, [items, status, debouncedSearch]);

  if (!items) return <Spinner label="Loading stock…" />;

  const countedTotal = items.filter((i) => i.counted).length;

  const renderRow = (i) => (
    <button onClick={() => openItem(i)}
            className="w-full h-full flex items-center gap-3 px-3 text-left active:bg-slate-50 border-b border-slate-100">
      <div className="flex-1 min-w-0">
        <div className="font-bold truncate">{i.name}</div>
        <div className="text-sm text-slate-600 truncate">{i.description || '—'}</div>
        <div className="text-xs text-slate-400 truncate">
          {i.unit}{' · '}
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
    <div className="min-h-full pb-24">
      <MobileHeader
        title={audit?.store_name || 'Stock count'}
        subtitle={audit ? `${fmtDate(audit.audit_date)} · cut-off ${audit.cutoff_time || '—'}` : ''}
        back={audit ? `/a/store/${audit.store_id}` : '/a'}
      />

      <div className="sticky top-[56px] z-10 bg-slate-100/95 backdrop-blur px-3 pt-3 pb-2 space-y-2">
        <div className="card px-3 py-2">
          <div className="flex items-center justify-between mb-1 text-sm">
            <span className="font-semibold">Articles counted</span>
            <span className="text-slate-500">{countedTotal} / {items.length}</span>
          </div>
          <ProgressBar value={countedTotal} total={items.length} />
        </div>
        <input className="field py-2.5" placeholder="Search article or description…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        <div className="flex gap-2">
          {[['all', 'All'], ['notcounted', 'Not counted'], ['counted', 'Counted']].map(([k, label]) => (
            <button key={k} onClick={() => setStatus(k)}
                    className={`flex-1 ${status === k ? 'chip-on' : 'chip-off'} justify-center`}>{label}</button>
          ))}
        </div>
        {normalizeName(debouncedSearch) && (
          <p className="text-xs text-slate-500">
            {filtered.length} match{filtered.length === 1 ? '' : 'es'}.
          </p>
        )}
      </div>

      <VirtualList items={filtered} rowHeight={80} renderRow={renderRow} emptyMessage="No articles match." />

      {active && (
        <BatchSheet auditId={auditId} item={active} onClose={closeSheet} onSaved={load} />
      )}

      <div className="fixed bottom-0 inset-x-0 p-3 bg-gradient-to-t from-slate-100 to-transparent">
        <button className="btn-primary w-full" onClick={() => nav(`/a/audit/${auditId}/submit`)}>
          Review &amp; Submit
        </button>
      </div>
    </div>
  );
}
