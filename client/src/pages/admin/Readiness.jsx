import { useEffect, useState, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';

// ═══════════════════════════════════════════════════════════════════════════
// (8) System Readiness — the pre-production checklist.
// Check this before the pilot count and before each subsequent count night.
// ═══════════════════════════════════════════════════════════════════════════
export default function Readiness() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    setBusy(true);
    return api.get('/data/readiness').then(setData).finally(() => setBusy(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!data) return <Spinner label="Running checks…" />;

  return (
    <div className="max-w-3xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold">System readiness</h1>
        <button className="btn-ghost" onClick={load} disabled={busy}>
          {busy ? 'Checking…' : 'Re-run checks'}
        </button>
      </div>
      <p className="text-slate-500 mb-4">
        Run this before the pilot count and before each count night. Environment:{' '}
        <span className="font-mono">{data.environment}</span>
      </p>

      <div className={`rounded-xl px-4 py-3 mb-4 font-bold ${
        data.ready ? 'bg-green-50 border-2 border-green-300 text-green-800'
                   : 'bg-amber-50 border-2 border-amber-400 text-amber-900'}`}>
        {data.ready
          ? '✓ All checks passed — ready to count.'
          : `${data.checks.filter((c) => !c.ok).length} check(s) need attention before counting.`}
      </div>

      <div className="card divide-y">
        {data.checks.map((c) => (
          <div key={c.key} className="flex items-start gap-3 px-4 py-3">
            <span className={`text-lg leading-none mt-0.5 ${c.ok ? 'text-green-600' : 'text-red-600'}`}>
              {c.ok ? '✓' : '✗'}
            </span>
            <div className="flex-1 min-w-0">
              <div className="font-medium">{c.label}</div>
              <div className="text-sm text-slate-500">{c.detail}</div>
            </div>
            {c.action === 'delete_demo' && (
              <Link className="btn-ghost text-sm py-1.5 shrink-0" to="/admin/data">
                Delete demo data
              </Link>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
