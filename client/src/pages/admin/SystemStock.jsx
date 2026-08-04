import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';

// D6 — System stock entry (admin only; never exposed to auditors).
export default function SystemStock() {
  const { auditId } = useParams();
  const [rows, setRows] = useState(null);
  const [audit, setAudit] = useState(null);
  const [paste, setPaste] = useState('');
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const load = useCallback(() => api.get(`/system-stock/${auditId}`).then(setRows), [auditId]);
  useEffect(() => { load(); api.get(`/audits/${auditId}`).then(setAudit); }, [load, auditId]);

  async function submitPaste() {
    setErr(''); setMsg('');
    // Accept "CODE,qty" or "CODE<tab>qty" lines.
    const parsed = paste.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [code, qty] = l.split(/[,\t]/).map((x) => x.trim());
      return { code, qty };
    });
    if (!parsed.length) { setErr('Nothing to import'); return; }
    try {
      const r = await api.post(`/system-stock/${auditId}`, { rows: parsed });
      setMsg(`Imported ${r.count} rows.`); setPaste(''); load();
    } catch (e) { setErr(e.body?.errors ? `${e.message}: ${e.body.errors.map((x) => `row ${x.row} ${x.error}`).join('; ')}` : e.message); }
  }

  async function importCsv(file) {
    setErr(''); setMsg('');
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.upload(`/system-stock/${auditId}`, fd);
      setMsg(`Imported ${r.count} rows.`); load();
    } catch (e) { setErr(e.message); }
  }

  if (!rows) return <Spinner />;
  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">System stock — {audit?.store_name}</h1>
        <Link className="btn-ghost" to="/admin/audits">← Audits</Link>
      </div>
      <div className="rounded-xl bg-slate-100 border border-slate-200 text-slate-600 px-4 py-2 text-sm mb-4">
        System (book) stock is for variance reporting only. It is never sent to auditors.
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="card p-4">
          <h3 className="font-bold mb-2">Paste quantities</h3>
          <p className="text-sm text-slate-500 mb-2">One per line: <code>CODE,qty</code> — e.g. <code>DRY-001,3</code></p>
          <textarea className="field h-40 font-mono text-sm" value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={"DRY-001,3\nLIQ-001,6"} />
          <button className="btn-primary w-full mt-2" onClick={submitPaste}>Import pasted</button>
          <div className="mt-3">
            <span className="text-sm text-slate-600">…or CSV file (columns: code, qty): </span>
            <input type="file" accept=".csv" className="mt-1" onChange={(e) => e.target.files[0] && importCsv(e.target.files[0])} />
          </div>
          {msg && <p className="text-green-600 text-sm mt-2">{msg}</p>}
          {err && <p className="text-red-600 text-sm mt-2">{err}</p>}
        </div>

        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500"><tr>
              <th className="px-4 py-3">Code</th><th className="px-4 py-3">Item</th>
              <th className="px-4 py-3 text-right">System qty</th></tr></thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.item_id}>
                  <td className="px-4 py-2 font-mono">{r.code}</td>
                  <td className="px-4 py-2">{r.name}</td>
                  <td className="px-4 py-2 text-right font-semibold">{Number(r.qty)}</td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={3} className="p-6 text-center text-slate-400">No system stock entered yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
