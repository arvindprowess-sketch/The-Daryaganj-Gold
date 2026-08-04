import { useEffect, useState, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, downloadReport } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { useToast } from '../../components/Toast.jsx';

// D6 — System stock entry. ADMIN ONLY; never exposed to the auditor role.
// Gives the Variance report (R4) something to compare against.
export default function SystemStock() {
  const { auditId } = useParams();
  const [rows, setRows] = useState(null);
  const [audit, setAudit] = useState(null);
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('manual');

  const load = useCallback(() => api.get(`/system-stock/${auditId}`).then(setRows), [auditId]);
  useEffect(() => { load(); api.get(`/audits/${auditId}`).then(setAudit); }, [load, auditId]);

  if (!rows) return <Spinner />;
  const filtered = rows.filter((r) => r.name.toLowerCase().includes(search.toLowerCase()));
  const filled = rows.filter((r) => r.has_system).length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">System stock — {audit?.store_name}</h1>
          <p className="text-slate-500 text-sm">{filled} of {rows.length} items have system stock entered.</p>
        </div>
        <Link className="btn-ghost" to="/admin/audits">← Audits</Link>
      </div>
      <div className="rounded-xl bg-slate-100 border border-slate-200 text-slate-600 px-4 py-2 text-sm mb-4">
        System (book) stock is for variance reporting only. It is never sent to auditors.
      </div>

      <div className="flex gap-2 mb-4">
        <button className={tab === 'manual' ? 'chip-on' : 'chip-off'} onClick={() => setTab('manual')}>Manual entry</button>
        <button className={tab === 'csv' ? 'chip-on' : 'chip-off'} onClick={() => setTab('csv')}>CSV import</button>
      </div>

      {tab === 'csv'
        ? <CsvImport auditId={auditId} onDone={() => { load(); setTab('manual'); }} />
        : (
          <>
            <input className="field max-w-sm mb-3" placeholder="Search item…"
                   value={search} onChange={(e) => setSearch(e.target.value)} />
            <ManualTable auditId={auditId} rows={filtered} onSaved={load} />
          </>
        )}
    </div>
  );
}

// Inline editable table: item name + system quantity. Liquor keeps bottles and
// open ml separate, exactly as the physical count does.
function ManualTable({ auditId, rows, onSaved }) {
  const [draft, setDraft] = useState({});
  const [savingId, setSavingId] = useState(null);
  const toast = useToast();

  function set(id, patch) { setDraft((d) => ({ ...d, [id]: { ...d[id], ...patch } })); }

  async function save(r) {
    const d = draft[r.item_id] || {};
    const payload = r.is_liquor
      ? { bottles: d.bottles ?? r.bottles ?? '', open_ml: d.open_ml ?? r.open_ml ?? '' }
      : { qty: d.qty ?? r.qty ?? '' };
    setSavingId(r.item_id);
    try {
      await api.put(`/system-stock/${auditId}/item/${r.item_id}`, payload);
      setDraft((x) => ({ ...x, [r.item_id]: {} }));
      await onSaved();
      toast(`System stock saved — ${r.name}`);
    } catch (e) { toast(e.message, 'error'); } finally { setSavingId(null); }
  }

  return (
    <div className="card overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-slate-500"><tr>
          <th className="px-4 py-3">Item</th>
          <th className="px-4 py-3">Type</th>
          <th className="px-4 py-3">System quantity</th>
          <th className="px-4 py-3"></th>
        </tr></thead>
        <tbody className="divide-y">
          {rows.map((r) => {
            const d = draft[r.item_id] || {};
            return (
              <tr key={r.item_id} className={r.has_system ? '' : 'bg-amber-50/40'}>
                <td className="px-4 py-2 font-medium">{r.name}</td>
                <td className="px-4 py-2 text-slate-500">{r.is_liquor ? `Bottle ${r.bottle_size_ml || ''}ml` : r.unit}</td>
                <td className="px-4 py-2">
                  {r.is_liquor ? (
                    <div className="flex gap-2">
                      <input className="field py-1.5 px-2 w-24" placeholder="bottles"
                             value={d.bottles ?? (r.bottles ?? '')}
                             onChange={(e) => set(r.item_id, { bottles: e.target.value.replace(/[^0-9]/g, '') })}
                             onKeyDown={(e) => e.key === 'Enter' && save(r)} />
                      <input className="field py-1.5 px-2 w-24" placeholder="open ml"
                             value={d.open_ml ?? (r.open_ml ?? '')}
                             onChange={(e) => set(r.item_id, { open_ml: e.target.value.replace(/[^0-9]/g, '') })}
                             onKeyDown={(e) => e.key === 'Enter' && save(r)} />
                    </div>
                  ) : (
                    <input className="field py-1.5 px-2 w-32" placeholder="qty"
                           value={d.qty ?? (r.qty ?? '')}
                           onChange={(e) => set(r.item_id, { qty: e.target.value.replace(/[^0-9.]/g, '') })}
                           onKeyDown={(e) => e.key === 'Enter' && save(r)} />
                  )}
                </td>
                <td className="px-4 py-2">
                  <button className="btn-primary py-1.5 px-3 text-sm" disabled={savingId === r.item_id}
                          onClick={() => save(r)}>{savingId === r.item_id ? '…' : 'Save'}</button>
                </td>
              </tr>
            );
          })}
          {rows.length === 0 && <tr><td colSpan={4} className="p-6 text-center text-slate-400">No items match.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// CSV import with template download, preview (matched / unmatched counts) and a
// confirmation because a re-import REPLACES existing system stock.
function CsvImport({ auditId, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [confirm, setConfirm] = useState(false);
  const toast = useToast();

  async function doPreview() {
    setErr(''); setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      setPreview(await api.upload(`/system-stock/${auditId}/preview`, fd));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function commit() {
    setConfirm(false); setErr(''); setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.upload(`/system-stock/${auditId}/commit`, fd);
      toast(`Imported ${r.imported} rows (previous system stock replaced)`);
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <div className="card p-5">
      <p className="text-sm text-slate-600 mb-2">
        One combined template for both item types — leave the liquor columns blank on non-liquor rows.
        Columns: <code>item_name, system_qty, system_bottles, system_open_ml</code>.
        Items are matched by <strong>name</strong> (trimmed, case-insensitive).
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className="btn-ghost"
                onClick={() => downloadReport(`/system-stock/template`, 'system_stock_template.csv')}>
          ⬇ Download Template
        </button>
        <input type="file" accept=".csv,text/csv"
               onChange={(e) => { setFile(e.target.files?.[0]); setPreview(null); }} />
      </div>
      <div className="flex gap-2">
        <button className="btn-ghost" disabled={!file || busy} onClick={doPreview}>Preview</button>
        <button className="btn-primary" disabled={!preview || preview.invalidCount > 0 || busy}
                onClick={() => setConfirm(true)}>
          Import{preview ? ` (${preview.matchedCount} items)` : ''}
        </button>
      </div>
      {err && <p className="text-red-600 text-sm mt-3">{err}</p>}

      {preview && (
        <div className="mt-4">
          <p className="text-sm mb-2">
            {preview.total} rows · <span className="text-green-600">{preview.matchedCount} matched</span> ·{' '}
            <span className="text-amber-600">{preview.unmatchedCount} unmatched</span> ·{' '}
            <span className="text-red-600">{preview.invalidCount} invalid</span>
          </p>
          {preview.unmatchedCount > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 mb-3">
              <p className="text-sm font-semibold text-amber-800 mb-1">
                These names don't match any item and will NOT be imported:
              </p>
              <ul className="text-sm text-amber-900 list-disc pl-5 max-h-40 overflow-y-auto">
                {preview.unmatched.map((u) => <li key={u.row}>row {u.row}: {u.name}</li>)}
              </ul>
            </div>
          )}
          {preview.invalidCount > 0 && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-3">
              <p className="text-sm font-semibold text-red-800 mb-1">Invalid rows — fix before importing:</p>
              <ul className="text-sm text-red-900 list-disc pl-5 max-h-40 overflow-y-auto">
                {preview.invalid.map((u) => <li key={u.row}>row {u.row} ({u.name}): {u.error}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirm}
        title="Replace system stock?"
        message={preview?.existingCount
          ? `This audit already has system stock for ${preview.existingCount} item(s). Importing REPLACES all of it with the ${preview.matchedCount} matched row(s) from this file.`
          : `Import ${preview?.matchedCount || 0} matched row(s) as the system stock for this audit?`}
        confirmLabel="Replace and import"
        danger
        onCancel={() => setConfirm(false)}
        onConfirm={commit}
      />
    </div>
  );
}
