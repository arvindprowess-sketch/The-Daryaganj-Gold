import { useEffect, useState, useCallback } from 'react';
import { api, bustCache, downloadReport } from '../../lib/api.js';
import { Spinner, PhotoThumb } from '../../components/ui.jsx';
import PhotoInput from '../../components/PhotoInput.jsx';
import { useToast } from '../../components/Toast.jsx';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';

const blank = { name: '', super_category_id: '', category_id: '', unit: '', is_liquor: false, bottle_size_ml: '', rate: '' };

// Item NAME is the single identifier — there are no item codes.
export default function ItemMaster() {
  const [items, setItems] = useState(null);
  const [counts, setCounts] = useState({ total: 0, with_photo: 0 });
  const [supers, setSupers] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [fSuper, setFSuper] = useState('');
  const [fCat, setFCat] = useState('');
  const [fPhoto, setFPhoto] = useState('');   // '' | 'has' | 'none'
  const [fActive, setFActive] = useState('active'); // active | inactive | all
  const [confirmDel, setConfirmDel] = useState(null);
  const [editing, setEditing] = useState(null);
  const [panel, setPanel] = useState(null); // 'csv' | 'photos'
  const toast = useToast();

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    if (fSuper) qs.set('super_category_id', fSuper);
    if (fCat) qs.set('category_id', fCat);
    if (fPhoto) qs.set('photo', fPhoto);
    if (fActive !== 'active') qs.set('active', fActive);
    return api.get(`/items?${qs}`).then((r) => { setItems(r.items); setCounts(r.counts); });
  }, [search, fSuper, fCat, fPhoto, fActive]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/meta/super-categories').then(setSupers);
    api.get('/meta/categories').then(setCategories);
  }, []);

  // Dependent dropdowns: choosing a super category narrows the category list.
  const visibleCats = fSuper
    ? categories.filter((c) => String(c.super_category_id) === String(fSuper))
    : categories;

  function pickSuper(v) {
    setFSuper(v);
    // Drop a category selection that no longer belongs to the chosen super.
    if (v && fCat) {
      const stillValid = categories.some(
        (c) => String(c.id) === String(fCat) && String(c.super_category_id) === String(v)
      );
      if (!stillValid) setFCat('');
    }
  }

  // An item that has ever been counted is DEACTIVATED, never hard deleted —
  // hard deleting would orphan historical audit records. The server decides.
  async function removeItem(item) {
    setConfirmDel(null);
    try {
      const r = await api.del(`/data/items/${item.id}`);
      toast(r.softDeleted
        ? `${item.name} deactivated — it has ${r.entries} count entries and stays in historical reports`
        : `${item.name} deleted`);
      load();
    } catch (e) { toast(e.message, 'error'); }
  }
  async function reactivate(item) {
    try {
      await api.post(`/data/items/${item.id}/reactivate`, {});
      toast(`${item.name} reactivated`);
      load();
    } catch (e) { toast(e.message, 'error'); }
  }

  if (!items) return <Spinner />;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div>
          <h1 className="text-2xl font-bold">Item master</h1>
          {/* Photo coverage at a glance while photos are collected. */}
          <p className="text-slate-500 text-sm">
            {counts.total} items · {counts.with_photo} with photos
            {counts.inactive > 0 && <span className="text-slate-400"> · {counts.inactive} inactive</span>}
            {counts.total > counts.with_photo && (
              <span className="text-amber-600"> · {counts.total - counts.with_photo} missing</span>
            )}
          </p>
        </div>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setPanel('csv')}>⬆ CSV import</button>
          <button className="btn-ghost" onClick={() => setPanel('photos')}>🖼 Bulk photos</button>
          <button className="btn-primary" onClick={() => setEditing({ ...blank })}>+ New item</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <input className="field max-w-xs" placeholder="Search name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="field max-w-[220px]" value={fSuper} onChange={(e) => pickSuper(e.target.value)}>
          <option value="">All super categories</option>
          {supers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="field max-w-[220px]" value={fCat} onChange={(e) => setFCat(e.target.value)}>
          <option value="">All categories</option>
          {visibleCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <div className="flex gap-2">
          {[['', 'All'], ['has', 'Has photo'], ['none', 'No photo']].map(([k, label]) => (
            <button key={k || 'all'} className={fPhoto === k ? 'chip-on' : 'chip-off'}
                    onClick={() => setFPhoto(k)}>{label}</button>
          ))}
        </div>
        {/* Inactive = soft-deleted: hidden from counting, kept for history. */}
        <div className="flex gap-2">
          {[['active', 'Active'], ['inactive', 'Inactive'], ['all', 'All']].map(([k, label]) => (
            <button key={k} className={fActive === k ? 'chip-on' : 'chip-off'}
                    onClick={() => setFActive(k)}>{label}</button>
          ))}
        </div>
      </div>

      <p className="text-sm text-slate-500 mb-2">Showing {items.length} of {counts.total} items.</p>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-3">Photo</th>
              <th className="px-3 py-3">Super Category</th>
              <th className="px-3 py-3">Category</th>
              <th className="px-3 py-3">Name</th>
              <th className="px-3 py-3">Unit</th><th className="px-3 py-3">Liquor</th>
              <th className="px-3 py-3 text-right">Rate</th><th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((i) => (
              <tr key={i.id}>
                <td className="px-3 py-2"><PhotoThumb src={bustCache(i.photo_url, i.photo_version)} size={44} /></td>
                <td className="px-3 py-2 text-slate-500">{i.super_category_name || '—'}</td>
                <td className="px-3 py-2 text-slate-500">{i.category_name || '—'}</td>
                <td className="px-3 py-2 font-medium">
                  {i.name}
                  {!i.is_active && (
                    <span className="ml-2 chip bg-slate-100 text-slate-500 border-slate-200">inactive</span>
                  )}
                </td>
                {/* Unit is displayed exactly as uploaded. */}
                <td className="px-3 py-2">{i.unit}</td>
                <td className="px-3 py-2">{i.is_liquor ? `Yes (${i.bottle_size_ml || '?'}ml)` : ''}</td>
                <td className="px-3 py-2 text-right">{i.rate != null ? Number(i.rate).toFixed(2) : '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">
                  <button className="text-brand font-medium" onClick={() => setEditing(i)}>Edit</button>
                  {i.is_active
                    ? <button className="text-red-600 font-medium ml-3"
                              onClick={() => setConfirmDel(i)}>Delete</button>
                    : <button className="text-green-600 font-medium ml-3"
                              onClick={() => reactivate(i)}>Reactivate</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <div className="p-8 text-center text-slate-400">No items.</div>}
      </div>

      {editing && (
        <ItemEditor item={editing} supers={supers} categories={categories}
                    onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      <ConfirmDialog
        open={!!confirmDel}
        title={`Delete "${confirmDel?.name}"?`}
        message="If this item has ever been counted it will be deactivated rather than deleted, so historical audit records stay intact. Items never counted are removed permanently."
        confirmLabel="Delete"
        danger
        onCancel={() => setConfirmDel(null)}
        onConfirm={() => removeItem(confirmDel)}
      />
      {panel === 'csv' && <CsvImport onClose={() => setPanel(null)} onDone={() => { setPanel(null); load(); }} />}
      {panel === 'photos' && <BulkPhotos onClose={() => setPanel(null)} onDone={() => { setPanel(null); load(); }} />}
    </div>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className={`card w-full ${wide ? 'max-w-4xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-white">
          <h2 className="font-bold text-lg">{title}</h2>
          <button className="text-2xl text-slate-400" onClick={onClose}>×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function ItemEditor({ item, supers, categories, onClose, onSaved }) {
  const [f, setF] = useState({
    name: item.name || '', super_category_id: item.super_category_id || '',
    category_id: item.category_id || '', unit: item.unit || '', is_liquor: !!item.is_liquor,
    bottle_size_ml: item.bottle_size_ml || '', rate: item.rate ?? '',
    photo_url: item.photo_url || null, photo_version: item.photo_version,
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = !item.id;

  async function save() {
    setErr(''); setBusy(true);
    const payload = {
      name: f.name.trim(),
      super_category_id: f.super_category_id || null, category_id: f.category_id || null,
      // Unit is free text, stored as typed.
      unit: f.unit, is_liquor: f.is_liquor,
      bottle_size_ml: f.is_liquor ? Number(f.bottle_size_ml) || null : null,
      rate: f.rate === '' ? null : Number(f.rate), photo_url: f.photo_url,
    };
    try {
      if (isNew) await api.post('/items', payload);
      else await api.put(`/items/${item.id}`, payload);
      onSaved();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const set = (p) => setF({ ...f, ...p });
  // Dependent dropdowns: the category list follows the chosen super category.
  const editorCats = f.super_category_id
    ? categories.filter((c) => String(c.super_category_id) === String(f.super_category_id))
    : categories;

  function pickSuper(v) {
    const stillValid = categories.some(
      (c) => String(c.id) === String(f.category_id) && String(c.super_category_id) === String(v)
    );
    setF({ ...f, super_category_id: v, category_id: stillValid ? f.category_id : '' });
  }
  return (
    <Modal title={isNew ? 'New item' : `Edit ${item.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex justify-center"><PhotoThumb src={bustCache(f.photo_url, f.photo_version)} size={100} /></div>
        {/* Photo control is upload-only on desktop admin. */}
        <PhotoInput value={f.photo_url} uploadOnly itemName={f.name}
                    onUploaded={(url) => set({ photo_url: url, photo_version: Date.now() })} />
        <label className="block"><span className="text-sm text-slate-600">Name (this is the item's identifier)</span>
          <input className="field mt-1" value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-sm text-slate-600">Unit (free text)</span>
            <input className="field mt-1" value={f.unit} placeholder="e.g. CAN (5 LTR)"
                   onChange={(e) => set({ unit: e.target.value })} />
            <span className="block text-xs text-slate-400 mt-1">Shown exactly as typed.</span></label>
          <label className="block"><span className="text-sm text-slate-600">Rate (₹)</span>
            <input className="field mt-1" value={f.rate} onChange={(e) => set({ rate: e.target.value })} /></label>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-sm text-slate-600">Super Category</span>
            <select className="field mt-1" value={f.super_category_id} onChange={(e) => pickSuper(e.target.value)}>
              <option value="">—</option>{supers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <label className="block"><span className="text-sm text-slate-600">Category</span>
            <select className="field mt-1" value={f.category_id} onChange={(e) => set({ category_id: e.target.value })}>
              <option value="">—</option>{editorCats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select></label>
        </div>
        <div className="grid grid-cols-2 gap-3 items-end">
          <label className="flex items-center gap-2 mt-1">
            <input type="checkbox" className="h-5 w-5 accent-teal-700" checked={f.is_liquor} onChange={(e) => set({ is_liquor: e.target.checked })} />
            <span className="text-sm text-slate-600">Liquor item</span>
          </label>
          {f.is_liquor && (
            <label className="block"><span className="text-sm text-slate-600">Bottle size (ml)</span>
              <input className="field mt-1" value={f.bottle_size_ml} onChange={(e) => set({ bottle_size_ml: e.target.value })} /></label>
          )}
        </div>
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <button className="btn-primary w-full" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save item'}</button>
      </div>
    </Modal>
  );
}

// CSV import. Rows are matched to existing items by NAME. A name that does not
// match is never silently created or skipped — the admin decides per row.
function CsvImport({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [decisions, setDecisions] = useState({}); // row -> 'create' | 'skip'
  const [mode, setMode] = useState('add');        // add | upsert | replace
  const [typed, setTyped] = useState('');         // replace confirmation
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const toast = useToast();

  async function doPreview() {
    setErr(''); setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const p = await api.upload('/items/import/preview', fd);
      setPreview(p);
      // Default unmatched rows to 'skip' — nothing is created without a choice.
      const d = {};
      p.rows.filter((r) => !r.matched && !r.errors.length).forEach((r) => { d[r.row] = 'skip'; });
      setDecisions(d);
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  async function commit() {
    setErr(''); setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('mode', mode);
      fd.append('decisions', JSON.stringify(decisions));
      if (mode === 'replace') fd.append('confirm', typed);
      const r = await api.upload('/items/import/commit', fd);
      toast(`Import done — ${r.created} created, ${r.updated} updated, ${r.deleted} deleted, ${r.skipped} skipped`);
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  const unmatchedRows = preview ? preview.rows.filter((r) => !r.matched && !r.errors.length) : [];
  const createCount = Object.values(decisions).filter((v) => v === 'create').length;

  return (
    <Modal title="CSV import — item master" onClose={onClose} wide>
      <p className="text-sm text-slate-600 mb-2">
        Columns: <code>item_name, super_category, category, unit, is_liquor, bottle_size_ml, rate</code>.
        Items are matched by <strong>item_name</strong> (spaces trimmed, case-insensitive).
        <br />
        <span className="text-slate-500">
          <code>is_liquor</code> accepts TRUE/FALSE, 1/0 or Yes/No. <code>bottle_size_ml</code> is
          required when it is TRUE. <code>unit</code> is free text and is stored exactly as written.
          A super category or category that does not exist yet is created on commit.
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <button className="btn-ghost"
                onClick={() => downloadReport('/items/import/template', 'item_master_template.csv')}>
          ⬇ Download Template
        </button>
        <input type="file" accept=".csv,text/csv"
               onChange={(e) => { setFile(e.target.files?.[0]); setPreview(null); }} />
      </div>
      {/* Import mode. Nothing is ever deleted as a side effect — only the
          explicit "Replace entire master" removes anything. */}
      <div className="rounded-xl border border-slate-200 p-3 mb-3 space-y-2">
        {[
          ['add', 'Add new items only', 'Existing items are untouched.'],
          ['upsert', 'Add new and update existing', 'Matched by item name.'],
          ['replace', 'Replace entire master', 'Deletes everything, then imports.'],
        ].map(([k, label, hint]) => (
          <label key={k} className="flex items-start gap-2 text-sm cursor-pointer">
            <input type="radio" name="import-mode" className="mt-1 h-4 w-4 accent-teal-700"
                   checked={mode === k} onChange={() => setMode(k)} />
            <span>
              <span className={k === 'replace' ? 'font-semibold text-red-700' : 'font-medium'}>{label}</span>
              <span className="text-slate-500"> — {hint}</span>
              {preview?.modes?.[k] && (
                <span className="block text-xs text-slate-500">
                  {preview.modes[k].updated} updated, {preview.modes[k].created} created,{' '}
                  {preview.modes[k].deleted} deleted
                </span>
              )}
            </span>
          </label>
        ))}
      </div>

      {mode === 'replace' && preview?.modes?.replace?.blocked && (
        <div className="rounded-xl border-2 border-red-400 bg-red-50 p-3 text-sm text-red-800 mb-3">
          ⛔ {preview.modes.replace.blockedReason}
        </div>
      )}
      {mode === 'replace' && preview && !preview.modes?.replace?.blocked && (
        <div className="rounded-xl border-2 border-red-400 bg-red-50 p-3 mb-3">
          <p className="text-sm text-red-800 mb-2">
            This will permanently delete <strong>{preview.modes.replace.deleted} existing item(s)</strong>{' '}
            and import {preview.modes.replace.created} from the file.
          </p>
          <label className="block text-xs text-red-800 mb-1">
            Type <span className="font-mono font-bold">REPLACE ITEM MASTER</span> to confirm:
          </label>
          <input className="field font-mono" value={typed} onChange={(e) => setTyped(e.target.value)} />
        </div>
      )}

      <div className="flex gap-2 mb-4">
        <button className="btn-ghost" disabled={!file || busy} onClick={doPreview}>Preview</button>
        <button
          className={mode === 'replace' ? 'btn-danger' : 'btn-primary'}
          disabled={
            !preview || preview.invalid > 0 || busy ||
            (mode === 'replace' && (preview.modes?.replace?.blocked ||
                                    typed.trim().toUpperCase() !== 'REPLACE ITEM MASTER'))
          }
          onClick={commit}>
          {mode === 'replace' ? 'Replace item master'
            : mode === 'upsert' ? `Add and update${preview ? ` (${preview.modes.upsert.updated} updated, ${preview.modes.upsert.created} created, 0 deleted)` : ''}`
            : `Add new only${preview ? ` (${createCount} create)` : ''}`}
        </button>
      </div>
      {err && <p className="text-red-600 text-sm mb-2">{err}</p>}

      {preview && (
        <>
          <p className="text-sm mb-3">
            {preview.total} rows · <span className="text-green-600">{preview.matched} matched</span> ·{' '}
            <span className="text-amber-600">{preview.unmatched} unmatched</span> ·{' '}
            <span className="text-red-600">{preview.invalid} invalid</span>
            {preview.invalid > 0 && ' — fix errors before committing.'}
          </p>

          {/* Hierarchy levels the file introduces — created on commit, never
              a reason to fail the import. */}
          {(preview.newSuperCategories?.length > 0 || preview.newCategories?.length > 0) && (
            <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 p-3 text-sm">
              <div className="font-semibold text-sky-800 mb-1">New hierarchy levels — will be created</div>
              {preview.newSuperCategories?.length > 0 && (
                <div className="text-sky-800">
                  Super categories: {preview.newSuperCategories.join(', ')}
                </div>
              )}
              {preview.newCategories?.length > 0 && (
                <div className="text-sky-800">Categories: {preview.newCategories.join(', ')}</div>
              )}
            </div>
          )}

          {unmatchedRows.length > 0 && (
            <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="text-sm font-semibold text-amber-800 mb-2">
                {unmatchedRows.length} name(s) don't match any existing item — choose what to do with each:
              </p>
              <div className="max-h-56 overflow-y-auto divide-y divide-amber-200">
                {unmatchedRows.map((r) => (
                  <div key={r.row} className="flex items-center justify-between py-2 gap-3">
                    <span className="text-sm">
                      <span className="text-slate-400">row {r.row}</span> <strong>{r.data.name}</strong>
                    </span>
                    <div className="flex gap-1 shrink-0">
                      <button className={decisions[r.row] === 'create' ? 'chip-on' : 'chip-off'}
                              onClick={() => setDecisions({ ...decisions, [r.row]: 'create' })}>
                        Create as new item
                      </button>
                      <button className={decisions[r.row] === 'skip' ? 'chip-on' : 'chip-off'}
                              onClick={() => setDecisions({ ...decisions, [r.row]: 'skip' })}>
                        Skip
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="overflow-x-auto max-h-72 border rounded-xl">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0"><tr>
                <th className="px-2 py-2 text-left">Row</th>
                <th className="px-2 py-2 text-left">Super Category</th>
                <th className="px-2 py-2 text-left">Category</th>
                <th className="px-2 py-2 text-left">Item Name</th>
                <th className="px-2 py-2 text-left">Unit</th>
                <th className="px-2 py-2 text-left">Status</th>
                <th className="px-2 py-2 text-left">Errors</th>
              </tr></thead>
              <tbody className="divide-y">
                {preview.rows.map((r) => (
                  <tr key={r.row} className={r.errors.length ? 'bg-red-50' : ''}>
                    <td className="px-2 py-1.5">{r.row}</td>
                    <td className="px-2 py-1.5">
                      {r.data.super_category_name || '—'}
                      {r.newSuperCategory && <span className="ml-1 text-sky-600">(new)</span>}
                    </td>
                    <td className="px-2 py-1.5">
                      {r.data.category_name || '—'}
                      {r.newCategory && <span className="ml-1 text-sky-600">(new)</span>}
                    </td>
                    <td className="px-2 py-1.5 font-medium">{r.data.name}</td>
                    <td className="px-2 py-1.5 font-mono">{r.data.unit}</td>
                    <td className="px-2 py-1.5">
                      {r.errors.length ? 'invalid'
                        : r.matched ? <span className="text-green-600">update existing</span>
                        : <span className="text-amber-600">unmatched → {decisions[r.row] || 'skip'}</span>}
                    </td>
                    <td className="px-2 py-1.5 text-red-600">{r.errors.join('; ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Modal>
  );
}

// Photos are matched to item NAME, e.g. "Refined Oil.jpg" → item "Refined Oil".
function BulkPhotos({ onClose, onDone }) {
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function upload(files) {
    setErr(''); setBusy(true);
    try {
      const fd = new FormData();
      for (const f of files) fd.append('photos', f);
      setResult(await api.upload('/items/photos/bulk', fd));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title="Bulk photo upload" onClose={onClose}>
      <p className="text-sm text-slate-600 mb-3">
        Filenames are matched to the item <strong>name</strong>, e.g. <code>Refined Oil.jpg</code> → item
        "Refined Oil". Matching trims spaces and ignores case.
      </p>
      <input type="file" accept="image/*" multiple disabled={busy}
             onChange={(e) => upload([...e.target.files])} />
      {busy && <p className="mt-3 text-slate-500">Uploading…</p>}
      {err && <p className="mt-3 text-red-600 text-sm">{err}</p>}
      {result && (
        <div className="mt-4 text-sm">
          <p className="text-green-600">{result.matched} photo(s) matched and saved.</p>
          {result.unmatched.length > 0 && (
            <p className="text-amber-600 mt-1">Unmatched files: {result.unmatched.join(', ')}</p>
          )}
          <button className="btn-primary w-full mt-4" onClick={onDone}>Done</button>
        </div>
      )}
    </Modal>
  );
}
