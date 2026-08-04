import { useEffect, useState } from 'react';
import { api, downloadReport } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';

const REPORTS = [
  ['physical-summary', 'R1 Physical Summary'],
  ['item-detail', 'R2 Item Detail'],
  ['liquor', 'R3 Liquor'],
  ['variance', 'R4 Variance'],
  ['exceptions', 'R6 Exceptions'],
];

// Reports are the client deliverable: TOTALS ONLY, one line per item.
// The per-entry breakdown lives on the admin count-entry screen.
export default function Reports() {
  const [audits, setAudits] = useState([]);
  const [auditId, setAuditId] = useState('');
  const [report, setReport] = useState('physical-summary');
  const [data, setData] = useState(null);
  const [loadedReport, setLoadedReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [vFilter, setVFilter] = useState('all'); // variance: all | counted
  const [consolidateIds, setConsolidateIds] = useState([]);
  const [consolidated, setConsolidated] = useState(null);

  useEffect(() => {
    api.get('/audits').then((a) => { setAudits(a); if (a[0]) setAuditId(String(a[0].id)); });
  }, []);

  useEffect(() => {
    if (!auditId) return;
    setLoading(true); setData(null); setLoadedReport(null);
    const forReport = report;
    const qs = report === 'variance' && vFilter === 'counted' ? '?filter=counted' : '';
    api.get(`/reports/${report}/${auditId}${qs}`)
      .then((d) => { setData(d); setLoadedReport(forReport); })
      .catch((e) => { setData({ error: e.message }); setLoadedReport(forReport); })
      .finally(() => setLoading(false));
  }, [report, auditId, vFilter]);

  const store = audits.find((a) => String(a.id) === String(auditId));
  const filterQs = report === 'variance' && vFilter === 'counted' ? '&filter=counted' : '';
  const base = `${report}/${auditId}`;
  const provisional = report === 'variance' && data?.provisional;
  const fname = `${provisional ? 'PROVISIONAL_' : ''}${report}_${(store?.store_name || auditId).replace(/\W+/g, '_')}`;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Reports</h1>

      <div className="flex flex-wrap gap-2 mb-4">
        <select className="field max-w-md" value={auditId} onChange={(e) => setAuditId(e.target.value)}>
          {audits.map((a) => (
            <option key={a.id} value={a.id}>
              {a.store_name} — {new Date(a.audit_date).toLocaleDateString()} ({a.status})
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {REPORTS.map(([k, label]) => (
          <button key={k} className={report === k ? 'chip-on' : 'chip-off'} onClick={() => setReport(k)}>{label}</button>
        ))}
      </div>

      {/* PROVISIONAL banner — variance mid-count is misleading because every
          uncounted item reads as a 100% shortage. */}
      {provisional && data?.progress && (
        <div className="mb-4 rounded-xl border-2 border-amber-400 bg-amber-50 px-4 py-3">
          <div className="font-bold text-amber-800">PROVISIONAL — count in progress.</div>
          <div className="text-amber-800 text-sm">
            {data.progress.uncounted} of {data.progress.total} items not yet counted. Uncounted items
            appear as full shortages until they are counted.
          </div>
        </div>
      )}

      {report === 'variance' && (
        <div className="flex gap-2 mb-4">
          <button className={vFilter === 'all' ? 'chip-on' : 'chip-off'} onClick={() => setVFilter('all')}>All items</button>
          <button className={vFilter === 'counted' ? 'chip-on' : 'chip-off'} onClick={() => setVFilter('counted')}>Counted only</button>
        </div>
      )}

      {auditId && (
        <div className="flex gap-2 mb-4">
          <button className="btn-ghost" onClick={() => downloadReport(`/reports/${base}?format=xlsx${filterQs}`, `${fname}.xlsx`)}>⬇ Excel</button>
          <button className="btn-ghost" onClick={() => downloadReport(`/reports/${base}?format=pdf${filterQs}`, `${fname}.pdf`)}>⬇ PDF</button>
          {provisional && <span className="self-center text-xs text-amber-700">Exports are stamped PROVISIONAL.</span>}
        </div>
      )}

      <div className="card p-4 overflow-x-auto">
        {loading || (data && loadedReport !== report)
          ? <Spinner />
          : data ? <ReportView report={loadedReport} data={data} /> : <p className="text-slate-400">Select a report.</p>}
      </div>

      {/* R5 Consolidated */}
      <div className="mt-8">
        <h2 className="text-xl font-bold mb-2">R5 — Consolidated (all stores)</h2>
        <div className="flex flex-wrap gap-2 mb-3">
          {audits.map((a) => (
            <button key={a.id} className={consolidateIds.includes(a.id) ? 'chip-on' : 'chip-off'}
                    onClick={() => setConsolidateIds((p) => p.includes(a.id) ? p.filter((x) => x !== a.id) : [...p, a.id])}>
              {a.store_name} {new Date(a.audit_date).toLocaleDateString()}
            </button>
          ))}
        </div>
        <div className="flex gap-2 mb-3">
          <button className="btn-primary" disabled={!consolidateIds.length}
                  onClick={() => api.get(`/reports/consolidated?audit_ids=${consolidateIds.join(',')}`).then(setConsolidated)}>
            Build consolidated
          </button>
          {consolidateIds.length > 0 && (
            <>
              <button className="btn-ghost" onClick={() => downloadReport(`/reports/consolidated?audit_ids=${consolidateIds.join(',')}&format=xlsx`, 'R5_consolidated.xlsx')}>⬇ Excel</button>
              <button className="btn-ghost" onClick={() => downloadReport(`/reports/consolidated?audit_ids=${consolidateIds.join(',')}&format=pdf`, 'R5_consolidated.pdf')}>⬇ PDF</button>
            </>
          )}
        </div>
        {consolidated && (
          <div className="card p-4 overflow-x-auto">
            {consolidated.provisional && (
              <div className="mb-3 rounded-lg bg-amber-50 border border-amber-300 px-3 py-2 text-sm font-semibold text-amber-800">
                PROVISIONAL — one or more audits are still in progress.
              </div>
            )}
            <Table cols={['Store', 'Date', 'Status', 'Items', 'Uncounted', 'Physical value', 'Total variance', 'Critical']}
                   rows={consolidated.rows.map((r) => [r.store_name, new Date(r.audit_date).toLocaleDateString(),
                     r.status, r.items, r.uncounted, (r.physical_value || 0).toFixed(2), r.total_variance_qty, r.critical_items])} />
          </div>
        )}
      </div>
    </div>
  );
}

function Table({ cols, rows }) {
  return (
    <table className="w-full text-sm">
      <thead className="bg-slate-50 text-left text-slate-500"><tr>{cols.map((c) => <th key={c} className="px-3 py-2">{c}</th>)}</tr></thead>
      <tbody className="divide-y">
        {rows.map((r, i) => <tr key={i}>{r.map((c, j) => <td key={j} className="px-3 py-2">{c}</td>)}</tr>)}
        {rows.length === 0 && <tr><td colSpan={cols.length} className="p-6 text-center text-slate-400">No data.</td></tr>}
      </tbody>
    </table>
  );
}

function ReportView({ report, data }) {
  if (data.error) return <p className="text-red-600">{data.error}</p>;

  if (report === 'physical-summary') {
    return (
      <div className="space-y-6">
        <div><h3 className="font-bold mb-2">By section</h3>
          <Table cols={['Section', 'Items', 'Quantity', 'Value']}
                 rows={data.sections.map((s) => [s.section, s.items, s.qty, s.value.toFixed(2)])} /></div>
        <div><h3 className="font-bold mb-2">By category</h3>
          <Table cols={['Section', 'Category', 'Items', 'Quantity', 'Value']}
                 rows={data.categories.map((c) => [c.section, c.category, c.items, c.qty, c.value.toFixed(2)])} /></div>
      </div>
    );
  }

  // R2 — one line per item carrying the total. No per-entry lines, no
  // redundant "<item> Total" row.
  if (report === 'item-detail') {
    return (
      <Table cols={['Item', 'Section', 'Category', 'Unit', 'Total quantity', 'Open (ml)']}
             rows={data.rows.map((r) => [
               r.name, r.section, r.category, r.unit,
               r.not_applicable ? 'N/A' : (r.is_liquor ? r.total_bottles : r.total_qty),
               r.is_liquor ? r.total_open_ml : '',
             ])} />
    );
  }

  if (report === 'liquor') {
    return (
      <div>
        <Table cols={['Brand', 'Sealed bottles', 'Open (ml)']}
               rows={data.rows.map((r) => [r.brand, r.sealed_bottles, r.open_ml])} />
        <p className="text-xs text-slate-500 mt-2 italic">{data.footnote}</p>
      </div>
    );
  }

  if (report === 'variance') {
    return (
      <Table cols={['Item', 'Unit', 'Physical', 'System', 'Variance', '%', 'Counted', 'Status']}
             rows={data.rows.map((r) => [r.name, r.unit, r.physical_qty, r.system_qty ?? '—',
               r.variance ?? '—', r.variance_pct ?? '—', r.counted ? 'Yes' : 'No', r.status])} />
    );
  }

  if (report === 'exceptions') {
    return (
      <div className="space-y-5 text-sm">
        <Section title="Voided entries" cols={['Item', 'Reason', 'Counted by', 'Voided by']}
                 rows={data.voided.map((v) => [v.name, v.void_reason, v.counted_by_name, v.voided_by_name])} />
        <Section title="Not applicable" cols={['Item', 'Reason', 'Marked by']}
                 rows={data.notApplicable.map((v) => [v.name, v.reason, v.marked_by_name])} />
        <Section title="Multiple entries" cols={['Item', 'Entries', 'Physical qty']}
                 rows={data.multiEntry.map((v) => [v.name, v.entries, v.physical_qty])} />
        <Section title="Zero quantity" cols={['Item', 'Zero entries']}
                 rows={data.zeroQty.map((v) => [v.name, v.zero_entries])} />
        <Section title="Counted without photo" cols={['Item', 'Entries']}
                 rows={data.noPhoto.map((v) => [v.name, v.entries])} />
      </div>
    );
  }
  return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;
}

function Section({ title, cols, rows }) {
  return <div><h3 className="font-bold mb-1">{title}</h3><Table cols={cols} rows={rows} /></div>;
}
