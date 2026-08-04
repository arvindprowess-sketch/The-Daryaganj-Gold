import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';

// D4 — Audit sessions: create (store + date + cut-off), monitor, close.
export default function AuditSessions() {
  const [audits, setAudits] = useState(null);
  const [stores, setStores] = useState([]);
  const [f, setF] = useState({ store_id: '', audit_date: new Date().toISOString().slice(0, 10), cutoff_time: '6:00 PM' });
  const [err, setErr] = useState('');

  const load = useCallback(() => api.get('/audits').then(setAudits), []);
  useEffect(() => { load(); api.get('/stores').then(setStores); }, [load]);

  async function create() {
    setErr('');
    if (!f.store_id) { setErr('Choose a store'); return; }
    try { await api.post('/audits', f); load(); } catch (e) { setErr(e.message); }
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
                <td className="px-4 py-2">{new Date(a.audit_date).toLocaleDateString()}</td>
                <td className="px-4 py-2">{a.cutoff_time || '—'}</td>
                <td className="px-4 py-2">
                  <span className={`chip ${a.status === 'open' ? 'bg-green-100 text-green-700 border-green-200' : 'bg-slate-100 text-slate-500 border-slate-200'}`}>{a.status}</span>
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-3">
                    <Link className="text-brand font-medium" to={`/admin/audits/${a.id}/count`}>Count entry</Link>
                    <Link className="text-brand font-medium" to={`/admin/audits/${a.id}/system-stock`}>System stock</Link>
                    {a.status === 'open' && <button className="text-red-600 font-medium" onClick={() => close(a)}>Close</button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
