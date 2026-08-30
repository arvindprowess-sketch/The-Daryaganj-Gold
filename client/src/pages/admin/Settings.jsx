import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import { refreshLocations } from '../../components/LocationSelect.jsx';

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

      <Locations />
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Locations — ONE GLOBAL LIST for every store.
//
// This screen decides what the report looks like: the variance report has one
// column per location, read from here in sort order. Renaming a place renames
// its column and carries every past entry with it, because entries point at
// the id, not the words.
//
// Not per-store on purpose. The same five places exist in every outlet, and
// five copies of the list would mean reports that cannot be compared.
// ═══════════════════════════════════════════════════════════════════════════
// The five the report is built around. Anything else is a leftover.
const STANDARD = ['Kitchen', 'FOH/Bar', 'Store', 'L-4', 'L-17'];

function Locations() {
  const [rows, setRows] = useState(null);
  const [adding, setAdding] = useState('');
  const [err, setErr] = useState('');
  const toast = useToast();

  const load = () => api.get('/meta/locations').then((r) => { setRows(r); refreshLocations(); });
  useEffect(() => { load(); }, []);

  async function add() {
    const name = adding.trim();
    if (!name) return;
    setErr('');
    try { await api.post('/meta/locations', { name }); setAdding(''); await load(); toast(`Added ${name}`); }
    catch (e) { setErr(e.message); }
  }
  async function save(l, patch) {
    setErr('');
    try { await api.put(`/meta/locations/${l.id}`, { ...patch }); await load(); }
    catch (e) { setErr(e.message); }
  }
  async function move(l, dir) {
    const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    const i = ordered.findIndex((x) => x.id === l.id);
    const j = i + dir;
    if (j < 0 || j >= ordered.length) return;
    // Swap the two sort values rather than renumbering the list, so no other
    // row moves as a side effect.
    const a = ordered[i]; const b = ordered[j];
    await api.put(`/meta/locations/${a.id}`, { sort_order: b.sort_order });
    await api.put(`/meta/locations/${b.id}`, { sort_order: a.sort_order });
    await load();
  }
  // A stray that still holds counts cannot be deleted and keeps its report
  // column. Moving its entries to a real location is what actually resolves
  // it — after which the next deploy's cleanup removes it.
  async function reassign(l, toId) {
    if (!toId) return;
    const to = rows.find((x) => String(x.id) === String(toId));
    if (!confirm(`Move all ${l.entry_count} entries from "${l.name}" to "${to.name}"?\n\n`
      + 'Quantities are unchanged — only where they are recorded. This also updates '
      + 'submitted data, so the reports stop showing a column for '
      + `"${l.name}".`)) return;
    setErr('');
    try {
      const r = await api.post(`/meta/locations/${l.id}/reassign`, { to_location_id: to.id });
      await load();
      toast(`Moved ${r.live + r.submitted} entries to ${to.name}`);
    } catch (e) { setErr(e.message); }
  }

  async function remove(l) {
    const msg = l.entry_count > 0
      ? `"${l.name}" has ${l.entry_count} count entries. It will be DEACTIVATED — it stops being offered when counting, and its report column stays for as long as the data does. Continue?`
      : `Delete "${l.name}"? Nothing has ever been counted there.`;
    if (!confirm(msg)) return;
    setErr('');
    try {
      const r = await api.del(`/meta/locations/${l.id}`);
      await load();
      toast(r.softDeleted ? `${l.name} deactivated` : `${l.name} deleted`);
    } catch (e) { setErr(e.message); }
  }

  if (!rows) return <div className="card p-4"><Spinner /></div>;
  const ordered = [...rows].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  return (
    <div className="card p-4">
      <h2 className="font-bold text-lg mb-1">Locations</h2>
      <p className="text-sm text-slate-600 mb-3">
        One global list, used by every store. The variance report shows one column
        per active location, in this order. Auditors choose from this list — they
        cannot type a location.
      </p>

      {rows.some((l) => !STANDARD.includes(l.name)) && (
        <div className="mb-3 rounded-lg border-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          <span className="font-bold">
            {rows.filter((l) => !STANDARD.includes(l.name)).length} location(s) outside the standard five
          </span>{' '}
          — each one the reports still hold data for adds a column. Use
          <em> Move entries to…</em> to put those counts in a real location; once a stray
          holds nothing, the next deploy removes it.
        </div>
      )}

      <div className="divide-y rounded-xl border mb-3">
        {ordered.map((l, i) => (
          <div key={l.id} className={`flex flex-wrap items-center gap-2 px-3 py-2 ${l.is_active ? '' : 'bg-slate-50'}`}>
            <div className="flex flex-col">
              <button className="text-slate-400 hover:text-slate-700 leading-none disabled:opacity-30"
                      disabled={i === 0} onClick={() => move(l, -1)} aria-label="Move up">▲</button>
              <button className="text-slate-400 hover:text-slate-700 leading-none disabled:opacity-30"
                      disabled={i === ordered.length - 1} onClick={() => move(l, 1)} aria-label="Move down">▼</button>
            </div>
            <input className="field py-1.5 px-2 w-52" defaultValue={l.name}
                   onBlur={(e) => e.target.value.trim() !== l.name && save(l, { name: e.target.value.trim() })} />
            <span className="text-xs text-slate-500">
              {l.entry_count} {l.entry_count === 1 ? 'entry' : 'entries'}
            </span>
            {!l.is_active && <span className="chip bg-slate-200 text-slate-600 border-slate-300">inactive</span>}
            <div className="ml-auto flex flex-wrap items-center gap-3">
              {/* Only offered where it is the answer: a location that is not
                  one of the five and still holds entries. */}
              {l.entry_count > 0 && !STANDARD.includes(l.name) && (
                <select className="field py-1 px-2 text-sm w-44" defaultValue=""
                        onChange={(e) => { reassign(l, e.target.value); e.target.value = ''; }}>
                  <option value="">Move entries to…</option>
                  {ordered.filter((x) => x.is_active && x.id !== l.id)
                    .map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
                </select>
              )}
              <button className="text-brand font-medium text-sm"
                      onClick={() => save(l, { is_active: !l.is_active })}>
                {l.is_active ? 'Deactivate' : 'Reactivate'}
              </button>
              <button className="text-red-600 font-medium text-sm" onClick={() => remove(l)}>Delete</button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <input className="field py-1.5 px-2 w-52" placeholder="Add a location…" value={adding}
               onChange={(e) => setAdding(e.target.value)}
               onKeyDown={(e) => e.key === 'Enter' && add()} />
        <button className="btn-ghost" onClick={add}>Add</button>
        {err && <p className="text-red-600 text-sm w-full">{err}</p>}
      </div>
    </div>
  );
}
