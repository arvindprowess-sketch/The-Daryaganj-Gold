import { NavLink, Outlet, useNavigate, Link } from 'react-router-dom';
import { useAuth } from '../../lib/auth.jsx';
import { useState, useEffect } from 'react';
import ConfirmDialog from '../../components/ConfirmDialog.jsx';
import { api } from '../../lib/api.js';

const nav = [
  ['', 'Dashboard', '📊'],
  ['items', 'Item Master', '📦'],
  ['photo-review', 'Photo Review', '🖼️'],
  ['stores-users', 'Stores & Users', '🏬'],
  ['audits', 'Audit Sessions', '🗓️'],
  ['settings', 'Settings', '⚙️'],
  ['reports', 'Reports', '📈'],
  ['readiness', 'System Readiness', '✅'],
  ['data', 'Data Management', '🗑️'],
];

export default function AdminLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Persistent while ANY demo record exists — including in production, where
  // demo data should never have arrived in the first place.
  const [demo, setDemo] = useState(null);
  useEffect(() => { api.get('/data/demo').then(setDemo).catch(() => {}); }, []);

  const Links = () => (
    <nav className="space-y-1">
      {nav.map(([to, label, icon]) => (
        <NavLink key={to} to={`/admin/${to}`} end={to === ''} onClick={() => setOpen(false)}
                 className={({ isActive }) =>
                   `flex items-center gap-3 px-3 py-2.5 rounded-xl transition ${
                     isActive ? 'bg-brand text-white' : 'text-slate-300 hover:bg-white/10'}`}>
          <span>{icon}</span><span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );

  return (
    <div className="min-h-full flex">
      {/* Sidebar (desktop) */}
      <aside className="hidden md:flex md:flex-col w-64 bg-slate-900 text-white p-4 shrink-0">
        <div className="px-2 mb-6">
          <div className="text-2xl font-black">Audix</div>
          <div className="text-xs text-slate-400">Solutions &amp; Co.</div>
        </div>
        <Links />
        <div className="mt-auto pt-4 border-t border-white/10 text-sm">
          <div className="px-2 text-slate-400">{user?.name}</div>
          <button className="mt-2 w-full text-left px-2 py-2 rounded-lg hover:bg-white/10"
                  onClick={() => setConfirm(true)}>Log out</button>
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="md:hidden fixed top-0 inset-x-0 z-30 bg-slate-900 text-white flex items-center px-3 py-3">
        <button onClick={() => setOpen(!open)} className="text-2xl px-2">☰</button>
        <span className="font-bold ml-1">Audix Admin</span>
      </div>
      {open && (
        <div className="md:hidden fixed inset-0 z-40" onClick={() => setOpen(false)}>
          <div className="absolute inset-0 bg-black/50" />
          <div className="absolute left-0 top-0 bottom-0 w-64 bg-slate-900 text-white p-4" onClick={(e) => e.stopPropagation()}>
            <div className="text-2xl font-black mb-6 px-2">Audix</div>
            <Links />
            <button className="mt-6 w-full text-left px-2 py-2 rounded-lg hover:bg-white/10"
                    onClick={() => setConfirm(true)}>Log out</button>
          </div>
        </div>
      )}

      <main className="flex-1 min-w-0 p-4 md:p-8 pt-16 md:pt-8">
        {demo?.present && (
          <div className="mb-4 rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-3
                          flex flex-wrap items-center justify-between gap-3">
            <span className="text-amber-900 text-sm">
              <strong>Demo data present</strong> — {demo.users} users, {demo.stores} stores,{' '}
              {demo.items} items, {demo.audits} audits, {demo.entries} entries. Remove it before go-live.
              {demo.users === 1 && demo.stores + demo.items + demo.audits + demo.entries === 0 && (
                <span className="block text-amber-700">
                  Only your own signed-in demo account remains — create a real admin, then remove it.
                </span>
              )}
            </span>
            <Link className="btn-ghost text-sm py-1.5 shrink-0" to="/admin/data">Delete demo data</Link>
          </div>
        )}
        <Outlet />
      </main>

      <ConfirmDialog
        open={confirm}
        title="Log out?"
        message="Any unsaved entry on this screen will be lost."
        confirmLabel="Log out"
        danger
        onCancel={() => setConfirm(false)}
        // Awaited: logout sends anything still queued before the token goes.
        onConfirm={async () => { await logout(); navigate('/login'); }}
      />
    </div>
  );
}
