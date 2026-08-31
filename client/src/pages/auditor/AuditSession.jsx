import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { api } from '../../lib/api.js';
import MobileHeader from '../../components/MobileHeader.jsx';
import { Spinner, Empty } from '../../components/ui.jsx';
import { fmtDate } from '../../lib/datetime.js';
import { AuditorStatus } from '../../components/SubmissionState.jsx';

// M3 — Audit session: shows the open audit(s) for the chosen store.
export default function AuditSession() {
  const { storeId } = useParams();
  const nav = useNavigate();
  const [audits, setAudits] = useState(null);
  const [store, setStore] = useState(null);

  useEffect(() => {
    api.get('/stores').then((s) => setStore(s.find((x) => String(x.id) === String(storeId))));
    // Every audit for this store, not just the open ones: after an admin
    // clears a submission the auditor has to be able to SEE that it happened,
    // and a submitted audit must not simply vanish from their screen.
    api.get(`/audits?store_id=${storeId}`).then(setAudits);
  }, [storeId]);

  if (!audits) return <Spinner label="Loading audit…" />;

  return (
    <div className="min-h-full">
      <MobileHeader title={store?.name || 'Audit'} subtitle="Open audit session" back="/a" />
      <div className="p-4 space-y-3">
        {audits.length === 0 && <Empty>No audit for this store yet.<br />Ask the admin to open one.</Empty>}
        {audits.map((a) => (
          <div key={a.id} className="card p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-400">Audit date</div>
                <div className="font-bold text-lg">{fmtDate(a.audit_date)}</div>
              </div>
              <div className="text-right">
                <div className="text-xs uppercase tracking-wide text-slate-400">Cut-off</div>
                <div className="font-semibold">{a.cutoff_time || '—'}</div>
              </div>
            </div>
            <div className="mt-3">
              <AuditorStatus
                state={a.session_state}
                submittedAt={a.submission_at}
                cleared={{ cleared_at: a.cleared_at, cleared_by: a.cleared_by_name }}
                entries={a.live_entries}
                changed={a.changed_since_submit}
              />
            </div>
            {a.status === 'open' ? (
              <button className="btn-primary w-full mt-3" onClick={() => nav(`/a/audit/${a.id}`)}>
                {a.session_state === 'cleared' ? 'Continue — submit again'
                  : a.session_state === 'changed' ? 'Submit again — changes not sent'
                  : 'Continue Counting'}
              </button>
            ) : (
              <button className="btn-ghost w-full mt-3" disabled>
                {a.status === 'closed' ? 'Audit closed' : 'Submitted — no further changes'}
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
