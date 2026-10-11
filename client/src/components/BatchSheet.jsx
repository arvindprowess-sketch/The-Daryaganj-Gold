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
          <button className="btn-primary w-full" onClick={() => setActive('article')}>
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
                  <div className="font-bold truncate">{b.batch_no}</div>
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
    </BottomSheet>
  );
}
