import { useEffect, useState, useCallback } from 'react';
import { api } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import DangerConfirm from '../../components/DangerConfirm.jsx';
import { useToast } from '../../components/Toast.jsx';

const fmtWhen = (t) => (t ? new Date(t).toLocaleString() : '—');

// Admin → Data management. Every action here is destructive, admin-only,
// typed-confirmation gated, and written to the activity log.
export default function DataManagement() {
  const [tab, setTab] = useState('actions');
  return (
    <div>
      <h1 className="text-2xl font-bold mb-1">Data management</h1>
      <p className="text-slate-500 mb-4">
        Destructive operations. Each requires a typed confirmation and is recorded in the activity log.
      </p>
      <div className="flex gap-2 mb-5">
        {[['actions', 'Actions'], ['log', 'Activity log']].map(([k, l]) => (
          <button key={k} className={tab === k ? 'chip-on' : 'chip-off'} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'actions' ? <Actions /> : <ActivityLog />}
    </div>
  );
}

function Actions() {
  const [impact, setImpact] = useState(null);
  const [demo, setDemo] = useState(null);
  const [audits, setAudits] = useState([]);
  const [dialog, setDialog] = useState(null);   // { kind, ... }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();

  const load = useCallback(() => Promise.all([
    api.get('/data/item-master/impact').then(setImpact),
    api.get('/data/demo').then(setDemo),
    api.get('/audits').then(setAudits),
  ]), []);
  useEffect(() => { load(); }, [load]);

  async function run(fn, successMsg) {
    setBusy(true); setError('');
    try {
      const r = await fn();
      toast(successMsg(r));
      setDialog(null);
      await load();
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  if (!impact || !demo) return <Spinner />;

  return (
    <div className="space-y-4">
      {/* Demo data */}
      <Card title="Demo data"
            body={demo.present
              ? `${demo.users} users · ${demo.stores} stores · ${demo.items} items · ${demo.audits} audits · ${demo.entries} entries`
              : 'No demo records present.'}
            tone={demo.present ? 'amber' : 'ok'}>
        {demo.present && (
          <button className="btn-danger" onClick={() => { setError(''); setDialog({ kind: 'demo' }); }}>
            Delete demo data
          </button>
        )}
      </Card>

      {/* Item master */}
      <Card title="Item master"
            body={`${impact.total_items} item(s), ${impact.active_items} active, ${impact.with_photos} with photos.`}
            tone={impact.blocked ? 'blocked' : 'normal'}>
        {impact.blocked
          ? <p className="text-sm text-slate-600">{impact.blockedReason}</p>
          : (
            <button className="btn-danger" onClick={() => { setError(''); setDialog({ kind: 'items' }); }}>
              Delete all items
            </button>
          )}
      </Card>

      {/* Audits */}
      <div className="card p-4">
        <h3 className="font-bold mb-1">Audits</h3>
        <p className="text-sm text-slate-500 mb-3">
          Clearing entries keeps the audit open and resets it to zero counted. Deleting removes the
          audit with its entries and system stock. The item master is untouched by both.
        </p>
        <div className="divide-y">
          {audits.map((a) => (
            <div key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="text-sm">
                <strong>{a.store_name}</strong> — {new Date(a.audit_date).toLocaleDateString()}
                <span className="text-slate-400"> ({a.status})</span>
                {a.is_demo && <span className="ml-2 chip bg-amber-100 text-amber-700 border-amber-200">demo</span>}
              </span>
              <span className="flex gap-2">
                <button className="btn-ghost text-sm py-1.5"
                        onClick={async () => {
                          setError('');
                          const imp = await api.get(`/data/audits/${a.id}/impact`);
                          setDialog({ kind: 'clear', audit: a, imp });
                        }}>Clear entries</button>
                <button className="btn-ghost text-sm py-1.5 text-red-600 border-red-200"
                        onClick={async () => {
                          setError('');
                          const imp = await api.get(`/data/audits/${a.id}/impact`);
                          setDialog({ kind: 'deleteAudit', audit: a, imp });
                        }}>Delete audit</button>
              </span>
            </div>
          ))}
          {audits.length === 0 && <p className="text-slate-400 py-3">No audits.</p>}
        </div>
      </div>

      {/* ── Dialogs ── */}
      <DangerConfirm
        open={dialog?.kind === 'demo'} phrase="DELETE DEMO DATA"
        title="Delete all demo data?"
        impact={<>This will remove <strong>{demo.users} users, {demo.stores} stores, {demo.items} items,
          {' '}{demo.audits} audits and {demo.entries} count entries</strong> that were created by
          the demo seed.</>}
        warning="Only rows flagged as demo are removed — real data and anything created through the UI or CSV import is untouched. Your own account is never deleted, so if you are signed in as a demo user it will remain."
        confirmLabel="Delete demo data" busy={busy} error={error}
        onCancel={() => setDialog(null)}
        onConfirm={() => run(
          () => api.post('/data/demo/delete', { confirm: 'DELETE DEMO DATA' }),
          (r) => `Removed ${r.users} users, ${r.stores} stores, ${r.items} items, ${r.audits} audits, ${r.entries} entries`
            + (r.selfKept ? ' — your own demo account was kept so you stay signed in' : '')
        )}
      />

      <DangerConfirm
        open={dialog?.kind === 'items'} phrase="DELETE ALL ITEMS"
        title="Delete the entire item master?"
        impact={<>This will permanently delete <strong>{impact.total_items} items</strong>
          {impact.with_photos > 0 && <> and remove {impact.with_photos} photo(s) from object storage</>}.</>}
        warning="This cannot be undone."
        confirmLabel="Delete all items" busy={busy} error={error}
        onCancel={() => setDialog(null)}
        onConfirm={() => run(
          () => api.post('/data/item-master/delete-all', { confirm: 'DELETE ALL ITEMS' }),
          (r) => `Deleted ${r.deleted} items, removed ${r.photosRemoved} photo(s)`
        )}
      />

      <DangerConfirm
        open={dialog?.kind === 'clear'} phrase="CLEAR ALL ENTRIES"
        title={`Clear all count entries for ${dialog?.audit?.store_name}?`}
        impact={<>This will remove <strong>{dialog?.imp?.entries} count entries</strong>
          {dialog?.imp?.entry_photos > 0 && <> and {dialog.imp.entry_photos} entry photo(s)</>}.
          The audit stays open and resets to zero counted.</>}
        warning="The item master and this audit's system stock are not affected."
        confirmLabel="Clear entries" busy={busy} error={error}
        onCancel={() => setDialog(null)}
        onConfirm={() => run(
          () => api.post(`/data/audits/${dialog.audit.id}/clear-entries`, { confirm: 'CLEAR ALL ENTRIES' }),
          (r) => `Cleared ${r.entries} entries`
        )}
      />

      <DangerConfirm
        open={dialog?.kind === 'deleteAudit'} phrase="DELETE THIS AUDIT"
        title={`Delete the ${dialog?.audit?.store_name} audit?`}
        impact={<>This will delete the audit together with <strong>{dialog?.imp?.entries} count
          entries</strong> and <strong>{dialog?.imp?.system_rows} system stock rows</strong>.</>}
        warning="The item master is not affected. This cannot be undone."
        confirmLabel="Delete audit" busy={busy} error={error}
        onCancel={() => setDialog(null)}
        onConfirm={() => run(
          () => api.post(`/data/audits/${dialog.audit.id}/delete`, { confirm: 'DELETE THIS AUDIT' }),
          (r) => `Audit deleted (${r.entries} entries removed)`
        )}
      />
    </div>
  );
}

function Card({ title, body, tone = 'normal', children }) {
  const ring = tone === 'amber' ? 'border-amber-300 bg-amber-50'
    : tone === 'blocked' ? 'border-slate-200 bg-slate-50'
    : tone === 'ok' ? 'border-green-200 bg-green-50' : 'border-slate-200';
  return (
    <div className={`card p-4 border ${ring}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="font-bold">{title}</h3>
          <p className="text-sm text-slate-600">{body}</p>
        </div>
        <div>{children}</div>
      </div>
    </div>
  );
}

// ── (6) Read-only activity log ─────────────────────────────────────────────
function ActivityLog() {
  const [rows, setRows] = useState(null);
  useEffect(() => { api.get('/data/activity?limit=300').then(setRows); }, []);
  if (!rows) return <Spinner />;

  return (
    <div>
      <p className="text-sm text-slate-500 mb-2">
        Newest first. This log is read-only and cannot be deleted from the application.
      </p>
      <div className="card overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-slate-500"><tr>
            <th className="px-4 py-3">When</th><th className="px-4 py-3">User</th>
            <th className="px-4 py-3">Action</th><th className="px-4 py-3">Target</th>
            <th className="px-4 py-3 text-right">Records</th><th className="px-4 py-3">Details</th>
          </tr></thead>
          <tbody className="divide-y">
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="px-4 py-2 whitespace-nowrap">{fmtWhen(a.created_at)}</td>
                <td className="px-4 py-2">{a.user_name || '—'}</td>
                <td className="px-4 py-2 font-mono text-xs">{a.action}</td>
                <td className="px-4 py-2 text-slate-500">
                  {a.target_type}{a.target_id ? ` #${a.target_id}` : ''}
                </td>
                <td className="px-4 py-2 text-right font-semibold">{a.record_count ?? '—'}</td>
                <td className="px-4 py-2 text-xs text-slate-500 max-w-md truncate"
                    title={JSON.stringify(a.details)}>
                  {JSON.stringify(a.details)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-slate-400">No activity recorded yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
