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
  const [vSuper, setVSuper] = useState('');         // variance: super category filter
  const [vCategory, setVCategory] = useState('');   // variance: category filter
  const [vGroup, setVGroup] = useState(false);      // variance: group by category
  const [categories, setCategories] = useState([]);
  const [supers, setSupers] = useState([]);
  const [consolidateIds, setConsolidateIds] = useState([]);
  const [consolidated, setConsolidated] = useState(null);

  useEffect(() => {
    api.get('/audits').then((a) => { setAudits(a); if (a[0]) setAuditId(String(a[0].id)); });
    api.get('/meta/categories').then(setCategories);
    api.get('/meta/super-categories').then(setSupers);
  }, []);

  // Variance-only query params (filter / category / grouping) shared by the
  // on-screen view and the Excel + PDF exports so they always agree.
  const varianceParams = report === 'variance'
    ? [
        vFilter === 'counted' ? 'filter=counted' : '',
        vSuper ? `super_category_id=${vSuper}` : '',
        vCategory ? `category_id=${vCategory}` : '',
        vGroup ? 'group_by=category' : '',
      ].filter(Boolean)
    : [];

  useEffect(() => {
    if (!auditId) return;
    setLoading(true); setData(null); setLoadedReport(null);
    const forReport = report;
    const qs = varianceParams.length ? `?${varianceParams.join('&')}` : '';
    api.get(`/reports/${report}/${auditId}${qs}`)
      .then((d) => { setData(d); setLoadedReport(forReport); })
      .catch((e) => { setData({ error: e.message }); setLoadedReport(forReport); })
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, auditId, vFilter, vSuper, vCategory, vGroup]);

  const store = audits.find((a) => String(a.id) === String(auditId));
  const filterQs = varianceParams.length ? `&${varianceParams.join('&')}` : '';
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
        <div className="flex flex-wrap items-center gap-2 mb-4">
          <button className={vFilter === 'all' ? 'chip-on' : 'chip-off'} onClick={() => setVFilter('all')}>All items</button>
          <button className={vFilter === 'counted' ? 'chip-on' : 'chip-off'} onClick={() => setVFilter('counted')}>Counted only</button>
          <select className="field py-2 max-w-[220px]" value={vSuper}
                  onChange={(e) => { setVSuper(e.target.value); setVCategory(''); }}>
            <option value="">All super categories</option>
            {supers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select className="field py-2 max-w-[220px]" value={vCategory} onChange={(e) => setVCategory(e.target.value)}>
            <option value="">All categories</option>
            {(vSuper ? categories.filter((c) => String(c.super_category_id) === String(vSuper)) : categories)
              .map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <label className="flex items-center gap-2 text-sm text-slate-600 select-none">
            <input type="checkbox" className="h-5 w-5 accent-teal-700"
                   checked={vGroup} onChange={(e) => setVGroup(e.target.checked)} />
            Group &amp; subtotal by hierarchy
          </label>
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
          : data ? <ReportView report={loadedReport} data={data} grouped={vGroup} /> : <p className="text-slate-400">Select a report.</p>}
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
            <h3 className="font-bold mb-2">By store</h3>
            <Table cols={['Store', 'Date', 'Status', 'Items', 'Uncounted', 'Physical value', 'Total variance', 'Critical']}
                   rows={consolidated.rows.map((r) => [r.store_name, new Date(r.audit_date).toLocaleDateString(),
                     r.status, r.items, r.uncounted, (r.physical_value || 0).toFixed(2), r.total_variance_qty, r.critical_items])} />
            {/* Super-category-level comparison across stores. */}
            <h3 className="font-bold mt-6 mb-2">By super category</h3>
            <Table cols={['Super Category', 'Store', 'Items', 'Physical', 'System', 'Variance', 'Value']}
                   rows={(consolidated.superCategories || []).map((r) => [
                     r.super_category, r.store_name, r.items, r.physical_qty,
                     r.system_qty, r.variance, (r.value || 0).toFixed(2)])} />
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

function ReportView({ report, data, grouped }) {
  if (data.error) return <p className="text-red-600">{data.error}</p>;

  // R1 — grouped super category → category, with a subtotal per category, a
  // subtotal per super category, and a grand total.
  if (report === 'physical-summary') {
    return (
      <div className="space-y-6">
        {data.groups.map((g) => (
          <div key={g.super_category}>
            <h3 className="font-bold mb-2">{g.super_category}</h3>
            <Table cols={['Category', 'Items', 'Quantity', 'Value']} rows={[
              ...g.categories.map((c) => [c.category, c.items, c.qty, c.value.toFixed(2)]),
              ['SUBTOTAL', g.items, g.qty, g.value.toFixed(2)],
            ]} />
          </div>
        ))}
        <div className="rounded-xl bg-slate-100 px-4 py-3 font-bold text-slate-800">
          Grand total — {data.grand.items} items · quantity {data.grand.qty} · value {data.grand.value.toFixed(2)}
        </div>
      </div>
    );
  }

  // R2 — one line per item carrying the total. No per-entry lines, no
  // redundant "<item> Total" row.
  if (report === 'item-detail') {
    return (
      <Table cols={['Super Category', 'Category', 'Item Name', 'Unit', 'Total quantity', 'Open (ml)']}
             rows={data.rows.map((r) => [
               r.super_category, r.category, r.name, r.unit,
               r.not_applicable ? 'N/A' : (r.is_liquor ? r.total_bottles : r.total_qty),
               r.is_liquor ? r.total_open_ml : '',
             ])} />
    );
  }

  if (report === 'liquor') {
    return (
      <div>
        <Table cols={['Super Category', 'Category', 'Brand', 'Unit', 'Sealed bottles', 'Open (ml)']}
               rows={data.rows.map((r) => [r.super_category, r.category, r.brand, r.unit,
                 r.sealed_bottles, r.open_ml])} />
        <p className="text-xs text-slate-500 mt-2 italic">{data.footnote}</p>
      </div>
    );
  }

  // R4 — super category AND category included, exactly as in the item master.
  // Optionally grouped with subtotals at category and super category level.
  if (report === 'variance') {
    const cols = ['Super Category', 'Category', 'Item Name', 'Unit', 'Physical', 'System', 'Variance', '%', 'Counted', 'Status'];
    const toRow = (r) => [r.super_category, r.category, r.name, r.unit, r.physical_qty,
                          r.system_qty ?? '—', r.variance ?? '—', r.variance_pct ?? '—',
                          r.counted ? 'Yes' : 'No', r.status];
    if (grouped) {
      const groups = data.groups || [];
      return (
        <div className="space-y-8">
          {groups.map((g) => (
            <div key={g.super_category}>
              <h3 className="font-bold text-lg mb-2">
                {g.super_category}{' '}
                <span className="font-normal text-slate-400 text-sm">({g.items} items)</span>
              </h3>
              <div className="space-y-4 pl-2">
                {g.categories.map((c) => (
                  <div key={c.category}>
                    <h4 className="font-semibold text-sm text-slate-600 mb-1">
                      {c.category} <span className="font-normal text-slate-400">({c.items})</span>
                    </h4>
                    <Table cols={cols} rows={[
                      ...c.rows.map(toRow),
                      ['', `${c.category} SUBTOTAL`, '', '', c.physical_qty, c.system_qty, c.variance, '', '', ''],
                    ]} />
                  </div>
                ))}
              </div>
              <div className="mt-2 rounded-lg bg-slate-100 px-3 py-2 text-sm font-bold text-slate-700">
                {g.super_category} subtotal — physical {g.physical_qty} · system {g.system_qty} · variance {g.variance}
              </div>
            </div>
          ))}
          {groups.length === 0 && <p className="text-slate-400">No data.</p>}
        </div>
      );
    }
    return <Table cols={cols} rows={data.rows.map(toRow)} />;
  }

  if (report === 'exceptions') {
    return (
      <div className="space-y-5 text-sm">
        <Section title="Voided entries" cols={['Super Category', 'Category', 'Item Name', 'Reason', 'Counted by', 'Voided by']}
                 rows={data.voided.map((v) => [v.super_category, v.category, v.name, v.void_reason, v.counted_by_name, v.voided_by_name])} />
        <Section title="Not applicable" cols={['Super Category', 'Category', 'Item Name', 'Reason', 'Marked by']}
                 rows={data.notApplicable.map((v) => [v.super_category, v.category, v.name, v.reason, v.marked_by_name])} />
        <Section title="Multiple entries" cols={['Super Category', 'Category', 'Item Name', 'Entries', 'Physical qty']}
                 rows={data.multiEntry.map((v) => [v.super_category, v.category, v.name, v.entries, v.physical_qty])} />
        <Section title="Zero quantity" cols={['Super Category', 'Category', 'Item Name', 'Zero entries']}
                 rows={data.zeroQty.map((v) => [v.super_category, v.category, v.name, v.zero_entries])} />
        <Section title="Counted without photo" cols={['Super Category', 'Category', 'Item Name', 'Entries']}
                 rows={data.noPhoto.map((v) => [v.super_category, v.category, v.name, v.entries])} />
      </div>
    );
  }
  return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;
}

function Section({ title, cols, rows }) {
  return <div><h3 className="font-bold mb-1">{title}</h3><Table cols={cols} rows={rows} /></div>;
}
