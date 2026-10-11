import { useEffect, useState, useCallback } from 'react';
import BottomSheet from './BottomSheet.jsx';
import ItemEntry, { fmtQty } from './ItemEntry.jsx';
import { Spinner, VoidMark } from './ui.jsx';
import { api } from '../lib/api.js';
import { liquorBadge } from '../lib/liquor.js';

// ═══════════════════════════════════════════════════════════════════════════
// Warehouse — every batch of one article.
//
//   Article → [ this sheet: all batches, each with its system stock ]
//           → pick a batch → the entry sheet, recorded against that batch
//
// Saving returns here rather than to the list, so the next batch of the same
// article is one tap away and the one just counted shows its tick.
// ═══════════════════════════════════════════════════════════════════════════
export default function BatchSheet({ auditId, item, onClose, onSaved, uploadOnly = false }) {
  const [batches, setBatches] = useState(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(null);   // a batch, or 'article' when it has none
  const [creating, setCreating] = useState(null); // { batch_no, unit } while the form is open
  const [createError, setCreateError] = useState('');

  const load = useCallback(() => {
    setError('');
    return api.get(`/audits/${auditId}/items/${item.id}/batches`)
      .then(setBatches)
      .catch((e) => setError(e.isNetwork ? 'No connection — could not load the batches.' : e.message));
  }, [auditId, item.id]);
  useEffect(() => { load(); }, [load]);

  async function saved() {
    await load();
    await onSaved?.();
  }

  // Opening a new batch does not write anything yet: the batch is created on
  // the server together with its first count, in one transaction, so there is
  // never an empty batch nobody counted — and never a count without its batch.
  function startNewBatch() {
    setCreateError('');
    const batchNo = String(creating?.batch_no || '').replace(/\s+/g, ' ').trim();
    if (!batchNo) { setCreateError('Enter the batch number.'); return; }
    if (batchNo.length > 64) { setCreateError('Batch number is too long (64 characters at most).'); return; }
    // Typed a batch that is already listed: count that one rather than make a
    // second copy of it.
    const existing = (batches || []).find((b) => b.batch_no.trim().toLowerCase() === batchNo.toLowerCase());
    if (existing) { setCreating(null); setActive(existing); return; }
    const unit = String(creating.unit || '').trim() || item.unit;
    setCreating(null);
    setActive({ id: null, isNew: true, batch_no: batchNo, unit, stock_qty: null, expiry_date: null });
  }

  if (active) {
    return (
      <ItemEntry auditId={auditId} item={item} batch={active === 'article' ? null : active}
                 uploadOnly={uploadOnly}
                 onClose={() => setActive(null)} onSaved={saved} />
    );
  }

  const counted = (b) => item.is_liquor
    ? liquorBadge(b.total_bottles, b.total_open_ml)
    : `${fmtQty(b.total_qty ?? 0)} ${b.unit}`;

  return (
    <BottomSheet open onClose={onClose} title={item.name}>
      <div className="mb-3">
        <div className="font-bold text-lg">{item.name}</div>
        {item.description && <div className="text-sm text-slate-600">{item.description}</div>}
        <div className="text-sm text-slate-500">Unit: {item.unit}</div>
      </div>

      {error && <p className="text-sm text-red-600 mb-3">{error}</p>}
      {batches === null && !error && <Spinner label="Loading batches…" />}

      {batches && batches.length === 0 && (
        <div className="rounded-xl border border-dashed p-4 text-center">
          <p className="text-slate-500 text-sm mb-3">This article has no batches in the stock list.</p>
          <button className="btn-ghost w-full" onClick={() => setActive('article')}>
            Count the article without a batch
          </button>
        </div>
      )}

      {batches && batches.length > 0 && (
        <>
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">
            {batches.length} {batches.length === 1 ? 'batch' : 'batches'} — tap one to count it
          </div>
          <div className="divide-y rounded-xl border">
            {batches.map((b) => (
              <button key={b.id} onClick={() => setActive(b)}
                      className="w-full flex items-center gap-3 px-3 py-3 text-left active:bg-slate-50">
                <div className="flex-1 min-w-0">
                  <div className="font-bold truncate">
                    {b.batch_no}
                    {b.origin === 'counted' && (
                      <span className="ml-1.5 align-middle rounded bg-teal-100 px-1 py-0.5 text-[10px] font-semibold text-teal-800">NEW</span>
                    )}
                  </div>
                  <div className="text-xs text-slate-500">
                    {b.unit}{b.expiry_date ? ` · Exp ${b.expiry_date}` : ''}
                  </div>
                </div>
                <div className="text-right shrink-0 tabular-nums">
                  {/* The book quantity, before anything is typed. */}
                  <div className="text-xs text-slate-400">System</div>
                  <div className="font-semibold">
                    {b.stock_qty === undefined ? '' : b.stock_qty == null ? '—' : `${fmtQty(b.stock_qty)} ${b.unit}`}
                  </div>
                </div>
                <div className="text-right shrink-0 w-24 tabular-nums">
                  <div className="text-xs text-slate-400">Counted</div>
                  {b.counted ? (
                    <div className="flex items-center gap-1 justify-end font-semibold text-green-700">
                      <span>✓</span><span className="truncate">{counted(b)}</span>
                    </div>
                  ) : (
                    <span className="inline-block h-3 w-3 rounded-full bg-slate-300" />
                  )}
                </div>
                <VoidMark count={b.void_count} />
              </button>
            ))}
          </div>
        </>
      )}

      {/* The batch on the shelf is not in the list → create it. */}
      {batches && (creating ? (
        <div className="mt-4 rounded-xl border-2 border-teal-300 bg-teal-50/50 p-3 space-y-3">
          <div className="font-semibold">New batch for {item.name}</div>
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Batch number <span className="text-red-600">*</span></span>
            <input className="field mt-1 text-lg" autoFocus autoCapitalize="characters" autoCorrect="off"
                   value={creating.batch_no}
                   onChange={(e) => setCreating({ ...creating, batch_no: e.target.value })}
                   onKeyDown={(e) => e.key === 'Enter' && startNewBatch()} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Unit</span>
            <input className="field mt-1" placeholder={item.unit || 'Unit'}
                   value={creating.unit}
                   onChange={(e) => setCreating({ ...creating, unit: e.target.value })} />
            <span className="text-xs text-slate-500">Leave blank to use the article's unit ({item.unit || '—'}).</span>
          </label>
          {createError && <p className="text-sm text-red-600">{createError}</p>}
          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => { setCreating(null); setCreateError(''); }}>Cancel</button>
            <button className="btn-primary flex-1" onClick={startNewBatch}>Continue to count</button>
          </div>
        </div>
      ) : (
        <button className="btn-primary w-full mt-4" onClick={() => setCreating({ batch_no: '', unit: '' })}>
          + Create new batch
        </button>
      ))}
    </BottomSheet>
  );
}
