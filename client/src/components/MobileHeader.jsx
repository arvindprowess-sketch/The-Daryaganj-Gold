import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import ConfirmDialog from './ConfirmDialog.jsx';
import { pendingCount } from '../lib/queue.js';

// Sticky top bar for the auditor flow. Back button + title + logout.
export default function MobileHeader({ title, subtitle, back }) {
  const nav = useNavigate();
  const { user, logout, offline } = useAuth();
  const [confirm, setConfirm] = useState(false);

  return (
    <>
      <header className="sticky top-0 z-20 bg-brand text-white shadow">
        <div className="flex items-center gap-2 px-3 py-3">
          {back && (
            <button onClick={() => nav(back)} className="p-1 -ml-1 text-2xl leading-none" aria-label="Back">‹</button>
          )}
          <div className="flex-1 min-w-0">
            <div className="font-bold truncate">{title}</div>
            {subtitle && <div className="text-xs text-white/80 truncate">{subtitle}</div>}
          </div>
          <button onClick={() => setConfirm(true)}
                  className="text-xs bg-white/15 rounded-lg px-3 py-1.5">
            {user?.name?.split(' ')[0] || 'Logout'} ⏻
          </button>
        </div>
        {offline && (
          <div className="bg-amber-500 text-white text-xs px-3 py-1 text-center">
            No network — new entries are kept on this phone and are NOT saved on the server until it returns.
          </div>
        )}
      </header>

      <ConfirmDialog
        open={confirm}
        title="Log out?"
        // Entries waiting for the network are NOT lost by logging out — they
        // stay on this phone and go after the next sign-in — but only on THIS
        // phone. Say so before, not after.
        message={pendingCount() > 0
          ? `${pendingCount()} entr${pendingCount() === 1 ? 'y is' : 'ies are'} NOT saved on the server yet (no network). `
            + 'They will try to send now. Any that cannot stay on THIS phone and are sent after you sign in again here — '
            + 'do not clear the browser data or use another phone until they have gone.'
          : 'Any entry still being typed on this screen will be lost.'}
        confirmLabel="Log out"
        danger
        onCancel={() => setConfirm(false)}
        // Awaited: logout sends anything still queued before the token goes.
        onConfirm={async () => { await logout(); nav('/login'); }}
      />
    </>
  );
}
