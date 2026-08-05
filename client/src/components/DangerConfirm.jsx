import { useState, useEffect } from 'react';

// ═══════════════════════════════════════════════════════════════════════════
// Typed-phrase confirmation for destructive actions.
//
// A checkbox or a plain Yes/No dialog is deliberately NOT enough: the admin
// must type the exact phrase, which the server independently re-validates.
// ═══════════════════════════════════════════════════════════════════════════
export default function DangerConfirm({
  open, title, phrase, impact, warning, confirmLabel = 'Confirm',
  busy = false, error = '', onCancel, onConfirm,
}) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (open) setTyped(''); }, [open]);
  if (!open) return null;

  const ok = typed.trim().toUpperCase() === phrase;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
      <div className="card w-full max-w-lg p-5">
        <h2 className="font-bold text-lg text-red-700 mb-2">{title}</h2>
        {impact && <div className="text-sm text-slate-800 mb-3">{impact}</div>}
        {warning && (
          <div className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-2 text-sm text-amber-800 mb-3">
            {warning}
          </div>
        )}
        <label className="block text-sm text-slate-600 mb-1">
          Type <span className="font-mono font-bold">{phrase}</span> to confirm:
        </label>
        <input className="field font-mono" value={typed} autoFocus
               onChange={(e) => setTyped(e.target.value)} />
        {error && <p className="text-red-600 text-sm mt-2">{error}</p>}
        <div className="flex gap-2 justify-end mt-4">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>Cancel</button>
          <button className="btn-danger" disabled={!ok || busy} onClick={onConfirm}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
