import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

// M1 — Login: username, password, remember me.
export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await login(username.trim(), password, remember);
      nav(user.role === 'admin' ? '/admin' : '/a', { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full flex flex-col justify-center px-5 py-10 bg-gradient-to-b from-brand to-brand-dark">
      <div className="mx-auto w-full max-w-sm">
        <div className="text-center mb-8 text-white">
          <div className="text-3xl font-black tracking-tight">Audix</div>
          <div className="opacity-80 text-sm">Solutions &amp; Co. — Stock Audit</div>
        </div>
        <form onSubmit={submit} className="card p-5 space-y-4">
          <div>
            <label className="text-sm font-medium text-slate-600">Username</label>
            <input className="field mt-1" autoCapitalize="none" autoCorrect="off"
                   value={username} onChange={(e) => setUsername(e.target.value)}
                   placeholder="e.g. rakesh" autoFocus />
          </div>
          <div>
            <label className="text-sm font-medium text-slate-600">Password</label>
            <input className="field mt-1" type="password"
                   value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <label className="flex items-center gap-3 text-slate-600 select-none">
            <input type="checkbox" className="h-5 w-5 accent-teal-700"
                   checked={remember} onChange={(e) => setRemember(e.target.checked)} />
            Remember me
          </label>
          {error && <p className="text-red-600 text-sm">{error}</p>}
          <button className="btn-primary w-full" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-center text-white/70 text-xs mt-6">
          Auditor demo: rakesh / rakesh123 &nbsp;·&nbsp; Admin: admin / admin123
        </p>
      </div>
    </div>
  );
}
