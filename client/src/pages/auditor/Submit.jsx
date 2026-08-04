import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { Spinner } from '../../components/ui.jsx';

// M8 — Submit: lists everything still uncounted. Blocked until each item is
// counted or marked Not Applicable with a reason. Then a summary confirmation.
export default function Submit() {
  const { auditId } = useParams();
  const nav = useNavigate();
  const [uncounted, setUncounted] = useState(null);
  const [sections, setSections] = useState([]);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get(`/audits/${auditId}/uncounted`).then(setUncounted);
    api.get(`/audits/${auditId}/sections`).then(setSections);
  }, [auditId]);
  useEffect(() => { load(); }, [load]);

  async function markNA(item) {
    const reason = window.prompt(`Mark "${item.name}" Not Applicable — reason?`);
    if (!reason || !reason.trim()) return;
    await api.post(`/audits/${auditId}/na`, { item_id: item.id, reason: reason.trim() });
    load();
  }

  // Submitting flips the audit to 'submitted', which is what stops the
  // variance report being labelled PROVISIONAL.
  async function submitAudit() {
    setErr(''); setBusy(true);
    try {
      await api.post(`/audits/${auditId}/submit`, {});
      setDone(true);
    } catch (e) {
      setErr(e.isNetwork ? 'No connection — try again when back online.' : e.message);
      load();
    } finally { setBusy(false); }
  }

  if (!uncounted) return <Spinner label="Checking progress…" />;

  const counted = sections.reduce((s, x) => s + x.counted, 0);
  const total = sections.reduce((s, x) => s + x.total, 0);

  if (done) {
    return (
      <div className="min-h-full">
        <MobileHeader title="Submitted" back={`/a/audit/${auditId}`} />
        <div className="p-6 text-center">
          <div className="text-6xl mb-4">✅</div>
          <h2 className="text-xl font-bold mb-2">Count complete</h2>
          <p className="text-slate-600 mb-6">
            {counted} of {total} items accounted for at this store. The admin will review and close the audit.
          </p>
          <button className="btn-primary w-full" onClick={() => nav(`/a/audit/${auditId}`)}>Back to sections</button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full pb-28">
      <MobileHeader title="Review & Submit" subtitle={`${counted} / ${total} accounted for`} back={`/a/audit/${auditId}`} />
      <div className="p-4">
        {uncounted.length === 0 ? (
          <div className="card p-5 text-center">
            <div className="text-4xl mb-2">🎉</div>
            <p className="font-semibold">Every item is counted or marked Not Applicable.</p>
          </div>
        ) : (
          <>
            <p className="text-sm text-slate-600 mb-3">
              These {uncounted.length} item(s) are still uncounted. Count each one, or mark it Not Applicable with a reason before submitting.
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
        <button className="btn-primary w-full" disabled={uncounted.length > 0 || busy}
                onClick={submitAudit}>
          {uncounted.length > 0
            ? `${uncounted.length} item(s) remaining`
            : busy ? 'Submitting…' : 'Submit audit count'}
        </button>
      </div>
    </div>
  );
}
