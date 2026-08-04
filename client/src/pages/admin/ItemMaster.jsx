import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { Spinner, PhotoThumb } from '../../components/ui.jsx';
import PhotoInput from '../../components/PhotoInput.jsx';

const blank = { code: '', name: '', section_id: '', category_id: '', unit: 'Nos', is_liquor: false, bottle_size_ml: '', rate: '' };

export default function ItemMaster() {
  const [items, setItems] = useState(null);
  const [sections, setSections] = useState([]);
  const [categories, setCategories] = useState([]);
  const [search, setSearch] = useState('');
  const [fSection, setFSection] = useState('');
  const [fCat, setFCat] = useState('');
  const [editing, setEditing] = useState(null); // item object or blank for new
  const [panel, setPanel] = useState(null); // 'csv' | 'photos'

  const load = useCallback(() => {
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    if (fSection) qs.set('section_id', fSection);
    if (fCat) qs.set('category_id', fCat);
    api.get(`/items?${qs}`).then(setItems);
  }, [search, fSection, fCat]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/meta/sections').then(setSections);
    api.get('/meta/categories').then(setCategories);
  }, []);

  if (!items) return <Spinner />;

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <h1 className="text-2xl font-bold">Item master</h1>
        <div className="flex gap-2">
          <button className="btn-ghost" onClick={() => setPanel('csv')}>⬆ CSV import</button>
          <button className="btn-ghost" onClick={() => setPanel('photos')}>🖼 Bulk photos</button>
          <button className="btn-primary" onClick={() => setEditing({ ...blank })}>+ New item</button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 mb-3">
        <input className="field max-w-xs" placeholder="Search code or name…" value={search} onChange={(e) => setSearch(e.target.value)} />
        <select className="field max-w-[200px]" value={fSection} onChange={(e) => setFSection(e.target.value)}>
          <option value="">All sections</option>
          {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select className="field max-w-[200px]" value={fCat} onChange={(e) => setFCat(e.target.value)}>
          <option value="">All categories</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500">
            <tr>
              <th className="px-3 py-3">Photo</th><th className="px-3 py-3">Code</th>
              <th className="px-3 py-3">Name</th><th className="px-3 py-3">Section / Category</th>
              <th className="px-3 py-3">Unit</th><th className="px-3 py-3">Liquor</th>
              <th className="px-3 py-3 text-right">Rate</th><th className="px-3 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {items.map((i) => (
              <tr key={i.id}>
                <td className="px-3 py-2"><PhotoThumb src={i.photo_url} size={44} /></td>
                <td className="px-3 py-2 font-mono">{i.code}</td>
                <td className="px-3 py-2 font-medium">{i.name}</td>
                <td className="px-3 py-2 text-slate-500">{i.section_name || '—'} / {i.category_name || '—'}</td>
                <td className="px-3 py-2">{i.is_liquor ? `Bottle (${i.bottle_size_ml || '?'}ml)` : i.unit}</td>
                <td className="px-3 py-2">{i.is_liquor ? 'Yes' : ''}</td>
                <td className="px-3 py-2 text-right">{i.rate != null ? Number(i.rate).toFixed(2) : '—'}</td>
                <td className="px-3 py-2 text-right">
                  <button className="text-brand font-medium" onClick={() => setEditing(i)}>Edit</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {items.length === 0 && <div className="p-8 text-center text-slate-400">No items.</div>}
      </div>

      {editing && (
        <ItemEditor item={editing} sections={sections} categories={categories}
                    onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />
      )}
      {panel === 'csv' && <CsvImport onClose={() => setPanel(null)} onDone={() => { setPanel(null); load(); }} />}
      {panel === 'photos' && <BulkPhotos onClose={() => setPanel(null)} onDone={() => { setPanel(null); load(); }} />}
    </div>
  );
}

function Modal({ title, onClose, children, wide }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40" onClick={onClose}>
      <div className={`card w-full ${wide ? 'max-w-3xl' : 'max-w-md'} max-h-[90vh] overflow-y-auto`} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-3 border-b sticky top-0 bg-white">
          <h2 className="font-bold text-lg">{title}</h2>
          <button className="text-2xl text-slate-400" onClick={onClose}>×</button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function ItemEditor({ item, sections, categories, onClose, onSaved }) {
  const [f, setF] = useState({
    code: item.code || '', name: item.name || '', section_id: item.section_id || '',
    category_id: item.category_id || '', unit: item.unit || 'Nos', is_liquor: !!item.is_liquor,
    bottle_size_ml: item.bottle_size_ml || '', rate: item.rate ?? '', photo_url: item.photo_url || null,
  });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isNew = !item.id;

  async function save() {
    setErr(''); setBusy(true);
    const payload = {
      code: f.code.trim(), name: f.name.trim(),
      section_id: f.section_id || null, category_id: f.category_id || null,
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
  return (
    <Modal title={isNew ? 'New item' : `Edit ${item.code}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="flex justify-center"><PhotoThumb src={f.photo_url} size={100} /></div>
        {/* Photo control is upload-only on desktop admin. */}
        <PhotoInput value={f.photo_url} uploadOnly onUploaded={(url) => set({ photo_url: url })} />
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-sm text-slate-600">Code</span>
            <input className="field mt-1" value={f.code} disabled={!isNew} onChange={(e) => set({ code: e.target.value })} /></label>
          <label className="block"><span className="text-sm text-slate-600">Unit</span>
            <input className="field mt-1" value={f.unit} onChange={(e) => set({ unit: e.target.value })} /></label>
        </div>
        <label className="block"><span className="text-sm text-slate-600">Name</span>
          <input className="field mt-1" value={f.name} onChange={(e) => set({ name: e.target.value })} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block"><span className="text-sm text-slate-600">Section</span>
            <select className="field mt-1" value={f.section_id} onChange={(e) => set({ section_id: e.target.value })}>
              <option value="">—</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select></label>
          <label className="block"><span className="text-sm text-slate-600">Category</span>
            <select className="field mt-1" value={f.category_id} onChange={(e) => set({ category_id: e.target.value })}>
              <option value="">—</option>{categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
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
        <label className="block"><span className="text-sm text-slate-600">Rate (₹)</span>
          <input className="field mt-1" value={f.rate} onChange={(e) => set({ rate: e.target.value })} /></label>
        {err && <p className="text-red-600 text-sm">{err}</p>}
        <button className="btn-primary w-full" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save item'}</button>
      </div>
    </Modal>
  );
}

function CsvImport({ onClose, onDone }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function doPreview() {
    setErr(''); setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      setPreview(await api.upload('/items/import/preview', fd));
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function commit() {
    setErr(''); setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api.upload('/items/import/commit', fd);
      alert(`Imported: ${r.inserted} new, ${r.updated} updated.`);
      onDone();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }

  return (
    <Modal title="CSV import" onClose={onClose} wide>
      <p className="text-sm text-slate-600 mb-2">
        Columns: <code>code, name, section, category, unit, is_liquor, bottle_size_ml, rate</code>.
        Preview validates every row before anything is written.
      </p>
      <input type="file" accept=".csv,text/csv" className="mb-3"
             onChange={(e) => { setFile(e.target.files?.[0]); setPreview(null); }} />
      <div className="flex gap-2 mb-4">
        <button className="btn-ghost" disabled={!file || busy} onClick={doPreview}>Preview</button>
        <button className="btn-primary" disabled={!preview || preview.invalid > 0 || busy} onClick={commit}>
          Commit {preview ? `(${preview.valid} rows)` : ''}
        </button>
      </div>
      {err && <p className="text-red-600 text-sm mb-2">{err}</p>}
      {preview && (
        <>
          <p className="text-sm mb-2">
            {preview.total} rows · <span className="text-green-600">{preview.valid} valid</span> ·{' '}
            <span className="text-red-600">{preview.invalid} invalid</span>
            {preview.invalid > 0 && ' — fix errors before committing.'}
          </p>
          <div className="overflow-x-auto max-h-80 border rounded-xl">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 sticky top-0"><tr>
                <th className="px-2 py-2 text-left">Row</th><th className="px-2 py-2 text-left">Code</th>
                <th className="px-2 py-2 text-left">Name</th><th className="px-2 py-2 text-left">New?</th>
                <th className="px-2 py-2 text-left">Errors</th>
              </tr></thead>
              <tbody className="divide-y">
                {preview.rows.map((r) => (
                  <tr key={r.row} className={r.errors.length ? 'bg-red-50' : ''}>
                    <td className="px-2 py-1.5">{r.row}</td>
                    <td className="px-2 py-1.5 font-mono">{r.data.code}</td>
                    <td className="px-2 py-1.5">{r.data.name}</td>
                    <td className="px-2 py-1.5">{r.isNew ? 'new' : 'update'}</td>
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
        Filenames are matched to item code, e.g. <code>DRY-001.jpg</code> → item DRY-001.
      </p>
      <input type="file" accept="image/*" multiple disabled={busy}
             onChange={(e) => upload([...e.target.files])} />
      {busy && <p className="mt-3 text-slate-500">Uploading…</p>}
      {err && <p className="mt-3 text-red-600 text-sm">{err}</p>}
      {result && (
        <div className="mt-4 text-sm">
          <p className="text-green-600">{result.matched} photo(s) matched and saved.</p>
          {result.unmatched.length > 0 && (
            <p className="text-amber-600 mt-1">Unmatched: {result.unmatched.join(', ')}</p>
          )}
          <button className="btn-primary w-full mt-4" onClick={onDone}>Done</button>
        </div>
      )}
    </Modal>
  );
}
