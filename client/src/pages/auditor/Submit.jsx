import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { Spinner } from '../../components/ui.jsx';

// M8 — Submit.
//
// Uncounted items do NOT block submission. The item master is shared across all
// stores and any one outlet stocks only a subset of it, so most uncounted items
// are simply not stocked here — requiring a Not Applicable reason for each one
// would be unworkable. Instead the auditor confirms the numbers, and only
// counted items are submitted: nothing is sent as zero.
//
// "Mark N/A" stays available for deliberate use, but is never required.
export default function Submit() {
  const { auditId } = useParams();
  const nav = useNavigate();
  const [uncounted, setUncounted] = useState(null);
  const [summary, setSummary] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get(`/audits/${auditId}/uncounted`).then(setUncounted);
    api.get(`/audits/${auditId}/submit-summary`).then(setSummary);
  }, [auditId]);
  useEffect(() => { load(); }, [load]);

  async function markNA(item) {
    const reason = window.prompt(`Mark "${item.name}" Not Applicable — reason?`);
    if (!reason || !reason.trim()) return;
    await api.post(`/audits/${auditId}/na`, { item_id: item.id, reason: reason.trim() });
    load();
  }

  // Submitting flips the audit to 'submitted', which is what stops the
  // variance report being labelled PROVISIONAL. It creates and deletes nothing.
  async function submitAudit() {
    setErr(''); setBusy(true);
    try {
      const r = await api.post(`/audits/${auditId}/submit`, {});
      if (r.summary) setSummary(r.summary);
      setConfirming(false);
      setDone(true);
    } catch (e) {
      setErr(e.isNetwork ? 'No connection — try again when back online.' : e.message);
      setConfirming(false);
      load();
    } finally { setBusy(false); }
  }

  if (!uncounted || !summary) return <Spinner label="Checking progress…" />;

  if (done) {
    return (
      <div className="min-h-full">
        <MobileHeader title="Submitted" back={`/a/audit/${auditId}`} />
        <div className="p-6 text-center">
          <div className="text-6xl mb-4">✅</div>
          <h2 className="text-xl font-bold mb-2">Count submitted</h2>
          <p className="text-slate-600 mb-6">
            {summary.counted} counted item(s) submitted. The admin will review and close the audit.
          </p>
          <button className="btn-primary w-full" onClick={() => nav(`/a/audit/${auditId}`)}>
            Back to super categories
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full pb-28">
      <MobileHeader title="Review & Submit"
                    subtitle={`${summary.counted} / ${summary.total} counted`}
                    back={`/a/audit/${auditId}`} />
      <div className="p-4">
        <div className="card p-4 mb-4">
          <Line label="items in the master" value={summary.total} />
          <Line label="counted" value={summary.counted} tone="text-green-700" />
          <Line label="not counted" value={summary.uncounted} tone="text-amber-700" />
          {summary.not_applicable > 0 && (
            <Line label="marked Not Applicable" value={summary.not_applicable} tone="text-slate-500" />
          )}
        </div>

        {uncounted.length === 0 ? (
          <div className="card p-5 text-center">
            <div className="text-4xl mb-2">🎉</div>
            <p className="font-semibold">Every item in the master has been counted.</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-600 mb-3">
              These {uncounted.length} item(s) have not been counted. If the store does not stock
              them, leave them — you do not need to mark anything. Use <strong>Mark N/A</strong> only
              when you want to record a reason.
            </p>
            <div className="card divide-y">
              {uncounted.map((i) => (
                <div key={i.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="font-medium">{i.name}</div>
                    <div className="text-xs text-slate-500">{i.unit}</div>
                  </div>
                  <button className="btn-ghost text-sm px-3" onClick={() => markNA(i)}>Mark N/A</button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="fixed bottom-0 inset-x-0 p-3 bg-gradient-to-t from-slate-100 to-transparent">
        {err && <p className="text-red-600 text-sm mb-2 text-center">{err}</p>}
        <button className="btn-primary w-full" disabled={busy} onClick={() => setConfirming(true)}>
          Submit audit count
        </button>
      </div>

      {/* Confirmation — states exactly what is and is not being submitted. */}
      {confirming && (
        <div className="fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-4 bg-black/50"
             onClick={() => !busy && setConfirming(false)}>
          <div className="card w-full max-w-sm p-5" onClick={(e) => e.stopPropagation()}>
            <h3 className="font-bold text-lg mb-3">Submit this count?</h3>
            <div className="mb-3">
              <Line label="items in the master" value={summary.total} />
              <Line label="counted" value={summary.counted} tone="text-green-700" />
              <Line label="not counted" value={summary.uncounted} tone="text-amber-700" />
            </div>
            <p className="text-sm text-slate-600 mb-4">
              Only counted items will be submitted. Items not counted{' '}
              <strong>will not be sent as zero</strong>.
            </p>
            <div className="flex gap-2">
              <button className="btn-ghost flex-1" disabled={busy}
                      onClick={() => setConfirming(false)}>Cancel</button>
              <button className="btn-primary flex-1" disabled={busy} onClick={submitAudit}>
                {busy ? 'Submitting…' : 'Confirm and submit'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Line({ label, value, tone = 'text-slate-800' }) {
  return (
    <div className="flex items-baseline gap-2 py-0.5">
      <span className={`text-xl font-bold tabular-nums ${tone}`}>{value}</span>
      <span className="text-sm text-slate-600">{label}</span>
    </div>
  );
}
