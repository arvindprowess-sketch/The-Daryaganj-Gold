import { useEffect, useState, useCallback, Fragment } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import { fmtDate, fmtDateTime } from '../../lib/datetime.js';
import DangerConfirm from '../../components/DangerConfirm.jsx';
import { StateChip } from '../../components/SubmissionState.jsx';

// D4 — Audit sessions: create (store + date + cut-off), monitor, close.
export default function AuditSessions() {
  const [audits, setAudits] = useState(null);
  const [stores, setStores] = useState([]);
  const [f, setF] = useState({ store_id: '', audit_date: new Date().toISOString().slice(0, 10), cutoff_time: '6:00 PM' });
  const [err, setErr] = useState('');
  // "Clear submitted data" — removes the SNAPSHOT, never the count entries.
  const [clearing, setClearing] = useState(null);   // { audit, preview, all }
  const [panels, setPanels] = useState({});         // auditId -> per-auditor rows
  const [overlaps, setOverlaps] = useState({});     // auditId -> overlap count
  const [clearErr, setClearErr] = useState('');
  const [busy, setBusy] = useState(false);

  // The per-auditor panel and the overlap warning are per audit, so they are
  // fetched alongside the list rather than folded into it — one extra request
  // each, and the list stays a simple query.
  const load = useCallback(async () => {
    const rows = await api.get('/audits');
    setAudits(rows);
    const p = {}; const o = {};
    await Promise.all(rows.map(async (a) => {
      try { p[a.id] = (await api.get(`/audits/${a.id}/submission`)).auditors || []; } catch { p[a.id] = []; }
      try { o[a.id] = (await api.get(`/reports/exceptions/${a.id}`)).overlaps || []; } catch { o[a.id] = []; }
    }));
    setPanels(p); setOverlaps(o);
  }, []);
  useEffect(() => { load(); api.get('/stores').then(setStores); }, [load]);

  async function create() {
    setErr('');
    if (!f.store_id) { setErr('Choose a store'); return; }
    try { await api.post('/audits', f); load(); } catch (e) { setErr(e.message); }
  }
  // Clearing names the auditor. Only their rows leave the reports.
  async function askClear(a, userId) {
    setClearErr('');
    try {
      const preview = await api.get(`/audits/${a.id}/clear-submission/preview?user_id=${userId}`);
      setClearing({ audit: a, preview, userId, all: false });
    } catch (e) { setErr(e.message); }
  }
  // Resetting the whole store is a separate action with its own phrase —
  // wiping every auditor's work should not be one click away from clearing one.
  async function askClearAll(a) {
    setClearErr('');
    try {
      const preview = await api.get(`/audits/${a.id}/clear-all-submissions/preview`);
      setClearing({ audit: a, preview, all: true });
    } catch (e) { setErr(e.message); }
  }
  async function doClear() {
    setBusy(true); setClearErr('');
    try {
      if (clearing.all) {
        await api.post(`/audits/${clearing.audit.id}/clear-all-submissions`,
          { confirm: 'CLEAR ALL SUBMITTED DATA' });
      } else {
        await api.post(`/audits/${clearing.audit.id}/clear-submission`,
          { confirm: 'CLEAR SUBMITTED DATA', user_id: clearing.userId });
      }
      setClearing(null); await load();
    } catch (e) { setClearErr(e.message); } finally { setBusy(false); }
  }
  // An admin's own counts reach no report until they are submitted, exactly
  // like an auditor's. Without this the entries just sat there.
  async function submitMine(a) {
    if (!confirm('Submit your own count entries for this store?\n\n'
      + 'They will appear in the reports alongside whoever else has submitted.')) return;
    setErr('');
    try { await api.post(`/audits/${a.id}/submit`); await load(); }
    catch (e) { setErr(e.message); }
  }
  async function close(a) {
    if (!confirm(`Close audit for ${a.store_name}? Auditors can no longer add entries.`)) return;
    await api.post(`/audits/${a.id}/close`); load();
  }

  if (!audits) return <Spinner />;
  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Audit sessions</h1>
      <div className="card p-4 mb-5 flex flex-wrap items-end gap-3">
        <label className="block"><span className="text-sm text-slate-600">Store</span>
          <select className="field mt-1" value={f.store_id} onChange={(e) => setF({ ...f, store_id: e.target.value })}>
            <option value="">Select…</option>{stores.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></label>
        <label className="block"><span className="text-sm text-slate-600">Date</span>
          <input type="date" className="field mt-1" value={f.audit_date} onChange={(e) => setF({ ...f, audit_date: e.target.value })} /></label>
        <label className="block"><span className="text-sm text-slate-600">Cut-off time</span>
          <input className="field mt-1" value={f.cutoff_time} onChange={(e) => setF({ ...f, cutoff_time: e.target.value })} /></label>
        <button className="btn-primary" onClick={create}>Create audit</button>
        {err && <p className="text-red-600 text-sm w-full">{err}</p>}
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-4 py-3">Store</th><th className="px-4 py-3">Date</th>
            <th className="px-4 py-3">Cut-off</th><th className="px-4 py-3">Status</th>
            <th className="px-4 py-3">Actions</th></tr></thead>
          <tbody className="divide-y">
            {audits.map((a) => (
              <Fragment key={a.id}>
              <tr>
                <td className="px-4 py-2 font-medium">{a.store_name}</td>
                <td className="px-4 py-2">{fmtDate(a.audit_date)}</td>
                <td className="px-4 py-2">{a.cutoff_time || '—'}</td>
                <td className="px-4 py-2">
                  <StateChip state={a.session_state} />
                  {a.status === 'closed' && (
                    <div className="text-[11px] text-slate-500 mt-0.5">audit closed</div>
                  )}
                  {a.session_state === 'submitted' && (
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {a.submission_items} items · {fmtDateTime(a.submission_at)}
                    </div>
                  )}
                  {a.session_state === 'cleared' && (
                    <div className="text-[11px] text-orange-700 mt-0.5">
                      cleared {fmtDateTime(a.cleared_at)}
                      {a.cleared_by_name ? ` by ${a.cleared_by_name}` : ''} — count intact
                    </div>
                  )}
                  {a.session_state === 'changed' && (
                    <div className="text-[11px] text-red-700 font-medium mt-0.5">
                      {a.changed_since_submit} change{a.changed_since_submit === 1 ? '' : 's'} since
                      {' '}{fmtDateTime(a.submission_at)} — not in the reports
                    </div>
                  )}
                  {a.session_state === 'counting' && (
                    <div className="text-[11px] text-amber-600 mt-0.5">variance provisional</div>
                  )}
                </td>
                <td className="px-4 py-2">
                  <div className="flex flex-wrap gap-3">
                    <Link className="text-brand font-medium" to={`/admin/audits/${a.id}/count`}>Count entry</Link>
                    <Link className="text-brand font-medium" to={`/admin/audits/${a.id}/system-stock`}>System stock</Link>
                    {a.submitted_count > 1 && (
                      <button className="text-red-600 font-medium" onClick={() => askClearAll(a)}>
                        Clear all submitted data
                      </button>
                    )}
                    {a.status !== 'closed' && <button className="text-red-600 font-medium" onClick={() => close(a)}>Close</button>}
                  </div>
                </td>
              </tr>

              {/* ── Who is counting this store, and where each has got to ──
                  Each auditor works from their own sheet, so the store's state
                  is not one thing any more — it is one line per person. */}
              <tr>
                <td colSpan={5} className="px-4 pb-3 pt-0">
                  {overlaps[a.id]?.length > 0 && (
                    <div className="mb-2 rounded-lg border-2 border-amber-400 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                      <span className="font-bold">
                        {overlaps[a.id].length} item{overlaps[a.id].length === 1 ? ' was' : 's were'} counted
                        at the same location by more than one auditor
                      </span>
                      {' '}— review before issuing the report. Their quantities are added together.{' '}
                      <Link className="underline font-medium" to="/admin/reports">See the Overlap section in R6</Link>
                    </div>
                  )}
                  <div className="rounded-lg border divide-y bg-white">
                    {(panels[a.id] || []).length === 0 && (
                      <div className="px-3 py-2 text-sm text-slate-400">No auditors assigned to this store.</div>
                    )}
                    {(panels[a.id] || []).map((p) => (
                      <div key={p.user_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2 text-sm">
                        <span className="font-medium w-40">
                          {p.name}
                          {p.role === 'admin' && <span className="text-slate-400 font-normal"> (admin)</span>}
                        </span>
                        <span className="text-slate-600 w-24 tabular-nums">
                          {p.state === 'submitted' || p.state === 'changed'
                            ? p.item_count : p.live_items} items
                        </span>
                        <span className={p.state === 'submitted' ? 'text-blue-700 font-medium'
                          : p.state === 'changed' ? 'text-red-700 font-semibold'
                          : p.state === 'cleared' ? 'text-orange-700 font-medium' : 'text-amber-700'}>
                          {p.state === 'submitted' ? `Submitted ${fmtDateTime(p.submitted_at)}`
                            : p.state === 'changed' ? `Submitted ${fmtDateTime(p.submitted_at)} — changed since`
                            : p.state === 'cleared' ? `Cleared ${fmtDateTime(p.cleared_at)}${p.cleared_by_name ? ` by ${p.cleared_by_name}` : ''} — can submit again`
                            : 'Still counting'}
                        </span>
                        {/* Counted, but in no standing submission — so in no
                            report. Either they never submitted, or they carried
                            on afterwards and their submission is now out of
                            date. Both mean the same thing to the reader: these
                            entries are not in the figures. */}
                        {p.unsubmitted > 0 && (
                          <span className={p.state === 'changed' ? 'text-red-700 font-medium' : 'text-orange-700'}>
                            {p.changed_since_submit
                              ? `${p.changed_since_submit.added} new, ${p.changed_since_submit.removed} voided since submitting — not in any report`
                              : `${p.unsubmitted} entr${p.unsubmitted === 1 ? 'y is' : 'ies are'} not in any report yet`}
                          </span>
                        )}
                        <span className="ml-auto flex gap-3">
                          {p.role === 'admin' && p.unsubmitted > 0 && (
                            <button className="text-brand font-medium"
                                    onClick={() => submitMine(a)}>
                              {p.state === 'changed' ? 'Re-submit mine' : 'Submit mine'}
                            </button>
                          )}
                          {(p.state === 'submitted' || p.state === 'changed') && (
                            <button className="text-red-600 font-medium"
                                    onClick={() => askClear(a, p.user_id)}>Clear</button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </td>
              </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <DangerConfirm
        open={!!clearing}
        title="Clear submitted data"
        phrase="CLEAR SUBMITTED DATA"
        impact={clearing?.preview?.message}
        warning={"The auditor's count entries, their photos, the item master and system stock are not touched. "
          + 'The audit reopens so the count can be submitted again.'}
        confirmLabel="Clear submitted data"
        busy={busy}
        error={clearErr}
        onCancel={() => setClearing(null)}
        onConfirm={doClear}
      />
    </div>
  );
}
