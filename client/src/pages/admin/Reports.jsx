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

export default function Reports() {
  const [audits, setAudits] = useState([]);
  const [auditId, setAuditId] = useState('');
  const [report, setReport] = useState('physical-summary');
  const [data, setData] = useState(null);
  const [loadedReport, setLoadedReport] = useState(null); // which report `data` belongs to
  const [loading, setLoading] = useState(false);
  const [consolidateIds, setConsolidateIds] = useState([]);
  const [consolidated, setConsolidated] = useState(null);

  useEffect(() => {
    api.get('/audits').then((a) => { setAudits(a); if (a[0]) setAuditId(String(a[0].id)); });
  }, []);

  useEffect(() => {
    if (!auditId) return;
    setLoading(true); setData(null); setLoadedReport(null);
    const forReport = report;
    api.get(`/reports/${report}/${auditId}`)
      .then((d) => { setData(d); setLoadedReport(forReport); })
      .catch((e) => { setData({ error: e.message }); setLoadedReport(forReport); })
      .finally(() => setLoading(false));
  }, [report, auditId]);

  const store = audits.find((a) => String(a.id) === String(auditId));
  const base = `${report}/${auditId}`;
  const fname = `${report}_${store?.store_code || auditId}`;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-4">Reports</h1>

      <div className="flex flex-wrap gap-2 mb-4">
        <select className="field max-w-xs" value={auditId} onChange={(e) => setAuditId(e.target.value)}>
          {audits.map((a) => <option key={a.id} value={a.id}>{a.store_name} — {new Date(a.audit_date).toLocaleDateString()} ({a.status})</option>)}
        </select>
      </div>

      <div className="flex flex-wrap gap-2 mb-4">
        {REPORTS.map(([k, label]) => (
          <button key={k} className={report === k ? 'chip-on' : 'chip-off'} onClick={() => setReport(k)}>{label}</button>
        ))}
      </div>

      {auditId && (
        <div className="flex gap-2 mb-4">
          <button className="btn-ghost" onClick={() => downloadReport(`/reports/${base}?format=xlsx`, `${fname}.xlsx`)}>⬇ Excel</button>
          <button className="btn-ghost" onClick={() => downloadReport(`/reports/${base}?format=pdf`, `${fname}.pdf`)}>⬇ PDF</button>
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
            <Table cols={['Store', 'Date', 'Status', 'Items', 'Physical value', 'Total variance', 'Critical']}
                   rows={consolidated.rows.map((r) => [r.store_name, new Date(r.audit_date).toLocaleDateString(), r.status, r.items, (r.physical_value || 0).toFixed(2), r.total_variance_qty, r.critical_items])} />
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
          <Table cols={['Section', 'Items', 'Quantity', 'Value']} rows={data.sections.map((s) => [s.section, s.items, s.qty, s.value.toFixed(2)])} /></div>
        <div><h3 className="font-bold mb-2">By category</h3>
          <Table cols={['Section', 'Category', 'Items', 'Quantity', 'Value']} rows={data.categories.map((c) => [c.section, c.category, c.items, c.qty, c.value.toFixed(2)])} /></div>
      </div>
    );
  }
  if (report === 'item-detail') {
    return (
      <div className="space-y-4">
        {data.items.map((it) => (
          <div key={it.item_id}>
            <div className="font-bold">{it.name} <span className="text-slate-400 font-normal">({it.unit})</span></div>
            <Table cols={['Qty', 'Location', 'By', 'Time', 'Status']}
                   rows={it.entries.map((e) => [
                     it.is_liquor ? `${e.bottles ?? 0} btl / ${e.open_ml ?? 0} ml` : Number(e.qty),
                     e.location_text || '—', e.counted_by_name,
                     new Date(e.counted_at).toLocaleTimeString(),
                     e.status === 'void' ? `void: ${e.void_reason || ''}` : 'active'])} />
            <div className="text-sm font-semibold mt-1">Total: {it.is_liquor ? `${it.total_bottles} btl / ${it.total_open_ml} ml` : `${it.total_qty} ${it.unit}`}</div>
          </div>
        ))}
      </div>
    );
  }
  if (report === 'liquor') {
    return (
      <div>
        <Table cols={['Brand', 'Sealed bottles', 'Open (ml)']} rows={data.rows.map((r) => [r.brand, r.sealed_bottles, r.open_ml])} />
        <p className="text-xs text-slate-500 mt-2 italic">{data.footnote}</p>
      </div>
    );
  }
  if (report === 'variance') {
    return <Table cols={['Code', 'Item', 'Physical', 'System', 'Variance', '%', 'Status']}
                  rows={data.rows.map((r) => [r.code, r.name, r.physical_qty, r.system_qty ?? '—', r.variance ?? '—', r.variance_pct ?? '—', r.status])} />;
  }
  if (report === 'exceptions') {
    return (
      <div className="space-y-5 text-sm">
        <Section title="Voided entries" cols={['Code', 'Item', 'Reason', 'Counted by', 'Voided by']}
                 rows={data.voided.map((v) => [v.code, v.name, v.void_reason, v.counted_by_name, v.voided_by_name])} />
        <Section title="Not applicable" cols={['Code', 'Item', 'Reason', 'Marked by']}
                 rows={data.notApplicable.map((v) => [v.code, v.name, v.reason, v.marked_by_name])} />
        <Section title="Multiple entries" cols={['Code', 'Item', 'Entries', 'Physical qty']}
                 rows={data.multiEntry.map((v) => [v.code, v.name, v.entries, v.physical_qty])} />
        <Section title="Zero quantity" cols={['Code', 'Item', 'Zero entries']}
                 rows={data.zeroQty.map((v) => [v.code, v.name, v.zero_entries])} />
        <Section title="Counted without photo" cols={['Code', 'Item', 'Entries']}
                 rows={data.noPhoto.map((v) => [v.code, v.name, v.entries])} />
      </div>
    );
  }
  return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;
}

function Section({ title, cols, rows }) {
  return <div><h3 className="font-bold mb-1">{title}</h3><Table cols={cols} rows={rows} /></div>;
}
