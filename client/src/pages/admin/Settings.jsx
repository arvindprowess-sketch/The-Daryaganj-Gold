import { useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';

const FIELDS = [
  ['tolerance_general_ok', 'General — OK within (%)', 'Variance at or below this is OK'],
  ['tolerance_general_warn', 'General — Warning within (%)', 'Above OK, up to this = Warning; beyond = Critical'],
  ['tolerance_liquor_ok', 'Liquor — OK within (%)', 'Variance at or below this is OK'],
  ['tolerance_liquor_warn', 'Liquor — Warning within (%)', 'Above OK, up to this = Warning; beyond = Critical'],
];

// D7 — Settings: tolerance thresholds, editable. Variance bands read these.
export default function Settings() {
  const [s, setS] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => { api.get('/settings').then(setS); }, []);

  async function save() {
    setMsg('');
    await api.put('/settings', s);
    setMsg('Saved.');
  }

  if (!s) return <Spinner />;
  return (
    <div className="max-w-xl">
      <h1 className="text-2xl font-bold mb-1">Settings</h1>
      <p className="text-slate-500 mb-6">Tolerance thresholds drive the Variance report status bands (not hardcoded).</p>
      <div className="card p-5 space-y-4">
        {FIELDS.map(([key, label, help]) => (
          <label key={key} className="block">
            <span className="text-sm font-medium text-slate-700">{label}</span>
            <input className="field mt-1 max-w-[160px]" inputMode="decimal"
                   value={s[key] ?? ''} onChange={(e) => setS({ ...s, [key]: e.target.value.replace(/[^0-9.]/g, '') })} />
            <span className="block text-xs text-slate-400 mt-1">{help}</span>
          </label>
        ))}
        <button className="btn-primary" onClick={save}>Save settings</button>
        {msg && <span className="ml-3 text-green-600 text-sm">{msg}</span>}
      </div>
    </div>
  );
}
