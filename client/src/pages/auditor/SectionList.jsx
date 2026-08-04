import { useEffect, useState, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { Spinner, ProgressBar } from '../../components/ui.jsx';

// M4 — Section list: cards with progress bars (counted / total).
export default function SectionList() {
  const { auditId } = useParams();
  const nav = useNavigate();
  const [sections, setSections] = useState(null);
  const [audit, setAudit] = useState(null);

  const load = useCallback(() => {
    api.get(`/audits/${auditId}`).then(setAudit);
    api.get(`/audits/${auditId}/sections`).then(setSections);
  }, [auditId]);

  useEffect(() => { load(); }, [load]);

  if (!sections) return <Spinner label="Loading sections…" />;

  const totalCounted = sections.reduce((s, x) => s + x.counted, 0);
  const totalItems = sections.reduce((s, x) => s + x.total, 0);

  return (
    <div className="min-h-full pb-24">
      <MobileHeader
        title={audit?.store_name || 'Audit'}
        subtitle={audit ? `${new Date(audit.audit_date).toLocaleDateString()} · cut-off ${audit.cutoff_time || '—'}` : ''}
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

        {sections.map((s) => (
          <button key={s.id} onClick={() => nav(`/a/audit/${auditId}/section/${s.id}`)}
                  className="card w-full text-left p-4 active:scale-[0.99]">
            <div className="flex items-center justify-between mb-2">
              <span className="font-bold">{s.name}</span>
              <span className="text-sm text-slate-500">{s.counted} / {s.total} counted</span>
            </div>
            <ProgressBar value={s.counted} total={s.total} />
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
