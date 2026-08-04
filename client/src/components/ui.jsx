// Small shared UI atoms.
export function ProgressBar({ value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div className="w-full">
      <div className="h-2.5 w-full rounded-full bg-slate-200 overflow-hidden">
        <div className="h-full bg-brand transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }) {
  return (
    <div className="flex items-center justify-center gap-2 p-8 text-slate-500">
      <span className="h-5 w-5 rounded-full border-2 border-slate-300 border-t-brand animate-spin" />
      {label}
    </div>
  );
}

export function Empty({ children }) {
  return <div className="p-8 text-center text-slate-400">{children}</div>;
}

export function PhotoThumb({ src, size = 64 }) {
  if (src) {
    return <img src={src} alt="" className="rounded-lg object-cover border border-slate-200"
                style={{ width: size, height: size }} />;
  }
  return (
    <div className="rounded-lg bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-300"
         style={{ width: size, height: size }}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.5" />
        <path d="M4 17l5-5 4 4 3-3 4 4" />
      </svg>
    </div>
  );
}
