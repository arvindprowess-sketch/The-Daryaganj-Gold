import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Spinner, ProgressBar, Empty } from '../../components/ui.jsx';

function ago(ts) {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  return `${Math.floor(s / 3600)} h ago`;
}

// D1 — Dashboard: live status of all outlets during a simultaneous count.
export default function Dashboard() {
  const [rows, setRows] = useState(null);

  useEffect(() => {
    const load = () => api.get('/dashboard').then(setRows).catch(() => {});
    load();
    const t = setInterval(load, 10000); // live-ish refresh
    return () => clearInterval(t);
  }, []);

  if (!rows) return <Spinner />;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Live audit dashboard</h1>
      <p className="text-slate-500 mb-6">Auto-refreshes every 10 seconds.</p>
      {rows.length === 0 ? <Empty>No open audits right now.</Empty> : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-4 py-3">Store</th>
                <th className="px-4 py-3">Auditors</th>
                <th className="px-4 py-3 w-64">Progress</th>
                <th className="px-4 py-3">Last entry</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={r.audit_id}>
                  <td className="px-4 py-3 font-semibold">{r.store_name}</td>
                  <td className="px-4 py-3 text-slate-600">{r.auditors || '—'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      <ProgressBar value={r.counted} total={r.total} />
                      <span className="whitespace-nowrap text-slate-600">{r.counted}/{r.total}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{ago(r.last_entry)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
