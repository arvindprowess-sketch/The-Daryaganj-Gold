import { useState } from 'react';
import { api } from '../lib/api.js';
import { useAuth } from '../lib/auth.jsx';

// Shown immediately after logging in with a seeded default password. Seed
// passwords are printed to a console, so such an account must not stay usable
// until a new password is set.
export default function ChangePassword({ forced = false, onDone }) {
  const { user, refreshUser } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setErr('');
    if (next !== again) { setErr('The two new passwords do not match.'); return; }
    if (next.length < 8) { setErr('New password must be at least 8 characters.'); return; }
    setBusy(true);
    try {
      await api.post('/auth/change-password', { current_password: current, new_password: next });
      await refreshUser?.();
      onDone?.();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  }

  return (
    <div className="min-h-full flex flex-col justify-center px-5 py-10 bg-gradient-to-b from-brand to-brand-dark">
      <div className="mx-auto w-full max-w-sm">
        <div className="text-center mb-6 text-white">
          <div className="text-2xl font-black">Set a new password</div>
          {forced && (
            <p className="text-white/80 text-sm mt-2">
              This account still uses a seeded default password. Choose a new one to continue.
            </p>
          )}
        </div>
        <form onSubmit={submit} className="card p-5 space-y-4">
          <div className="text-sm text-slate-500">Signed in as <strong>{user?.username}</strong></div>
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Current password</span>
            <input className="field mt-1" type="password" value={current} autoFocus
                   onChange={(e) => setCurrent(e.target.value)} />
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-600">New password</span>
            <input className="field mt-1" type="password" value={next}
                   onChange={(e) => setNext(e.target.value)} />
            <span className="block text-xs text-slate-400 mt-1">At least 8 characters.</span>
          </label>
          <label className="block">
            <span className="text-sm font-medium text-slate-600">Confirm new password</span>
            <input className="field mt-1" type="password" value={again}
                   onChange={(e) => setAgain(e.target.value)} />
          </label>
          {err && <p className="text-red-600 text-sm">{err}</p>}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'Saving…' : 'Set password'}
          </button>
        </form>
      </div>
    </div>
  );
}
