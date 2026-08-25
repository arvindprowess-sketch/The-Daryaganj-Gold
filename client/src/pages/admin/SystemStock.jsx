import { useEffect, useState, useCallback, useMemo } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api, downloadReport } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { useToast } from '../../components/Toast.jsx';
import ImportResult, { ImportProgress } from '../../components/ImportResult.jsx';
import useDebounced, { normalizeName } from '../../lib/useDebounced.js';
import { fmtDate, fmtDateTime } from '../../lib/datetime.js';

const fmtWhen = (t) => fmtDateTime(t);

// D6 — System stock. ADMIN ONLY; never exposed to the auditor role.
// System figures can be imported, corrected, removed and traced: a wrong file
// against the wrong audit must never silently become a wrong variance report.
export default function SystemStock() {
  const [data, setData] = useState(null);
  const [audit, setAudit] = useState(null);
  const [tab, setTab] = useState('manual');
  const { auditId } = useParams();

  const load = useCallback(() => api.get(`/system-stock/${auditId}`).then(setData), [auditId]);
  useEffect(() => { load(); api.get(`/audits/${auditId}`).then(setAudit); }, [load, auditId]);

  if (!data) return <Spinner />;
  const { rows, source, with_system: filled, master_total: total } = data;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div>
          <h1 className="text-2xl font-bold">System stock — {audit?.store_name}</h1>
          <p className="text-slate-500 text-sm">{filled} of {total} items have a system figure.</p>
        </div>
        <Link className="btn-ghost" to="/admin/audits">← Audits</Link>
      </div>

      <div className="rounded-xl bg-slate-100 border border-slate-200 text-slate-600 px-4 py-2 text-sm mb-4">
        System (book) stock is for variance reporting only. It is never sent to auditors.
      </div>

      {/* Provenance — always visible, so a wrong file is noticeable. */}
      <SourcePanel source={source} filled={filled} total={total}
                   auditId={auditId} onChanged={load} />

      <div className="flex gap-2 my-4">
        {[['manual', 'Figures'], ['csv', 'CSV import'], ['history', 'Import history']].map(([k, label]) => (
          <button key={k} className={tab === k ? 'chip-on' : 'chip-off'} onClick={() => setTab(k)}>{label}</button>
        ))}
      </div>

      {/* The CSV tab stays put after an import so its result banner survives
          until dismissed; `onImported` refreshes the figures behind it. */}
      {tab === 'csv' && <CsvImport auditId={auditId} audit={audit}
                                   onImported={load} onViewFigures={() => setTab('manual')} />}
      {tab === 'history' && <History auditId={auditId} />}
      {tab === 'manual' && <FiguresTable auditId={auditId} rows={rows} onChanged={load} />}
    </div>
  );
}

// ── Where the figures came from, plus the clear-all action ─────────────────
function SourcePanel({ source, filled, total, auditId, onChanged }) {
  const [confirm, setConfirm] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const PHRASE = 'CLEAR SYSTEM STOCK';

  async function clearAll() {
    setBusy(true);
    try {
      const r = await api.post(`/system-stock/${auditId}/clear`, { confirm: typed });
      toast(`Cleared system stock for ${r.removed} item(s)`);
      setConfirm(false); setTyped('');
      onChanged();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  if (filled === 0) {
    return (
      <div className="rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-amber-800">
        <div className="font-bold">No system stock has been imported for this audit.</div>
        <div className="text-sm">The variance report will not run until system figures exist.</div>
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="text-sm">
          <div className="font-bold text-slate-700 mb-1">System stock source</div>
          <div className="text-slate-600">
            {source?.filename
              ? <>File: <span className="font-mono">{source.filename}</span></>
              : 'Entered manually'}
          </div>
          {source && (
            <div className="text-slate-500">
              Imported {fmtWhen(source.imported_at)}
              {source.imported_by_name ? ` by ${source.imported_by_name}` : ''}
            </div>
          )}
          <div className="text-slate-500">Coverage: {filled} of {total} master items</div>
          {source?.override_reason && (
            <div className="mt-1 text-red-600">
              ⚠ Imported with a store-mismatch override — reason: {source.override_reason}
            </div>
          )}
        </div>
        <button className="btn-ghost text-red-600 border-red-200" onClick={() => setConfirm(true)}>
          Clear all system stock
        </button>
      </div>

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="card w-full max-w-lg p-5">
            <h2 className="font-bold text-lg mb-2">Clear all system stock?</h2>
            <p className="text-sm text-slate-700 mb-3">
              This will remove system stock for <strong>{filled} items</strong>
              {source ? <>, imported {fmtWhen(source.imported_at)}
                {source.imported_by_name ? ` by ${source.imported_by_name}` : ''}</> : null}.
            </p>
            <p className="text-sm text-slate-600 mb-3">
              Physical count entries are <strong>not</strong> affected — only the system figures.
            </p>
            <label className="block text-sm text-slate-600 mb-1">
              Type <span className="font-mono font-bold">{PHRASE}</span> to confirm:
            </label>
            <input className="field mb-4 font-mono" value={typed} autoFocus
                   onChange={(e) => setTyped(e.target.value)} />
            <div className="flex gap-2 justify-end">
              <button className="btn-ghost" onClick={() => { setConfirm(false); setTyped(''); }}>Cancel</button>
              <button className="btn-danger" disabled={busy || typed.trim().toUpperCase() !== PHRASE}
                      onClick={clearAll}>{busy ? 'Clearing…' : 'Clear system stock'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline edit + per-row delete ───────────────────────────────────────────
function FiguresTable({ auditId, rows, onChanged }) {
  const [search, setSearch] = useState('');
  const [only, setOnly] = useState('all'); // all | with | without
  const [draft, setDraft] = useState({});
  const [savingId, setSavingId] = useState(null);
  const [confirmDel, setConfirmDel] = useState(null);
  const debounced = useDebounced(search, 250);
  const toast = useToast();

  const filtered = useMemo(() => {
    const q = normalizeName(debounced);
    return rows.filter((r) => {
      if (only === 'with' && !r.has_system) return false;
      if (only === 'without' && r.has_system) return false;
      if (q && !normalizeName(r.name).includes(q)) return false;
      return true;
    });
  }, [rows, debounced, only]);

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
      await onChanged();
      toast(`System stock saved — ${r.name}`);
    } catch (e) { toast(e.message, 'error'); } finally { setSavingId(null); }
  }

  async function removeRow(r) {
    setConfirmDel(null);
    try {
      await api.del(`/system-stock/${auditId}/item/${r.item_id}`);
      await onChanged();
      toast(`Removed system figure — ${r.name}`);
    } catch (e) { toast(e.message, 'error'); }
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 mb-3">
        <input className="field max-w-sm" placeholder="Search item…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        {[['all', 'All'], ['with', 'With system data'], ['without', 'No system data']].map(([k, l]) => (
          <button key={k} className={only === k ? 'chip-on' : 'chip-off'} onClick={() => setOnly(k)}>{l}</button>
        ))}
      </div>
      <p className="text-sm text-slate-500 mb-2">Showing {filtered.length} of {rows.length} items.</p>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-4 py-3">Super Category</th>
            <th className="px-4 py-3">Category</th>
            <th className="px-4 py-3">Item</th>
            <th className="px-4 py-3">Unit</th>
            <th className="px-4 py-3">System quantity</th>
            <th className="px-4 py-3"></th>
          </tr></thead>
          <tbody className="divide-y">
            {filtered.map((r) => {
              const d = draft[r.item_id] || {};
              return (
                <tr key={r.item_id} className={r.has_system ? '' : 'bg-amber-50/40'}>
                  <td className="px-4 py-2 text-slate-500">{r.super_category}</td>
                  <td className="px-4 py-2 text-slate-500">{r.category}</td>
                  <td className="px-4 py-2 font-medium">
                    {r.name}
                    {!r.has_system && <span className="ml-2 text-xs text-amber-600">NO SYSTEM DATA</span>}
                    {r.has_system && r.import_id == null && (
                      <span className="ml-2 text-xs text-sky-600" title={`Edited ${fmtWhen(r.updated_at)}`}>
                        hand-corrected
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{r.unit}</td>
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
                  <td className="px-4 py-2 whitespace-nowrap">
                    <button className="btn-primary py-1.5 px-3 text-sm" disabled={savingId === r.item_id}
                            onClick={() => save(r)}>{savingId === r.item_id ? '…' : 'Save'}</button>
                    {r.has_system && (
                      <button className="text-red-600 font-medium ml-3" onClick={() => setConfirmDel(r)}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-400">No items match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={!!confirmDel}
        title="Remove this system figure?"
        message={confirmDel
          ? `"${confirmDel.name}" will have no system figure and will show as NO SYSTEM DATA on the variance report. The physical count is not affected.`
          : ''}
        confirmLabel="Remove"
        danger
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => removeRow(confirmDel)}
      />
    </>
  );
}

// ── Import history — replaced imports are kept, never deleted ───────────────
function History({ auditId }) {
  const [imports, setImports] = useState(null);
  const [activity, setActivity] = useState([]);
  useEffect(() => {
    api.get(`/system-stock/${auditId}/imports`).then(setImports);
    api.get(`/system-stock/${auditId}/activity`).then(setActivity);
  }, [auditId]);

  if (!imports) return <Spinner />;
  const badge = { active: 'bg-green-100 text-green-700 border-green-200',
                  replaced: 'bg-slate-100 text-slate-500 border-slate-200',
                  cleared: 'bg-red-100 text-red-700 border-red-200' };

  return (
    <div className="space-y-6">
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-4 py-3">File</th><th className="px-4 py-3">Rows</th>
            <th className="px-4 py-3">Matched</th><th className="px-4 py-3">Unmatched</th>
            <th className="px-4 py-3">Imported</th><th className="px-4 py-3">By</th>
            <th className="px-4 py-3">Status</th>
          </tr></thead>
          <tbody className="divide-y">
            {imports.map((i) => (
              <tr key={i.id}>
                <td className="px-4 py-2 font-mono">{i.filename}</td>
                <td className="px-4 py-2">{i.row_count}</td>
                <td className="px-4 py-2 text-green-600">{i.matched_count}</td>
                <td className="px-4 py-2 text-amber-600">{i.unmatched_count}</td>
                <td className="px-4 py-2">{fmtWhen(i.imported_at)}</td>
                <td className="px-4 py-2">{i.imported_by_name || '—'}</td>
                <td className="px-4 py-2"><span className={`chip ${badge[i.status]}`}>{i.status}</span></td>
              </tr>
            ))}
            {imports.length === 0 && (
              <tr><td colSpan={7} className="p-6 text-center text-slate-400">No imports yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div>
        <h3 className="font-bold mb-2">Activity</h3>
        <div className="card divide-y text-sm">
          {activity.map((a) => (
            <div key={a.id} className="px-4 py-2 flex flex-wrap gap-2 justify-between">
              <span>
                <span className="font-semibold uppercase text-xs text-slate-500 mr-2">{a.action}</span>
                {a.detail?.filename && <span className="font-mono">{a.detail.filename} </span>}
                {a.action === 'update' && (
                  <span className="text-slate-600">
                    {JSON.stringify(a.detail?.old)} → {JSON.stringify(a.detail?.new)}
                  </span>
                )}
                {a.action === 'clear' && (
                  <span className="text-slate-600">{a.detail?.removed_rows} row(s) removed</span>
                )}
              </span>
              <span className="text-slate-400">{a.user_name} · {fmtWhen(a.created_at)}</span>
            </div>
          ))}
          {activity.length === 0 && <div className="p-6 text-center text-slate-400">No activity yet.</div>}
        </div>
      </div>
    </div>
  );
}

// ── CSV import: full disclosure + wrong-file guards ────────────────────────
function CsvImport({ auditId, audit, onImported, onViewFigures }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(null);         // null | 'reading' | 'importing'
  // Persistent outcome banner — cleared only by dismissing it or starting over.
  const [result, setResult] = useState(null);
  const [showList, setShowList] = useState(null); // 'unmatched' | 'missing'
  const [ack, setAck] = useState(false);          // extra confirmation for warnings
  const [override, setOverride] = useState({ typed: '', reason: '' });

  // Choosing a file previews it straight away — there is nothing useful the
  // admin could do with the file before seeing what it contains.
  async function pickFile(f) {
    setFile(f); setPreview(null); setResult(null);
    setAck(false); setShowList(null); setOverride({ typed: '', reason: '' });
    if (!f) return;
    setBusy('reading');
    try {
      const fd = new FormData(); fd.append('file', f);
      setPreview(await api.upload(`/system-stock/${auditId}/preview`, fd));
    } catch (e) {
      // The server names the actual reason; show it as given.
      setResult({ tone: 'error', title: e.message, lines: [`File: ${f.name}`] });
    } finally { setBusy(null); }
  }

  async function commit() {
    setResult(null); setBusy('importing');
    const notMatched = preview?.unmatched?.length || 0;
    const noFigure = preview?.missingCount || 0;
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (preview?.blocked) {
        fd.append('override_confirm', override.typed);
        fd.append('override_reason', override.reason);
      }
      const r = await api.upload(`/system-stock/${auditId}/commit`, fd);
      const partial = r.unmatched > 0 || noFigure > 0;
      setResult({
        tone: partial ? 'warning' : 'success',
        title: partial
          ? `Import completed with issues — ${r.imported} rows imported, ${r.unmatched} not matched.`
          : `System stock imported — ${r.imported} rows.`,
        lines: [
          `From ${r.filename} (${r.rowsInFile} rows in file).`,
          r.replacedPrevious
            ? `The previous system stock for this audit was replaced (${r.removed} figures removed).` : null,
          noFigure > 0
            ? `${noFigure} master item(s) had no row in the file and will show as NO SYSTEM DATA on the variance report.` : null,
        ],
        showUnmatched: notMatched > 0,
      });
      // Figures and provenance behind this tab refresh immediately.
      onImported();
    } catch (e) {
      setResult({ tone: 'error', title: e.message, lines: [`File: ${file?.name || '—'}`] });
    } finally { setBusy(null); }
  }

  async function downloadList(which) {
    const fd = new FormData(); fd.append('file', file);
    const blob = await api.uploadBlob(`/system-stock/${auditId}/preview/download?list=${which}`, fd);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `system_stock_${which}.csv`;
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }

  const blocked = preview?.blocked;
  const warnings = preview?.warnings || [];
  const needsAck = warnings.length > 0;
  const overrideOk = !blocked ||
    (override.typed.trim().toUpperCase() === 'IMPORT ANYWAY' && override.reason.trim().length > 0);
  const canCommit = preview && preview.invalidCount === 0 && (!needsAck || ack) && overrideOk && !busy;

  return (
    <div className="card p-5">
      <p className="text-sm text-slate-600 mb-2">
        Accepts the client's own export directly:
        <code> LOC, Super Category Name, Category Name, Item Name, Unit, Closing Qty</code>.
        LOC is ignored for matching; items are matched by <strong>Item Name</strong>
        {' '}(spaces trimmed, case-insensitive).
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <button className="btn-ghost"
                onClick={() => downloadReport('/system-stock/template', 'system_stock_template.csv')}>
          ⬇ Download Template
        </button>
        {/* Disabled while an import runs so the file cannot be swapped or the
            import fired twice. */}
        <input type="file" accept=".csv,text/csv" disabled={!!busy}
               onChange={(e) => pickFile(e.target.files?.[0])} />
        {file && !busy && (
          <button className="btn-ghost text-sm py-1.5" onClick={() => pickFile(file)}>Re-check file</button>
        )}
      </div>

      {busy && (
        <div className="mb-4">
          <ImportProgress filename={file?.name || 'file'}
                          verb={busy === 'reading' ? 'Reading' : 'Importing'} />
        </div>
      )}
      {result && !busy && (
        <div className="mb-4">
          <ImportResult
            tone={result.tone} title={result.title} lines={result.lines}
            onDismiss={() => setResult(null)}
            actions={
              <>
                {result.showUnmatched && (
                  <>
                    <button className="underline font-medium"
                            onClick={() => setShowList(showList === 'unmatched' ? null : 'unmatched')}>
                      {showList === 'unmatched' ? 'Hide' : 'View'} the rows that were not matched
                    </button>
                    <button className="underline font-medium"
                            onClick={() => downloadList('unmatched')}>Download them as CSV</button>
                  </>
                )}
                {result.tone !== 'error' && (
                  <button className="underline font-medium" onClick={onViewFigures}>
                    View the imported figures
                  </button>
                )}
              </>
            } />
        </div>
      )}

      {preview && (
        <div className="space-y-4">
          {/* What is being imported, against what */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm space-y-1">
            <div><span className="text-slate-500">Audit:</span>{' '}
              <strong>{preview.audit.store_name}</strong> — {fmtDate(preview.audit.audit_date)}
              {preview.audit.cutoff_time ? `, cut-off ${preview.audit.cutoff_time}` : ''}
            </div>
            <div><span className="text-slate-500">File:</span> <span className="font-mono">{preview.filename}</span></div>
            <div><span className="text-slate-500">Rows in file:</span> {preview.total}</div>
          </div>

          {/* What will be REPLACED */}
          {preview.willReplace && (
            <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm">
              <div className="font-bold text-amber-900 mb-1">
                ⚠ Importing will REPLACE all existing system stock for this audit.
              </div>
              <div className="text-amber-800">
                Existing: {preview.existing?.rows} items
                {preview.existing?.filename && <> from <span className="font-mono">{preview.existing.filename}</span></>}
                {preview.existing?.imported_at && <> imported {fmtWhen(preview.existing.imported_at)}</>}
                {preview.existing?.imported_by_name && ` by ${preview.existing.imported_by_name}`}
              </div>
            </div>
          )}

          {/* Counts — neither list is ever hidden */}
          <div className="grid sm:grid-cols-3 gap-3 text-sm">
            <Stat label="Matched to master" value={preview.matchedCount} tone="text-green-600" />
            <Stat label="Not matched" value={preview.unmatchedCount} tone="text-amber-600"
                  action={preview.unmatchedCount > 0 && (
                    <>
                      <button className="underline" onClick={() => setShowList(showList === 'unmatched' ? null : 'unmatched')}>view list</button>
                      {' · '}
                      <button className="underline" onClick={() => downloadList('unmatched')}>download</button>
                    </>
                  )} />
            <Stat label="In master, not in file" value={preview.missingCount} tone="text-amber-600"
                  action={preview.missingCount > 0 && (
                    <>
                      <button className="underline" onClick={() => setShowList(showList === 'missing' ? null : 'missing')}>view list</button>
                      {' · '}
                      <button className="underline" onClick={() => downloadList('missing')}>download</button>
                    </>
                  )} />
          </div>

          {showList && (
            <div className="border rounded-xl max-h-60 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0"><tr>
                  <th className="px-2 py-2 text-left">Super Category</th>
                  <th className="px-2 py-2 text-left">Category</th>
                  <th className="px-2 py-2 text-left">Item Name</th>
                </tr></thead>
                <tbody className="divide-y">
                  {(showList === 'unmatched' ? preview.unmatched : preview.missing).map((x, i) => (
                    <tr key={i}>
                      <td className="px-2 py-1.5">{x.super_category || '—'}</td>
                      <td className="px-2 py-1.5">{x.category || '—'}</td>
                      <td className="px-2 py-1.5 font-medium">{x.name}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {preview.invalidCount > 0 && (
            <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700">
              {preview.invalidCount} invalid row(s) — fix them before importing.
              <ul className="list-disc ml-5 mt-1">
                {preview.invalid.slice(0, 8).map((v, i) => <li key={i}>row {v.row}: {v.error}</li>)}
              </ul>
            </div>
          )}

          {/* (3a) Blocking guard — store mismatch */}
          {blocked && (
            <div className="rounded-xl border-2 border-red-500 bg-red-50 p-4 text-sm">
              <div className="font-bold text-red-800 mb-2">⛔ {blocked.message}</div>
              <p className="text-red-700 mb-2">
                Override only if you are certain this file belongs to this audit. The override and
                your reason are recorded.
              </p>
              <label className="block text-xs text-red-800 mb-1">
                Type <span className="font-mono font-bold">IMPORT ANYWAY</span> to override:
              </label>
              <input className="field mb-2 font-mono" value={override.typed}
                     onChange={(e) => setOverride({ ...override, typed: e.target.value })} />
              <label className="block text-xs text-red-800 mb-1">Reason (required):</label>
              <input className="field" value={override.reason} placeholder="Why is this file correct for this audit?"
                     onChange={(e) => setOverride({ ...override, reason: e.target.value })} />
            </div>
          )}

          {/* (3b,c,d) Warnings requiring an extra explicit confirmation */}
          {warnings.length > 0 && (
            <div className="rounded-xl border-2 border-amber-400 bg-amber-50 p-4 text-sm">
              <div className="font-bold text-amber-900 mb-2">Review before continuing</div>
              <ul className="list-disc ml-5 space-y-1 text-amber-800">
                {warnings.map((w) => <li key={w.code}>{w.message}</li>)}
              </ul>
              <label className="flex items-center gap-2 mt-3 font-medium text-amber-900">
                <input type="checkbox" className="h-5 w-5 accent-amber-600"
                       checked={ack} onChange={(e) => setAck(e.target.checked)} />
                I have reviewed the above and this is the correct file for this audit.
              </label>
            </div>
          )}

          <div className="flex gap-2 justify-end">
            <button className="btn-ghost" onClick={() => setPreview(null)}>Cancel</button>
            <button className="btn-primary" disabled={!canCommit} onClick={commit}>
              {busy === 'importing' ? 'Importing…'
                : preview.willReplace ? 'Replace system stock' : 'Import system stock'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone, action }) {
  return (
    <div className="rounded-xl border border-slate-200 p-3">
      <div className="text-slate-500 text-xs">{label}</div>
      <div className={`text-xl font-bold ${tone}`}>{value}</div>
      {action && <div className="text-xs mt-1 text-brand">{action}</div>}
    </div>
  );
}
