import { useEffect, useState } from 'react';
import BottomSheet from './BottomSheet.jsx';
import PhotoInput from './PhotoInput.jsx';
import { PhotoThumb, Spinner } from './ui.jsx';
import { api, bustCache } from '../lib/api.js';
import { useToast } from './Toast.jsx';
import { saveDraft, loadDraft, clearDraft, queueEntry } from '../lib/queue.js';

// M6 — Item entry bottom sheet. Non-liquor and liquor layouts.
// M7 — Duplicate prompt when adding a second entry (warn, never block).
// On success the sheet CLOSES and the caller returns to the list (#6).
export default function ItemEntry({ auditId, item, onClose, onSaved, uploadOnly = false, canVoid = true }) {
  const empty = { qty: '', bottles: '', open_ml: '', location_text: '', remarks: '', photo_url: null };
  const [form, setForm] = useState(() => loadDraft(auditId, item.id) || empty);
  const [entries, setEntries] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dupPrompt, setDupPrompt] = useState(false);
  const toast = useToast();

  const activeEntries = (entries || []).filter((e) => e.status === 'active');

  function loadEntries() {
    return api.get(`/audits/${auditId}/items/${item.id}/entries`).then(setEntries);
  }
  useEffect(() => { loadEntries(); /* eslint-disable-next-line */ }, [auditId, item.id]);

  // Mirror every keystroke to localStorage (network safety net).
  function update(patch) {
    const next = { ...form, ...patch };
    setForm(next);
    saveDraft(auditId, item.id, next);
  }

  function buildPayload() {
    const p = { item_id: item.id, location_text: form.location_text || null,
                remarks: form.remarks || null, photo_url: form.photo_url || null };
    if (item.is_liquor) {
      p.bottles = form.bottles === '' ? null : Number(form.bottles);
      p.open_ml = form.open_ml === '' ? null : Number(form.open_ml);
    } else {
      p.qty = form.qty === '' ? null : Number(form.qty);
    }
    return p;
  }

  function validate() {
    if (item.is_liquor) {
      if (form.bottles === '' && form.open_ml === '') return 'Enter sealed bottles and/or open ml (type 0 if none).';
    } else if (form.qty === '') {
      return 'Enter quantity (type 0 if none found).';
    }
    return '';
  }

  // Human-readable summary for the toast, e.g. "Refined Oil, 2.000 Ltr".
  function describe(payload) {
    if (item.is_liquor) {
      const parts = [`${payload.bottles ?? 0} btl`];
      if (payload.open_ml) parts.push(`${payload.open_ml} ml`);
      return `${item.name}, ${parts.join(' · ')}`;
    }
    return `${item.name}, ${Number(payload.qty).toFixed(3)} ${item.unit}`;
  }

  async function doSave() {
    setError('');
    const v = validate();
    if (v) { setError(v); return; }
    setBusy(true);
    const payload = buildPayload();
    try {
      const saved = await api.post(`/audits/${auditId}/entries`, payload);
      clearDraft(auditId, item.id);
      setForm(empty);
      toast(`Saved — ${describe(payload)}`);
      if (saved?.photo_outcome === 'pending_review') {
        toast('Photo sent to admin for review (item already has a photo)', 'warn', 3400);
      }
      // Refresh the list, then close and return to it (#6).
      await onSaved?.();
      onClose();
    } catch (err) {
      if (err.isNetwork) {
        // Offline — queue and keep the form intact. NEVER clear on failure.
        queueEntry(auditId, payload);
        setError('No connection — entry queued and will retry automatically.');
        toast('Queued — will sync when back online', 'warn');
        await onSaved?.();
      } else {
        setError(err.message || 'Could not save');
      }
    } finally {
      setBusy(false);
      setDupPrompt(false);
    }
  }

  function attemptSave() {
    const v = validate();
    if (v) { setError(v); return; }
    // M7 — second entry for the same item → warn (do not block).
    if (activeEntries.length > 0) setDupPrompt(true);
    else doSave();
  }

  async function voidEntry(entry) {
    const reason = window.prompt('Reason for voiding this entry?');
    if (!reason || !reason.trim()) return;
    await api.post(`/entries/${entry.id}/void`, { reason: reason.trim() });
    await loadEntries();
    toast('Entry voided');
    await onSaved?.();
  }

  const firstActive = activeEntries[0];
  const dupDesc = firstActive
    ? item.is_liquor
      ? `${firstActive.bottles ?? 0} btl / ${firstActive.open_ml ?? 0} ml, ${firstActive.location_text || 'no location'}`
      : `${Number(firstActive.qty).toFixed(3)} ${item.unit}, ${firstActive.location_text || 'no location'}`
    : '';

  return (
    <BottomSheet open onClose={onClose} title={item.name}>
      {/* Large photo — cache-busted so a fresh upload shows immediately. */}
      <div className="flex justify-center mb-3">
        <PhotoThumb src={bustCache(item.photo_url, item.photo_version)} size={140} />
      </div>
      <div className="flex items-center justify-between mb-3">
        <div className="font-bold text-lg">{item.name}</div>
        <div className="text-sm text-slate-500">Unit: {item.is_liquor ? 'Bottle' : item.unit}</div>
      </div>

      {/* Prior entries (read-only). Void shown struck through. */}
      {entries === null ? <Spinner label="Loading entries…" /> : entries.length > 0 && (
        <div className="mb-4">
          <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">Already counted</div>
          <div className="divide-y rounded-xl border">
            {entries.map((e) => (
              <div key={e.id} className={`flex items-center justify-between px-3 py-2 ${e.status === 'void' ? 'opacity-60' : ''}`}>
                <div className={e.status === 'void' ? 'line-through' : ''}>
                  <div className="font-medium">
                    {item.is_liquor
                      ? `${e.bottles ?? 0} btl · ${e.open_ml ?? 0} ml`
                      : `${Number(e.qty).toFixed(3)} ${item.unit}`}
                    {e.location_text ? ` · ${e.location_text}` : ''}
                  </div>
                  <div className="text-xs text-slate-500">
                    {e.counted_by_name} · {new Date(e.counted_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    {e.status === 'void' && e.void_reason ? ` · voided: ${e.void_reason}` : ''}
                  </div>
                </div>
                {e.status === 'active' && canVoid && (
                  <button className="text-red-600 text-sm font-medium" onClick={() => voidEntry(e)}>void</button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Entry form */}
      <div className="space-y-3">
        {item.is_liquor ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-sm font-medium text-slate-600">Sealed bottles</span>
              <input className="field mt-1" inputMode="numeric" pattern="[0-9]*"
                     value={form.bottles} onChange={(e) => update({ bottles: e.target.value.replace(/[^0-9]/g, '') })} />
            </label>
            <label className="block">
              <span className="text-sm font-medium text-slate-600">Open bottle (ml)</span>
              <input className="field mt-1" inputMode="numeric" pattern="[0-9]*"
                     value={form.open_ml} onChange={(e) => update({ open_ml: e.target.value.replace(/[^0-9]/g, '') })} />
            </label>
          </div>
        ) : (
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Quantity</span>
            <input className="field mt-1 text-lg" inputMode="decimal"
                   value={form.qty} onChange={(e) => update({ qty: e.target.value.replace(/[^0-9.]/g, '') })}
                   placeholder="Type 0 if none found" />
          </label>
        )}
        <label className="block">
          <span className="text-sm font-medium text-slate-600">Location</span>
          <input className="field mt-1" value={form.location_text}
                 onChange={(e) => update({ location_text: e.target.value })} placeholder="e.g. Dry Store, rack 3" />
        </label>
        <label className="block">
          <span className="text-sm font-medium text-slate-600">Remarks</span>
          <input className="field mt-1" value={form.remarks}
                 onChange={(e) => update({ remarks: e.target.value })} />
        </label>

        <PhotoInput value={form.photo_url} uploadOnly={uploadOnly}
                    onUploaded={(url) => update({ photo_url: url })} />

        {error && <p className="text-sm text-red-600">{error}</p>}

        <button className="btn-primary w-full text-lg" disabled={busy} onClick={attemptSave}>
          {busy ? 'Saving…' : 'SAVE ENTRY'}
        </button>
      </div>

      {/* M7 duplicate prompt */}
      {dupPrompt && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-5 bg-black/40">
          <div className="card p-5 max-w-sm w-full">
            <p className="font-medium mb-4">
              This item already has an entry ({dupDesc}). Are you adding stock found at a different location?
            </p>
            <div className="flex gap-2">
              <button className="btn-ghost flex-1" onClick={() => setDupPrompt(false)}>Cancel</button>
              <button className="btn-primary flex-1" onClick={doSave}>Yes, add entry</button>
            </div>
          </div>
        </div>
      )}
    </BottomSheet>
  );
}
