import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, downloadReport } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import { useToast } from '../../components/Toast.jsx';
import ImportResult from '../../components/ImportResult.jsx';
import useDebounced from '../../lib/useDebounced.js';
import { fmtDate } from '../../lib/datetime.js';
import { fmtQty } from '../../components/ItemEntry.jsx';

// ═══════════════════════════════════════════════════════════════════════════
// Stock — the warehouse's replacement for the Item Master.
//
//   Article · Description · Batches · Quantity
//
// Each article expands to its batches, each with its own book quantity and
// unit. Below the list, the batch-wise count for an audit puts system and
// physical quantity side by side.
// ═══════════════════════════════════════════════════════════════════════════

// The Quantity column, one figure per unit — batches held in different units
// are never added together into a number in no unit at all.
function QtyCell({ quantities }) {
  if (!quantities?.length) return <span className="text-slate-300">—</span>;
  return (
    <div className="space-y-0.5">
      {quantities.map((q) => (
        <div key={q.unit} className="tabular-nums whitespace-nowrap">
          <span className="font-semibold">{fmtQty(q.qty)}</span>{' '}
          <span className="text-slate-500">{q.unit}</span>
          {q.missing > 0 && (
            <span className="text-xs text-amber-600 ml-1" title="Batches with no quantity are not in this total">
              +{q.missing} without qty
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

const emptyBatch = { batch_no: '', unit: '', qty: '', expiry_date: '' };

export default function Stock() {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [active, setActive] = useState('active');
  const [expanded, setExpanded] = useState({});
  const [articleForm, setArticleForm] = useState(null);   // {id?, name, description, unit}
  const [batchForm, setBatchForm] = useState(null);       // {itemId, id?, ...}
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ active });
    if (debounced.trim()) qs.set('search', debounced.trim());
    return api.get(`/stock?${qs}`).then(setData);
  }, [debounced, active]);
  useEffect(() => { load(); }, [load]);

  async function saveArticle() {
    const f = articleForm;
    if (!f.name.trim()) { toast('Article name is required', 'error'); return; }
    setBusy(true);
    try {
      const payload = { name: f.name, description: f.description, unit: f.unit };
      if (f.id) await api.put(`/items/${f.id}`, payload);
      else await api.post('/items', payload);
      toast(f.id ? 'Article updated' : 'Article added');
      setArticleForm(null);
      await load();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  async function saveBatch() {
    const f = batchForm;
    if (!f.batch_no.trim()) { toast('Batch number is required', 'error'); return; }
    setBusy(true);
    try {
      const payload = { batch_no: f.batch_no, unit: f.unit, qty: f.qty, expiry_date: f.expiry_date };
      if (f.id) await api.put(`/stock/batches/${f.id}`, payload);
      else await api.post(`/stock/${f.itemId}/batches`, payload);
      toast(f.id ? 'Batch updated' : 'Batch added');
      setExpanded((e) => ({ ...e, [f.itemId]: true }));
      setBatchForm(null);
      await load();
    } catch (e) { toast(e.message, 'error'); } finally { setBusy(false); }
  }

  async function removeBatch(b) {
    if (!window.confirm(`Remove batch "${b.batch_no}"? A batch that has been counted is deactivated, not deleted.`)) return;
    try {
      const r = await api.del(`/stock/batches/${b.id}`);
      toast(r.message);
      await load();
    } catch (e) { toast(e.message, 'error'); }
  }

  async function reactivateBatch(b) {
    try {
      await api.put(`/stock/batches/${b.id}`, { is_active: true });
      toast(`Batch "${b.batch_no}" reactivated`);
      await load();
    } catch (e) { toast(e.message, 'error'); }
  }

  if (!data) return <Spinner />;
  const { articles, counts } = data;

  const batchFormRow = (itemId) => batchForm && batchForm.itemId === itemId && (
    <tr className="bg-teal-50/60">
      <td className="px-3 py-2">
        <input className="field py-1.5 px-2" placeholder="Batch no *" autoFocus
               value={batchForm.batch_no} onChange={(e) => setBatchForm({ ...batchForm, batch_no: e.target.value })} />
      </td>
      <td className="px-3 py-2">
        <input className="field py-1.5 px-2" placeholder="Unit (blank = article's)"
               value={batchForm.unit} onChange={(e) => setBatchForm({ ...batchForm, unit: e.target.value })} />
      </td>
      <td className="px-3 py-2">
        <input className="field py-1.5 px-2 w-28" inputMode="decimal" placeholder="Quantity"
               value={batchForm.qty}
               onChange={(e) => setBatchForm({ ...batchForm, qty: e.target.value.replace(/[^0-9.]/g, '') })} />
      </td>
      <td className="px-3 py-2">
        <input className="field py-1.5 px-2" type="date"
               value={batchForm.expiry_date || ''} onChange={(e) => setBatchForm({ ...batchForm, expiry_date: e.target.value })} />
      </td>
      <td className="px-3 py-2 whitespace-nowrap" colSpan={2}>
        <button className="btn-primary py-1.5 px-3 text-sm" disabled={busy} onClick={saveBatch}>Save</button>
        <button className="btn-ghost py-1.5 px-3 text-sm ml-2" onClick={() => setBatchForm(null)}>Cancel</button>
      </td>
    </tr>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Stock</h1>
          <p className="text-slate-500 text-sm">
            {counts.articles} articles · {counts.batches} batches
            {counts.inactive ? ` · ${counts.inactive} inactive articles` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => downloadReport('/stock/import/template', 'stock_template.csv')}>
            CSV template
          </button>
          <button className="btn-primary"
                  onClick={() => setArticleForm({ name: '', description: '', unit: '' })}>+ Add article</button>
        </div>
      </div>

      <StockImport onDone={load} />

      {articleForm && (
        <div className="card p-4 mb-4 grid gap-3 md:grid-cols-4 items-end">
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Article *</span>
            <input className="field mt-1" value={articleForm.name} autoFocus
                   onChange={(e) => setArticleForm({ ...articleForm, name: e.target.value })} />
          </label>
          <label className="block md:col-span-2">
            <span className="text-sm font-medium text-slate-600">Description</span>
            <input className="field mt-1" value={articleForm.description}
                   onChange={(e) => setArticleForm({ ...articleForm, description: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Unit</span>
            <input className="field mt-1" value={articleForm.unit} placeholder="e.g. KG, NOS, BOX (12 PCS)"
                   onChange={(e) => setArticleForm({ ...articleForm, unit: e.target.value })} />
          </label>
          <div className="md:col-span-4 flex gap-2">
            <button className="btn-primary" disabled={busy} onClick={saveArticle}>
              {articleForm.id ? 'Save article' : 'Add article'}
            </button>
            <button className="btn-ghost" onClick={() => setArticleForm(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center mb-3">
        <input className="field py-2.5 md:max-w-sm" placeholder="Search article, description or batch…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        {[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']].map(([k, label]) => (
          <button key={k} className={active === k ? 'chip-on' : 'chip-off'} onClick={() => setActive(k)}>{label}</button>
        ))}
      </div>

      <div className="card overflow-x-auto mb-8">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-3">Article</th>
              <th className="px-3 py-3">Description</th>
              <th className="px-3 py-3">Batches</th>
              <th className="px-3 py-3">Quantity</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {articles.map((a) => {
              const open = !!expanded[a.id];
              return (
                <Fragment key={a.id}>
                  <tr className={a.is_active ? '' : 'opacity-60'}>
                    <td className="px-3 py-2">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-slate-400">{a.unit}{a.is_active ? '' : ' · inactive'}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{a.description || <span className="text-slate-300">—</span>}</td>
                    <td className="px-3 py-2">
                      <button className="text-brand underline" onClick={() => setExpanded((e) => ({ ...e, [a.id]: !open }))}>
                        {a.batch_count} {a.batch_count === 1 ? 'batch' : 'batches'}{open ? ' ▲' : ' ▼'}
                      </button>
                    </td>
                    <td className="px-3 py-2"><QtyCell quantities={a.quantities} /></td>
                    <td className="px-3 py-2 whitespace-nowrap text-right">
                      <button className="text-brand font-medium"
                              onClick={() => { setExpanded((e) => ({ ...e, [a.id]: true }));
                                               setBatchForm({ ...emptyBatch, itemId: a.id }); }}>+ Batch</button>
                      <button className="text-slate-500 font-medium ml-3"
                              onClick={() => setArticleForm({ id: a.id, name: a.name,
                                                              description: a.description || '', unit: a.unit || '' })}>Edit</button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-slate-50">
                      <td colSpan={5} className="px-3 py-3">
                        <table className="w-full text-xs">
                          <thead className="text-slate-500 text-left">
                            <tr>
                              <th className="px-3 py-1">Batch</th><th className="px-3 py-1">Unit</th>
                              <th className="px-3 py-1">Quantity</th><th className="px-3 py-1">Expiry</th>
                              <th className="px-3 py-1">Status</th><th className="px-3 py-1"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {a.batches.map((b) => (
                              batchForm?.id === b.id ? <Fragment key={b.id}>{batchFormRow(a.id)}</Fragment> : (
                                <tr key={b.id} className={b.is_active ? '' : 'text-slate-400'}>
                                  <td className="px-3 py-1.5 font-medium">{b.batch_no}</td>
                                  <td className="px-3 py-1.5">{b.unit}</td>
                                  <td className="px-3 py-1.5 tabular-nums">{b.qty == null ? '—' : fmtQty(b.qty)}</td>
                                  <td className="px-3 py-1.5">{b.expiry_date || '—'}</td>
                                  <td className="px-3 py-1.5">
                                    {b.is_active ? <span className="text-green-600">active</span> : 'inactive'}
                                  </td>
                                  <td className="px-3 py-1.5 text-right whitespace-nowrap">
                                    <button className="text-brand"
                                            onClick={() => setBatchForm({ itemId: a.id, id: b.id, batch_no: b.batch_no,
                                                                          unit: b.own_unit || '', qty: b.qty ?? '',
                                                                          expiry_date: b.expiry_date || '' })}>edit</button>
                                    {b.is_active
                                      ? <button className="text-red-600 ml-3" onClick={() => removeBatch(b)}>remove</button>
                                      : <button className="text-brand ml-3" onClick={() => reactivateBatch(b)}>reactivate</button>}
                                  </td>
                                </tr>
                              )
                            ))}
                            {batchForm && batchForm.itemId === a.id && !batchForm.id && batchFormRow(a.id)}
                            {a.batches.length === 0 && !(batchForm && batchForm.itemId === a.id) && (
                              <tr><td colSpan={6} className="px-3 py-2 text-slate-400">No batches yet.</td></tr>
                            )}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {articles.length === 0 && (
              <tr><td colSpan={5} className="p-8 text-center text-slate-400">No articles match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <BatchCount />
    </div>
  );
}

// ── CSV import ──────────────────────────────────────────────────────────────
function StockImport({ onDone }) {
  const [file, setFile] = useState(null);
  const [mode, setMode] = useState('upsert');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);

  async function run() {
    if (!file) return;
    if (mode === 'replace' && !window.confirm(
      'Replace: every live batch that is NOT in this file will be deactivated. Continue?')) return;
    setBusy(true); setResult(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    try {
      const r = await api.upload('/stock/import', fd);
      setResult({
        tone: 'success',
        title: `Imported ${r.rows} row(s) from ${r.filename}`,
        lines: [
          `Articles: ${r.articles_created} created, ${r.articles_updated} description(s) updated.`,
          `Batches: ${r.batches_created} created, ${r.batches_updated} updated`
            + (r.mode === 'replace' ? `, ${r.batches_deactivated} not in the file deactivated.` : '.'),
        ],
      });
      setFile(null);
      await onDone();
    } catch (e) {
      const invalid = e.body?.invalid || [];
      setResult({
        tone: 'error',
        title: e.message,
        lines: invalid.slice(0, 15).map((x) => `Row ${x.row}${x.article ? ` (${x.article}${x.batch ? ` / ${x.batch}` : ''})` : ''}: ${x.reason}`)
          .concat(invalid.length > 15 ? [`…and ${invalid.length - 15} more.`] : []),
      });
    } finally { setBusy(false); }
  }

  return (
    <div className="card p-4 mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold">Import stock CSV</span>
        <input type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" checked={mode === 'upsert'} onChange={() => setMode('upsert')} /> Add &amp; update
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace (file is the full stock list)
        </label>
        <button className="btn-primary" disabled={!file || busy} onClick={run}>{busy ? 'Importing…' : 'Import'}</button>
      </div>
      <p className="text-xs text-slate-500">
        One row per batch: <code>article, description, batch, unit, quantity, expiry</code>.
        Unit is free text, kept exactly as written; a batch whose unit differs from its article keeps its own.
      </p>
      {result && <ImportResult {...result} onDismiss={() => setResult(null)} />}
    </div>
  );
}

// ── Batch-wise count for an audit ───────────────────────────────────────────
function BatchCount() {
  const [audits, setAudits] = useState([]);
  const [auditId, setAuditId] = useState('');
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [error, setError] = useState('');

  useEffect(() => {
    api.get('/audits').then((list) => {
      setAudits(list);
      if (list[0]) setAuditId(String(list[0].id));
    });
  }, []);
  useEffect(() => {
    if (!auditId) return;
    setData(null); setError('');
    api.get(`/stock/count?audit_id=${auditId}`).then(setData).catch((e) => setError(e.message));
  }, [auditId]);

  const rows = (data?.rows || []).filter((r) => {
    if (filter === 'counted') return r.counted;
    if (filter === 'notcounted') return !r.counted;
    if (filter === 'diff') return r.counted && r.difference !== 0;
    return true;
  });
  const audit = audits.find((a) => String(a.id) === auditId);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-xl font-bold">Batch-wise count</h2>
          <p className="text-slate-500 text-sm">
            System quantity against physical quantity, batch by batch.
            {data && ` Reading the ${data.source === 'submitted' ? 'submitted count' : data.source === 'cleared' ? 'cleared submission (nothing to show)' : 'live count (not yet submitted)'}.`}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select className="field py-2 w-64" value={auditId} onChange={(e) => setAuditId(e.target.value)}>
            {audits.map((a) => (
              <option key={a.id} value={a.id}>{a.store_name} — {fmtDate(a.audit_date)}</option>
            ))}
          </select>
          <button className="btn-ghost" disabled={!auditId}
                  onClick={() => downloadReport(`/stock/count?audit_id=${auditId}&format=csv`,
                                                `batch_count_${audit?.store_code || auditId}.csv`)}>
            Download CSV
          </button>
        </div>
      </div>
      <div className="flex gap-2 mb-3">
        {[['all', 'All'], ['counted', 'Counted'], ['notcounted', 'Not counted'], ['diff', 'With difference']].map(([k, label]) => (
          <button key={k} className={filter === k ? 'chip-on' : 'chip-off'} onClick={() => setFilter(k)}>{label}</button>
        ))}
      </div>
      {error && <p className="text-red-600 text-sm mb-3">{error}</p>}
      {!data && !error && auditId && <Spinner />}
      {data && (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-slate-500">
              <tr>
                <th className="px-3 py-3">Article</th><th className="px-3 py-3">Description</th>
                <th className="px-3 py-3">Batch</th><th className="px-3 py-3">Unit</th>
                <th className="px-3 py-3 text-right">System</th><th className="px-3 py-3 text-right">Physical</th>
                <th className="px-3 py-3 text-right">Difference</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r) => (
                <tr key={`${r.item_id}-${r.batch_id ?? 'none'}`}>
                  <td className="px-3 py-2 font-medium">{r.article}</td>
                  <td className="px-3 py-2 text-slate-600">{r.description || '—'}</td>
                  <td className="px-3 py-2">
                    {r.batch_no || <span className="text-amber-600">(no batch)</span>}
                    {r.batch_id && !r.batch_active && <span className="text-xs text-slate-400"> · inactive</span>}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{r.unit}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.stock_qty == null ? '—' : fmtQty(r.stock_qty)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.counted ? fmtQty(r.physical_qty) : <span className="text-slate-300">not counted</span>}
                    {r.is_liquor && r.counted_open_ml ? <span className="text-xs text-slate-500"> + {r.counted_open_ml} ml</span> : null}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                    r.difference == null ? 'text-slate-300' : r.difference < 0 ? 'text-red-600'
                      : r.difference > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                    {r.difference == null ? '—' : r.difference > 0 ? `+${fmtQty(r.difference)}` : fmtQty(r.difference)}
                  </td>
                </tr>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={7} className="p-8 text-center text-slate-400">Nothing to show.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
