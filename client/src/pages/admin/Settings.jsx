import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';

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
    <div className="max-w-3xl">
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

      <LocationZones />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Store Room vs Outlet.
//
// The audit report splits physical quantity into two columns, but auditors
// type the location as free text in the client's own vocabulary ("Dry Store",
// "Bar", "Cold Room"). Guessing which side a name belongs to would quietly
// misstate the report, so the admin assigns them here — including the names
// already recorded on existing entries.
// ═══════════════════════════════════════════════════════════════════════════
function LocationZones() {
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState({ name: '', zone: 'store_room' });
  const [err, setErr] = useState('');
  const toast = useToast();

  const load = useCallback(
    () => api.get('/meta/location-zones').then(setData).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);

  async function add(name, zone) {
    setErr('');
    try {
      await api.post('/meta/location-zones', { name: name.trim(), zone });
      setAdding({ name: '', zone: 'store_room' });
      load();
    } catch (e) { setErr(e.message); }
  }
  async function move(z, zone) {
    await api.put(`/meta/location-zones/${z.id}`, { zone });
    load();
  }
  async function remove(z) {
    await api.del(`/meta/location-zones/${z.id}`);
    load();
  }
  async function setDefault(zone) {
    await api.put('/meta/location-zones/default', { zone });
    toast(`Unmapped locations now count as ${zone === 'store_room' ? 'Store Room' : 'Outlet'}`);
    load();
  }

  if (!data) return null;
  const list = (zone) => data.zones.filter((z) => z.zone === zone);

  return (
    <div className="mt-8">
      <h2 className="text-xl font-bold mb-1">Store Room / Outlet locations</h2>
      <p className="text-slate-500 text-sm mb-4">
        The variance report splits physical quantity into <strong>Store Room</strong> and{' '}
        <strong>Outlet</strong> columns. Assign each location name your auditors use.
      </p>

      {/* Names already typed on entries that have no assignment yet — the
          reason existing data can be mapped correctly rather than defaulted. */}
      {data.unmapped.length > 0 && (
        <div className="mb-4 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3">
          <div className="font-bold text-amber-900 mb-2">
            {data.unmapped.length} location name(s) in use are not assigned
          </div>
          <div className="space-y-2">
            {data.unmapped.map((u) => (
              <div key={u.name} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-mono font-semibold">{u.name}</span>
                <span className="text-amber-800">({u.entries} entries)</span>
                <button className="chip-off" onClick={() => add(u.name, 'store_room')}>→ Store Room</button>
                <button className="chip-off" onClick={() => add(u.name, 'outlet')}>→ Outlet</button>
              </div>
            ))}
          </div>
          <p className="text-xs text-amber-800 mt-2">
            Until assigned, these count as{' '}
            <strong>{data.default_zone === 'store_room' ? 'Store Room' : 'Outlet'}</strong>.
          </p>
        </div>
      )}

      <div className="grid sm:grid-cols-2 gap-4">
        {[['store_room', 'Store Room'], ['outlet', 'Outlet']].map(([zone, label]) => (
          <div key={zone} className="card p-4">
            <h3 className="font-bold mb-2">{label}</h3>
            <div className="space-y-1">
              {list(zone).map((z) => (
                <div key={z.id} className="flex items-center justify-between text-sm py-1 border-b last:border-0">
                  <span>{z.name}</span>
                  <span className="flex gap-3 shrink-0">
                    <button className="text-brand"
                            onClick={() => move(z, zone === 'store_room' ? 'outlet' : 'store_room')}>
                      move
                    </button>
                    <button className="text-red-600" onClick={() => remove(z)}>remove</button>
                  </span>
                </div>
              ))}
              {list(zone).length === 0 && <p className="text-slate-400 text-sm">None.</p>}
            </div>
          </div>
        ))}
      </div>

      <div className="card p-4 mt-4 space-y-3">
        <div className="flex flex-wrap gap-2 items-end">
          <label className="block">
            <span className="text-sm text-slate-600">Add a location</span>
            <input className="field mt-1 max-w-[220px]" value={adding.name}
                   placeholder="e.g. Cold Room"
                   onChange={(e) => setAdding({ ...adding, name: e.target.value })} />
          </label>
          <select className="field max-w-[180px]" value={adding.zone}
                  onChange={(e) => setAdding({ ...adding, zone: e.target.value })}>
            <option value="store_room">Store Room</option>
            <option value="outlet">Outlet</option>
          </select>
          <button className="btn-primary" disabled={!adding.name.trim()}
                  onClick={() => add(adding.name, adding.zone)}>Add</button>
        </div>
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <div className="text-sm">
          <span className="text-slate-600">
            An unrecognised or blank location counts as
            {data.blank_location_entries > 0 && (
              <span className="text-slate-500"> ({data.blank_location_entries} entries have no location)</span>
            )}:
          </span>{' '}
          {[['store_room', 'Store Room'], ['outlet', 'Outlet']].map(([z, l]) => (
            <button key={z} className={`ml-2 ${data.default_zone === z ? 'chip-on' : 'chip-off'}`}
                    onClick={() => setDefault(z)}>{l}</button>
          ))}
        </div>
      </div>
    </div>
  );
}
