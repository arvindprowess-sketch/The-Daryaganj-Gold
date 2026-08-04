import { useEffect, useState, useCallback } from 'react';
import { api, bustCache } from '../../lib/api.js';
import { Spinner, Empty } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';

// Pending Photo Review — an auditor photographed an item that already had a
// master photo. The master is untouched until approved here, so a good photo
// can never be silently overwritten. The count entry keeps its own photo as
// evidence either way.
export default function PhotoReview() {
  const [rows, setRows] = useState(null);
  const [status, setStatus] = useState('pending');
  const [busyId, setBusyId] = useState(null);
  const toast = useToast();

  const load = useCallback(() => {
    return api.get(`/photo-reviews?status=${status}`).then(setRows);
  }, [status]);
  useEffect(() => { load(); }, [load]);

  async function act(row, action) {
    setBusyId(row.id);
    try {
      await api.post(`/photo-reviews/${row.id}/${action}`, {});
      toast(action === 'approve'
        ? `Master photo updated — ${row.item_name}`
        : `Rejected — ${row.item_name} keeps its current photo`);
      await load();
    } catch (e) { toast(e.message, 'error'); } finally { setBusyId(null); }
  }

  if (!rows) return <Spinner />;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Photo review</h1>
      <p className="text-slate-500 mb-4">
        Photos taken during counting for items that already have a master photo. Approving replaces
        the master photo; the original count entry keeps its photo either way.
      </p>

      <div className="flex gap-2 mb-4">
        {[['pending', 'Pending'], ['approved', 'Approved'], ['rejected', 'Rejected']].map(([k, label]) => (
          <button key={k} className={status === k ? 'chip-on' : 'chip-off'} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty>No {status} photo proposals.</Empty>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {rows.map((r) => (
            <div key={r.id} className="card p-4">
              <div className="flex items-start justify-between mb-3">
                <div>
                  <div className="font-bold text-lg">{r.item_name}</div>
                  <div className="text-sm text-slate-500">
                    {r.submitted_by_name} · {new Date(r.submitted_at).toLocaleString()}
                    {r.store_name ? ` · ${r.store_name}` : ''}
                  </div>
                </div>
              </div>

              {/* Side by side: current master vs proposed */}
              <div className="grid grid-cols-2 gap-3">
                <figure>
                  <figcaption className="text-xs uppercase tracking-wide text-slate-400 mb-1">Current master</figcaption>
                  {r.current_url
                    ? <img src={bustCache(r.current_url, r.photo_version)} alt="current master"
                           className="w-full h-44 object-cover rounded-xl border" />
                    : <div className="w-full h-44 rounded-xl border bg-slate-50 flex items-center justify-center text-slate-400 text-sm">none</div>}
                </figure>
                <figure>
                  <figcaption className="text-xs uppercase tracking-wide text-brand mb-1">Proposed</figcaption>
                  <img src={r.proposed_url} alt="proposed"
                       className="w-full h-44 object-cover rounded-xl border-2 border-brand" />
                </figure>
              </div>

              {status === 'pending' && (
                <div className="flex gap-2 mt-4">
                  <button className="btn-ghost flex-1" disabled={busyId === r.id}
                          onClick={() => act(r, 'reject')}>Reject</button>
                  <button className="btn-primary flex-1" disabled={busyId === r.id}
                          onClick={() => act(r, 'approve')}>
                    {busyId === r.id ? '…' : 'Approve — replace master'}
                  </button>
                </div>
              )}
              {status !== 'pending' && r.reviewed_at && (
                <p className="text-xs text-slate-400 mt-3">
                  {status} by {r.reviewed_by_name} · {new Date(r.reviewed_at).toLocaleString()}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
