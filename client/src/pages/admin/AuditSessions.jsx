import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import { fmtDate, fmtDateTime } from '../../lib/datetime.js';
import DangerConfirm from '../../components/DangerConfirm.jsx';
import { StateChip } from '../../components/SubmissionState.jsx';

// D4 — Audit sessions: create (store + date + cut-off), monitor, close.
export default function AuditSessions() {
  const [audits, setAudits] = useState(null);
  const [stores, setStores] = useState([]);
  const [f, setF] = useState({ store_id: '', audit_date: new Date().toISOString().slice(0, 10), cutoff_time: '6:00 PM' });
  const [err, setErr] = useState('');
  // "Clear submitted data" — removes the SNAPSHOT, never the count entries.
  const [clearing, setClearing] = useState(null);   // { audit, preview }
  const [clearErr, setClearErr] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api.get('/audits').then(setAudits), []);
  useEffect(() => { load(); api.get('/stores').then(setStores); }, [load]);

  async function create() {
    setErr('');
    if (!f.store_id) { setErr('Choose a store'); return; }
    try { await api.post('/audits', f); load(); } catch (e) { setErr(e.message); }
  }
  async function askClear(a) {
    setClearErr('');
    try {
      const preview = await api.get(`/audits/${a.id}/clear-submission/preview`);
      setClearing({ audit: a, preview });
    } catch (e) { setErr(e.message); }
  }
  async function doClear() {
    setBusy(true); setClearErr('');
    try {
      await api.post(`/audits/${clearing.audit.id}/clear-submission`,
        { confirm: 'CLEAR SUBMITTED DATA' });
      setClearing(null); load();
    } catch (e) { setClearErr(e.message); } finally { setBusy(false); }
  }
  async function close(a) {
    if (!confirm(`Close audit for ${a.store_name}? Auditors can no longer add entries.`)) return;
    await api.post(`/audits/${a.id}/close`); load();
  }

  if (!audits) return <Spinner />;
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Audit sessions</h1>
      <div className="card p-4 mb-5 flex flex-wrap items-end gap-3">
        <label className="block"><span className="text-sm text-slate-600">Store</span>
          <select className="field mt-1" value={f.store_id} onChange={(e) => setF({ ...f, store_id: e.target.value })}>
            <option value="">Select…</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
        <label className="block"><span className="text-sm text-slate-600">Date</span>
          <input type="date" className="field mt-1" value={f.audit_date} onChange={(e) => setF({ ...f, audit_date: e.target.value })} /></label>
        <label className="block"><span className="text-sm text-slate-600">Cut-off time</span>
          <input className="field mt-1" value={f.cutoff_time} onChange={(e) => setF({ ...f, cutoff_time: e.target.value })} /></label>
        <button className="btn-primary" onClick={create}>Create audit</button>
        {err && <p className="text-red-600 text-sm w-full">{err}</p>}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-4 py-3">Store</th><th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Cut-off</th><th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Actions</th></tr></thead>
          <tbody className="divide-y">
            {audits.map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-2 font-medium">{a.store_name}</td>
                <td className="px-4 py-2">{fmtDate(a.audit_date)}</td>
                <td className="px-4 py-2">{a.cutoff_time || '—'}</td>
                <td className="px-4 py-2">
                  <StateChip state={a.session_state} />
                  {a.status === 'closed' && (
                    <div className="text-[11px] text-slate-500 mt-0.5">audit closed</div>
                  )}
                  {a.session_state === 'submitted' && (
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {a.submission_items} items · {fmtDateTime(a.submission_at)}
                    </div>
                  )}
                  {a.session_state === 'cleared' && (
                    <div className="text-[11px] text-orange-700 mt-0.5">
                      cleared {fmtDateTime(a.cleared_at)}
                      {a.cleared_by_name ? ` by ${a.cleared_by_name}` : ''} — count intact
                    </div>
                  )}
                  {a.session_state === 'counting' && (
                    <div className="text-[11px] text-amber-600 mt-0.5">variance provisional</div>
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-3">
                    <Link className="text-brand font-medium" to={`/admin/audits/${a.id}/count`}>Count entry</Link>
                    <Link className="text-brand font-medium" to={`/admin/audits/${a.id}/system-stock`}>System stock</Link>
                    {a.session_state === 'submitted' && (
                      <button className="text-red-600 font-medium" onClick={() => askClear(a)}>
                        Clear submitted data
                      </button>
                    )}
                    {a.status !== 'closed' && <button className="text-red-600 font-medium" onClick={() => close(a)}>Close</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <DangerConfirm
        open={!!clearing}
        title="Clear submitted data"
        phrase="CLEAR SUBMITTED DATA"
        impact={clearing?.preview?.message}
        warning={"The auditor's count entries, their photos, the item master and system stock are not touched. "
          + 'The audit reopens so the count can be submitted again.'}
        confirmLabel="Clear submitted data"
        busy={busy}
        error={clearErr}
        onCancel={() => setClearing(null)}
        onConfirm={doClear}
      />
    </div>
  );
}
