// ═══════════════════════════════════════════════════════════════════════════
// Import feedback that STAYS on screen.
//
// A CSV import is a bulk change to the master data of a live audit. A toast
// that fades after two seconds is not feedback — if the admin looks away they
// have no idea whether 618 items imported or nothing happened at all. These
// banners persist until dismissed, and always state numbers, not adjectives.
//
//   success  — everything in the file was applied
//   warning  — it worked, but not for every row; the shortfall is spelled out
//   error    — it did not work, and says why
// ═══════════════════════════════════════════════════════════════════════════

const TONES = {
  success: { box: 'border-green-300 bg-green-50', head: 'text-green-900', icon: '✓' },
  warning: { box: 'border-amber-400 bg-amber-50', head: 'text-amber-900', icon: '⚠' },
  error:   { box: 'border-red-400 bg-red-50',     head: 'text-red-800',   icon: '⛔' },
};

export default function ImportResult({ tone = 'success', title, lines = [], actions, onDismiss }) {
  const t = TONES[tone] || TONES.success;
  return (
    <div className={`rounded-xl border-2 p-4 ${t.box}`} role="status" aria-live="polite"
         data-testid="import-result">
      <div className="flex items-start gap-3">
        <span className={`text-lg leading-none mt-0.5 ${t.head}`}>{t.icon}</span>
        <div className="flex-1 min-w-0">
          <div className={`font-bold ${t.head}`}>{title}</div>
          {lines.filter(Boolean).map((l, i) => (
            <div key={i} className={`text-sm mt-1 ${t.head} opacity-90`}>{l}</div>
          ))}
          {actions && <div className="mt-2 flex flex-wrap gap-3 text-sm">{actions}</div>}
        </div>
        {/* Dismissal is the ONLY way this goes away — never a timer. */}
        <button className={`shrink-0 text-xl leading-none ${t.head} opacity-60 hover:opacity-100`}
                aria-label="Dismiss" onClick={onDismiss}>×</button>
      </div>
    </div>
  );
}

// Progress indicator naming the file, so a slow import never looks like a
// frozen screen.
export function ImportProgress({ filename, verb = 'Importing' }) {
  return (
    <div className="rounded-xl border-2 border-sky-300 bg-sky-50 p-4 flex items-center gap-3"
         role="status" aria-live="polite" data-testid="import-progress">
      <span className="h-5 w-5 rounded-full border-2 border-sky-300 border-t-sky-700 animate-spin" />
      <div className="text-sm text-sky-900">
        <span className="font-semibold">{verb} </span>
        <span className="font-mono">{filename}</span>
        <span> … please wait. Do not close this window.</span>
      </div>
    </div>
  );
}
