import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { Spinner, ProgressBar } from '../../components/ui.jsx';
import { fmtDate } from '../../lib/datetime.js';

// ═══════════════════════════════════════════════════════════════════════════
// M4 — Super category cards with progress.
//
// The auditor sees SUPER CATEGORIES ONLY. Categories are never a navigation
// level on mobile: they would clutter the flow and confuse the counter.
// Tapping a card goes STRAIGHT to the item list for that super category —
// there is no intermediate category screen. (Categories are still stored on
// every item and appear across the admin console and every report.)
// ═══════════════════════════════════════════════════════════════════════════
export default function SuperCategoryList() {
  const { auditId } = useParams();
  const nav = useNavigate();
  const [groups, setGroups] = useState(null);
  const [audit, setAudit] = useState(null);

  const load = useCallback(() => {
    api.get(`/audits/${auditId}`).then(setAudit);
    // One aggregate query server-side — no per-item loading.
    api.get(`/audits/${auditId}/super-categories`).then(setGroups);
  }, [auditId]);

  useEffect(() => { load(); }, [load]);

  if (!groups) return <Spinner label="Loading…" />;

  const totalCounted = groups.reduce((s, x) => s + x.counted, 0);
  const totalItems = groups.reduce((s, x) => s + x.total, 0);

  return (
    <div className="min-h-full pb-24">
      <MobileHeader
        title={audit?.store_name || 'Audit'}
        subtitle={audit ? `${fmtDate(audit.audit_date)} · cut-off ${audit.cutoff_time || '—'}` : ''}
        back={audit ? `/a/store/${audit.store_id}` : '/a'}
      />
      <div className="p-4 space-y-3">
        <div className="card p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold">Overall progress</span>
            <span className="text-sm text-slate-500">{totalCounted} / {totalItems} counted</span>
          </div>
          <ProgressBar value={totalCounted} total={totalItems} />
        </div>

        {groups.map((g) => (
          <button key={g.id}
                  onClick={() => nav(`/a/audit/${auditId}/super-category/${g.id}`)}
                  className="card w-full text-left p-4 active:scale-[0.99]">
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold">{g.name}</span>
              <span className="text-sm text-slate-500 whitespace-nowrap">
                {g.counted} / {g.total} counted
              </span>
            </div>
            <ProgressBar value={g.counted} total={g.total} />
          </button>
        ))}
      </div>

      <div className="fixed bottom-0 inset-x-0 p-3 bg-gradient-to-t from-slate-100 to-transparent">
        <button className="btn-primary w-full" onClick={() => nav(`/a/audit/${auditId}/submit`)}>
          Review &amp; Submit
        </button>
      </div>
    </div>
  );
}
