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
  const [onlyNew, setOnlyNew] = useState(false);
  // Article-wise (one row per article, batches folded under it) or
  // batch-wise (one row per batch, the article repeated on each) — the second
  // reads like the stock sheet itself.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('audix_stock_view') || 'batch'; } catch { return 'batch'; }
  });
  const chooseView = (v) => { setView(v); try { localStorage.setItem('audix_stock_view', v); } catch { /* */ } };
  const [expanded, setExpanded] = useState({});
  const [articleForm, setArticleForm] = useState(null);   // {id?, name, description, unit}
  const [batchForm, setBatchForm] = useState(null);       // {itemId, id?, ...}
  const [busy, setBusy] = useState(false);
  // Super categories and categories are the same admin-managed lists the cafe
  // uses. An article's category is what the counter taps on the phone.
  const [supers, setSupers] = useState([]);
  const [cats, setCats] = useState([]);
  const [superFilter, setSuperFilter] = useState('');
  const loadHierarchy = useCallback(() => Promise.all([
    api.get('/meta/super-categories').then(setSupers),
    api.get('/meta/categories').then(setCats),
  ]), []);
  useEffect(() => { loadHierarchy(); }, [loadHierarchy]);

  const load = useCallback(() => {
    const qs = new URLSearchParams({ active });
    if (onlyNew) qs.set('origin', 'counted');
    if (superFilter) qs.set('super_category_id', superFilter);
    if (debounced.trim()) qs.set('search', debounced.trim());
    return api.get(`/stock?${qs}`).then(setData);
  }, [debounced, active, onlyNew, superFilter]);
  useEffect(() => { load(); }, [load]);

  async function saveArticle() {
    const f = articleForm;
    if (!f.name.trim()) { toast('Article name is required', 'error'); return; }
    setBusy(true);
    try {
      const payload = { name: f.name, description: f.description, unit: f.unit,
                        super_category_id: f.super_category_id || null,
                        category_id: f.category_id || null,
                        inventory_mode: 'warehouse' };
      if (f.id) {
        await api.put(`/items/${f.id}`, payload);
        toast('Article updated');
      } else {
        const created = await api.post('/items', payload);
        // The first batch can be entered with the article, so a new article
        // is never left without the batch it was added for.
        if (String(f.batch_no || '').trim()) {
          await api.post(`/stock/${created.id}/batches`,
            { batch_no: f.batch_no, qty: f.qty, expiry_date: f.expiry_date, unit: '' });
          toast(`Article added with batch ${f.batch_no.trim()}`);
        } else {
          toast('Article added');
        }
      }
      setArticleForm(null);
      await load();
    } catch (e) {
      // The article is already there: show it, so the batch goes onto it.
      if (e.code === 'name_exists') { setSearch(f.name.trim()); setArticleForm(null); }
      toast(e.message, 'error', 5000);
    } finally { setBusy(false); }
  }

  // A super category or category that does not exist yet is created here, so
  // the admin never has to leave the article form.
  async function newSuper() {
    const name = window.prompt('New super category name (e.g. RAW MATERIAL)');
    if (!name || !name.trim()) return;
    try {
      const r = await api.post('/meta/super-categories', { name: name.trim() });
      await loadHierarchy();
      setArticleForm((f) => ({ ...f, super_category_id: String(r.id), category_id: '' }));
    } catch (e) { toast(e.message, 'error'); }
  }
  async function newCategory() {
    if (!articleForm?.super_category_id) { toast('Choose the super category first', 'error'); return; }
    const name = window.prompt('New category name');
    if (!name || !name.trim()) return;
    try {
      const r = await api.post('/meta/categories', { name: name.trim(), super_category_id: Number(articleForm.super_category_id) });
      await loadHierarchy();
      setArticleForm((f) => ({ ...f, category_id: String(r.id) }));
    } catch (e) { toast(e.message, 'error'); }
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
            {counts.new_batches ? ` · ${counts.new_batches} created during counting` : ''}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => downloadReport('/stock/import/template', 'stock_template.csv')}>
            CSV template
          </button>
          <button className="btn-primary"
                  onClick={() => setArticleForm({ name: '', description: '', unit: '', super_category_id: '', category_id: '' })}>+ Add material</button>
        </div>
      </div>

      <StockImport onDone={load} />

      {articleForm && (
        <div className="card p-4 mb-4 grid gap-3 md:grid-cols-4 items-end">
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Material *</span>
            <input className="field mt-1" value={articleForm.name} autoFocus
                   onChange={(e) => setArticleForm({ ...articleForm, name: e.target.value })} />
          </label>
          <label className="block md:col-span-2">
            <span className="text-sm font-medium text-slate-600">Material Description</span>
            <input className="field mt-1" value={articleForm.description}
                   onChange={(e) => setArticleForm({ ...articleForm, description: e.target.value })} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Unit</span>
            <input className="field mt-1" value={articleForm.unit} placeholder="e.g. KG, NOS, BOX (12 PCS)"
                   onChange={(e) => setArticleForm({ ...articleForm, unit: e.target.value })} />
          </label>
          <label className="block md:col-span-2">
            <span className="text-sm font-medium text-slate-600">
              Super category <button type="button" className="text-brand text-xs ml-1" onClick={newSuper}>+ new</button>
            </span>
            <select className="field mt-1" value={articleForm.super_category_id || ''}
                    onChange={(e) => setArticleForm({ ...articleForm, super_category_id: e.target.value, category_id: '' })}>
              <option value="">— none —</option>
              {supers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
            </select>
          </label>
          <label className="block md:col-span-2">
            <span className="text-sm font-medium text-slate-600">
              Brand <button type="button" className="text-brand text-xs ml-1" onClick={newCategory}>+ new</button>
            </span>
            <select className="field mt-1" value={articleForm.category_id || ''}
                    disabled={!articleForm.super_category_id}
                    onChange={(e) => setArticleForm({ ...articleForm, category_id: e.target.value })}>
              <option value="">— none —</option>
              {cats.filter((c) => String(c.super_category_id) === String(articleForm.super_category_id))
                .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
          {!articleForm.id && (
            <div className="md:col-span-4 grid gap-3 md:grid-cols-4 rounded-xl bg-teal-50/60 border border-teal-200 p-3">
              <div className="md:col-span-4 text-sm font-semibold text-teal-800">
                First batch <span className="font-normal text-slate-500">(optional — more batches with "+ Batch" on the article's row)</span>
              </div>
              <label className="block">
                <span className="text-sm font-medium text-slate-600">Batch no</span>
                <input className="field mt-1" value={articleForm.batch_no || ''}
                       onChange={(e) => setArticleForm({ ...articleForm, batch_no: e.target.value })} />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-600">Stock</span>
                <input className="field mt-1" inputMode="decimal" value={articleForm.qty || ''}
                       onChange={(e) => setArticleForm({ ...articleForm, qty: e.target.value.replace(/[^0-9.]/g, '') })} />
              </label>
              <label className="block">
                <span className="text-sm font-medium text-slate-600">Expiry</span>
                <input className="field mt-1" type="date" value={articleForm.expiry_date || ''}
                       onChange={(e) => setArticleForm({ ...articleForm, expiry_date: e.target.value })} />
              </label>
            </div>
          )}
          <div className="md:col-span-4 flex gap-2">
            <button className="btn-primary" disabled={busy} onClick={saveArticle}>
              {articleForm.id ? 'Save material' : 'Add material'}
            </button>
            <button className="btn-ghost" onClick={() => setArticleForm(null)}>Cancel</button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 items-center mb-3">
        <input className="field py-2.5 md:max-w-sm" placeholder="Search material, description or batch…"
               value={search} onChange={(e) => setSearch(e.target.value)} />
        {[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']].map(([k, label]) => (
          <button key={k} className={active === k ? 'chip-on' : 'chip-off'} onClick={() => setActive(k)}>{label}</button>
        ))}
        <button className={onlyNew ? 'chip-on' : 'chip-off'} onClick={() => setOnlyNew(!onlyNew)}>
          New batches from counting ({counts.new_batches || 0})
        </button>
      </div>
      <div className="flex gap-2 overflow-x-auto no-scrollbar mb-3">
        <button className={superFilter === '' ? 'chip-on' : 'chip-off'} onClick={() => setSuperFilter('')}>All categories</button>
        {supers.map((x) => (
          <button key={x.id} className={String(superFilter) === String(x.id) ? 'chip-on' : 'chip-off'}
                  onClick={() => setSuperFilter(String(x.id))}>{x.name}</button>
        ))}
        <button className={superFilter === 'none' ? 'chip-on' : 'chip-off'} onClick={() => setSuperFilter('none')}>Uncategorised</button>
      </div>
      <div className="flex items-center gap-2 mb-3 text-sm">
        <span className="text-slate-500">View:</span>
        <button className={view === 'batch' ? 'chip-on' : 'chip-off'} onClick={() => chooseView('batch')}>One row per batch</button>
        <button className={view === 'article' ? 'chip-on' : 'chip-off'} onClick={() => chooseView('article')}>One row per article</button>
      </div>

      {view === 'batch' && <BatchRows articles={articles} />}

      <div className={`card overflow-x-auto mb-8 ${view === 'batch' ? 'hidden' : ''}`}>
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-3">Super category · Brand</th>
              <th className="px-3 py-3">Material</th>
              <th className="px-3 py-3">Material Description</th>
              <th className="px-3 py-3">Batches</th>
              <th className="px-3 py-3">Stock</th>
              <th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {articles.map((a) => {
              const open = !!expanded[a.id];
              return (
                <Fragment key={a.id}>
                  <tr className={a.is_active ? '' : 'opacity-60'}>
                    <td className="px-3 py-2 whitespace-nowrap">
                      {a.super_category_name
                        ? <><div className="text-slate-700">{a.super_category_name}</div>
                            <div className="text-xs text-slate-400">{a.category_name || '—'}</div></>
                        : <span className="text-xs text-amber-600">Uncategorised</span>}
                    </td>
                    <td className="px-3 py-2">
                      <div className="font-medium">{a.name}</div>
                      <div className="text-xs text-slate-400">
                        {a.unit}{a.is_active ? '' : ' · inactive'}
                      </div>
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
                                                              description: a.description || '', unit: a.unit || '',
                                                              super_category_id: a.super_category_id ? String(a.super_category_id) : '',
                                                              category_id: a.category_id ? String(a.category_id) : '' })}>Edit</button>
                    </td>
                  </tr>
                  {open && (
                    <tr className="bg-slate-50">
                      <td colSpan={6} className="px-3 py-3">
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
                                  <td className="px-3 py-1.5 font-medium">
                                    {b.batch_no}
                                    {b.origin === 'counted' && (
                                      <span className="ml-1.5 rounded bg-teal-100 px-1 py-0.5 text-[10px] font-semibold text-teal-800"
                                            title={`Created during counting${b.created_by_name ? ` by ${b.created_by_name}` : ''}${b.created_in_audit_label ? ` — ${b.created_in_audit_label}` : ''}`}>
                                        NEW
                                      </span>
                                    )}
                                    {b.origin === 'counted' && (
                                      <div className="text-[11px] text-slate-500 font-normal">
                                        by {b.created_by_name || 'a counter'}{b.created_in_audit_label ? ` · ${b.created_in_audit_label}` : ''}
                                      </div>
                                    )}
                                  </td>
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
              <tr><td colSpan={6} className="p-8 text-center text-slate-400">No articles match.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <BatchCount />
    </div>
  );
}

// ── Batch-wise view ─────────────────────────────────────────────────────────
// Every batch on its own line, the article (and its category and description)
// repeated on each — the same shape as the stock sheet that was imported. An
// article with no batch yet still gets a line, so nothing looks missing.
function BatchRows({ articles }) {
  const rows = articles.flatMap((a) => (a.batches.length
    ? a.batches.map((b) => ({ a, b }))
    : [{ a, b: null }]));
  const total = rows.filter((r) => r.b).length;
  return (
    <div className="card overflow-x-auto mb-8">
      <div className="px-3 py-2 text-xs text-slate-500 border-b">
        {total} batch line(s) across {articles.length} article(s)
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-slate-500">
          <tr>
            <th className="px-3 py-3">Super category · Brand</th><th className="px-3 py-3">Material</th>
            <th className="px-3 py-3">Material Description</th><th className="px-3 py-3">Batch</th>
            <th className="px-3 py-3">Unit</th><th className="px-3 py-3 text-right">Stock</th>
            <th className="px-3 py-3">Expiry</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map(({ a, b }) => (
            <tr key={b ? `b${b.id}` : `a${a.id}`} className={!b || b.is_active ? '' : 'text-slate-400'}>
              <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                {a.super_category_name || <span className="text-amber-600 text-xs">Uncategorised</span>}
                {a.category_name && <span className="text-xs text-slate-400"> › {a.category_name}</span>}
              </td>
              <td className="px-3 py-2 font-medium">{a.name}</td>
              <td className="px-3 py-2 text-slate-600">{a.description || '—'}</td>
              <td className="px-3 py-2">
                {b ? b.batch_no : <span className="text-slate-400 text-xs">no batch yet</span>}
                {b?.origin === 'counted' && (
                  <span className="ml-1.5 rounded bg-teal-100 px-1 py-0.5 text-[10px] font-semibold text-teal-800">NEW</span>
                )}
                {b && !b.is_active && <span className="text-xs"> · inactive</span>}
              </td>
              <td className="px-3 py-2 text-slate-500">{b ? b.unit : a.unit}</td>
              <td className="px-3 py-2 text-right tabular-nums">{b && b.qty != null ? fmtQty(b.qty) : '—'}</td>
              <td className="px-3 py-2">{b?.expiry_date || '—'}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={7} className="p-8 text-center text-slate-400">No articles match.</td></tr>
          )}
        </tbody>
      </table>
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
      'Replace: this file becomes the whole stock list. Materials and batches NOT in it are removed. '
      + 'Any that were already counted in an audit are hidden instead (kept so that audit\'s report stays correct). '
      + 'Batches created during counting are kept. Continue?')) return;
    setBusy(true); setResult(null);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('mode', mode);
    try {
      const r = await api.upload('/stock/import', fd);
      setResult({
        tone: 'success',
        title: `Imported ${r.lines ?? r.rows} line(s) from ${r.filename} — ${r.rows} batch(es)`,
        lines: [
          // The same material + batch on several lines is one batch, its
          // Stock added — said out loud so the total is not a surprise.
          r.merged_lines
            ? `${r.merged_lines} repeated line(s) of the same material + batch merged into ${r.merged_batches} batch(es) — their Stock was added together.`
            : null,
          `Articles: ${r.articles_created} created, ${r.articles_updated} updated`
            + (r.categories_created ? ` · ${r.categories_created} new categor${r.categories_created === 1 ? 'y' : 'ies'}.` : '.'),
          `Batches: ${r.batches_created} created, ${r.batches_updated} updated.`,
          r.articles_reactivated ? `${r.articles_reactivated} material(s) that had been removed are back in stock.` : null,
          r.mode === 'replace'
            ? `Not in the file: ${r.articles_deleted} material(s) and ${r.batches_deleted} batch(es) removed`
              + (r.articles_hidden || r.batches_hidden
                ? `; ${r.articles_hidden} material(s) and ${r.batches_hidden} batch(es) already counted in an audit — hidden, kept for that audit's report.`
                : '.')
            : null,
        ],
      });
      setFile(null);
      await onDone();
    } catch (e) {
      // The connection dropped or timed out while a big file was importing.
      // The import may well have finished on the server — importing again
      // blindly is how the same file got imported twice at once.
      if (e.isNetwork) {
        setResult({
          tone: 'warning',
          title: 'No reply from the server — the import may still be running or may already be done.',
          lines: ['Wait a minute, then refresh this page and check the stock list (article and batch counts at the top) before importing again.'],
        });
        await onDone().catch(() => {});
        return;
      }
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
        <span className="font-semibold">Import stock (Excel / CSV)</span>
        <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" checked={mode === 'upsert'} onChange={() => setMode('upsert')} /> Add &amp; update
        </label>
        <label className="flex items-center gap-1 text-sm">
          <input type="radio" checked={mode === 'replace'} onChange={() => setMode('replace')} /> Replace (file is the full stock list)
        </label>
        <button className="btn-primary" disabled={!file || busy} onClick={run}>{busy ? 'Importing…' : 'Import'}</button>
      </div>
      <p className="text-xs text-slate-500">
        Excel (.xlsx) or CSV, one row per batch: <code>Super category, Brand, Material, Material Description, Batch, Stock</code>
        (optional: Unit, Expiry). The same Material + Batch on several lines (one per rack or bin) is one batch — its Stock is added up. The <strong>Material</strong> identifies the item — every batch row of it carries the same Material.
        A super category or category that does not exist yet is created.
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

  // One line per batch AND location — a batch found in three places is three
  // lines, never "G2 · F2 · C3" in one cell. A filter keeps or drops whole
  // batches, so a batch's lines always stay together.
  const lines = data?.lines || [];
  const keepBatch = new Set(lines.filter((l) => {
    if (filter === 'counted') return l.counted;
    if (filter === 'notcounted') return !l.counted;
    if (filter === 'diff') return l.first_of_batch && l.difference != null && l.difference !== 0;
    if (filter === 'new') return l.is_new;
    return true;
  }).map((l) => `${l.item_id}:${l.batch_id ?? '-'}`));
  const rows = lines.filter((l) => keepBatch.has(`${l.item_id}:${l.batch_id ?? '-'}`));
  const audit = audits.find((a) => String(a.id) === auditId);

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
        <div>
          <h2 className="text-xl font-bold">Batch-wise count</h2>
          <p className="text-slate-500 text-sm">
            System quantity against physical quantity, batch by batch.
            {data && (data.source === 'live'
              ? ' Live — every auditor\'s entries as they stand now; submitting is not needed.'
              : ` Reading the ${data.source === 'submitted' ? 'submitted count' : 'cleared submission (nothing to show)'}.`)}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select className="field py-2 w-64" value={auditId} onChange={(e) => setAuditId(e.target.value)}>
            {audits.map((a) => (
              <option key={a.id} value={a.id}>{a.store_name} — {fmtDate(a.audit_date)}</option>
            ))}
          </select>
          <button className="btn-primary" disabled={!auditId}
                  onClick={() => downloadReport(`/stock/count?audit_id=${auditId}&format=xlsx`,
                                                `batch_count_${audit?.store_code || auditId}.xlsx`)}>
            Download Excel
          </button>
          <button className="btn-ghost" disabled={!auditId}
                  onClick={() => downloadReport(`/stock/count?audit_id=${auditId}&format=csv`,
                                                `batch_count_${audit?.store_code || auditId}.csv`)}>
            CSV
          </button>
        </div>
      </div>
      <div className="flex gap-2 mb-3">
        {[['all', 'All'], ['counted', 'Counted'], ['notcounted', 'Not counted'], ['diff', 'With difference'],
          ['new', `New batches (${(data?.rows || []).filter((r) => r.is_new).length})`]].map(([k, label]) => (
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
                <th className="px-3 py-3">Material</th><th className="px-3 py-3">Material Description</th>
                <th className="px-3 py-3">Batch</th><th className="px-3 py-3">Unit</th>
                <th className="px-3 py-3 text-right">System</th><th className="px-3 py-3 text-right">Physical</th>
                <th className="px-3 py-3 text-right">Difference</th>
                <th className="px-3 py-3">Location</th>
                <th className="px-3 py-3">Counted By</th>
                <th className="px-3 py-3">Remarks</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((r, idx) => (
                <Fragment key={`${r.item_id}-${r.batch_id ?? 'none'}-${idx}`}>
                <tr className={`${r.is_new ? 'bg-teal-50/40' : ''} ${r.first_of_batch ? '' : 'border-t-0'}`}>
                  <td className="px-3 py-2 font-medium">{r.material}</td>
                  <td className="px-3 py-2 text-slate-600">{r.description || '—'}</td>
                  <td className="px-3 py-2">
                    {r.batch}
                    {r.is_new && r.first_of_batch && (
                      <span className="ml-1.5 rounded bg-teal-100 px-1 py-0.5 text-[10px] font-semibold text-teal-800">NEW</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-500">{r.unit}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.stock == null ? (r.first_of_batch ? '—' : '') : fmtQty(r.stock)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.counted ? fmtQty(r.physical) : <span className="text-slate-300">not counted</span>}
                    {r.is_liquor && r.open_ml ? <span className="text-xs text-slate-500"> + {r.open_ml} ml</span> : null}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                    r.difference == null ? 'text-slate-300' : r.difference < 0 ? 'text-red-600'
                      : r.difference > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                    {r.difference == null ? (r.first_of_batch ? '—' : '') : r.difference > 0 ? `+${fmtQty(r.difference)}` : fmtQty(r.difference)}
                  </td>
                  <td className="px-3 py-2 text-sm">{r.location || '—'}</td>
                  <td className="px-3 py-2 text-xs">{r.counted_by || '—'}</td>
                  <td className={`px-3 py-2 text-xs ${r.is_new ? 'font-semibold text-teal-800' : 'text-slate-500'}`}>{r.remarks || ''}</td>
                </tr>
                {/* The material as a whole, after its last line: every batch
                    merged — book stock against everything counted. Shown on
                    the unfiltered list only, where all its batches are there. */}
                {filter === 'all' && rows[idx + 1]?.item_id !== r.item_id
                  && data.totals?.[r.item_id]?.batches > 1 && (() => {
                    const t = data.totals[r.item_id];
                    return (
                      <tr className="bg-slate-100 font-semibold">
                        <td className="px-3 py-2" colSpan={3}>{r.material} — total</td>
                        <td className="px-3 py-2 text-slate-500">{t.unit}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {t.system_qty == null ? '—' : fmtQty(t.system_qty)}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {t.physical_qty == null ? (t.physical_by_unit || '—') : fmtQty(t.physical_qty)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${
                          t.difference == null ? 'text-slate-300' : t.difference < 0 ? 'text-red-600'
                            : t.difference > 0 ? 'text-amber-600' : 'text-green-600'}`}>
                          {t.difference == null ? '—'
                            : t.difference > 0 ? `+${fmtQty(t.difference)}` : fmtQty(t.difference)}
                        </td>
                        <td></td><td></td>
                        <td className="px-3 py-2 text-xs font-normal text-slate-600">
                          {t.batches} batches merged{t.new_batches ? ` · incl. ${t.new_batches} new` : ''}
                          {t.mixed_units ? ` · units differ (${(t.units || []).join(' / ')}), no difference worked out` : ''}
                        </td>
                      </tr>
                    );
                  })()}
                </Fragment>
              ))}
              {rows.length === 0 && (
                <tr><td colSpan={10} className="p-8 text-center text-slate-400">Nothing to show.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
