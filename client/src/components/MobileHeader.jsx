import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';

// Sticky top bar for the auditor flow. Back button + title + logout.
export default function MobileHeader({ title, subtitle, back }) {
  const nav = useNavigate();
  const { user, logout } = useAuth();
  return (
    <header className="sticky top-0 z-20 bg-brand text-white shadow">
      <div className="flex items-center gap-2 px-3 py-3">
        {back && (
          <button onClick={() => nav(back)} className="p-1 -ml-1 text-2xl leading-none" aria-label="Back">‹</button>
        )}
        <div className="flex-1 min-w-0">
          <div className="font-bold truncate">{title}</div>
          {subtitle && <div className="text-xs text-white/80 truncate">{subtitle}</div>}
        </div>
        <button onClick={() => { logout(); nav('/login'); }}
                className="text-xs bg-white/15 rounded-lg px-3 py-1.5">
          {user?.name?.split(' ')[0] || 'Logout'} ⏻
        </button>
      </div>
    </header>
  );
}
