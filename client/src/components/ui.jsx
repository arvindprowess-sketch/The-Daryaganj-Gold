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

// An item somebody had to correct: at least one of its entries was voided.
//
// Voiding is normal — it is how a miscount is withdrawn — but it is also the
// one thing a checker wants to go back over, and finding those items meant
// opening them one at a time. The mark is small and sits beside the count so
// it reads as a footnote on the number, not as an error on the item.
export function VoidMark({ count }) {
  if (!count) return null;
  const label = `${count} voided ${count === 1 ? 'entry' : 'entries'} — open to see what was withdrawn`;
  return (
    <span title={label} aria-label={label}
          className="shrink-0 inline-flex items-center gap-0.5 rounded-md border border-red-200
                     bg-red-50 px-1 py-0.5 text-[11px] font-semibold text-red-600 leading-none">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" /><path d="M6 18L18 6" />
      </svg>
      {count > 1 && count}
    </span>
  );
}
