import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, downloadReport } from '../../lib/api.js';
import { Spinner } from '../../components/ui.jsx';
import { fmtDate, fmtDateTime } from '../../lib/datetime.js';

const REPORTS = [
  ['physical-summary', 'R1 Physical Summary'],
  ['item-detail', 'R2 Item Detail'],
  ['liquor', 'R3 Liquor'],
  ['variance', 'R4 Variance'],
  ['exceptions', 'R6 Exceptions'],
];

// A missing figure is shown as '—', never as 0. On an audit report "priced at
// zero" and "nobody has priced this yet" must never look the same.
const num = (v) => (v == null ? '—' : v);
const money = (v) => (v == null ? '—' : Number(v).toLocaleString('en-IN',
  { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

// Reports are the client deliverable: TOTALS ONLY, one line per item.
// The per-entry breakdown lives on the admin count-entry screen.
export default function Reports() {
  const [audits, setAudits] = useState([]);
  const [auditId, setAuditId] = useState('');
  const [report, setReport] = useState('physical-summary');
  const [data, setData] = useState(null);
  const [loadedReport, setLoadedReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [vSuper, setVSuper] = useState('');         // variance: super category filter
  const [vCategory, setVCategory] = useState('');   // variance: category filter
  // ON by default: the subtotals ARE the variance report. Off, they were hidden
  // behind a checkbox nobody had reason to find.
  const [vGroup, setVGroup] = useState(true);       // variance: group by category
  const [vSystem, setVSystem] = useState('all');    // all | with | without
  const [vRate, setVRate] = useState('all');        // all | with | without
  const [vCount, setVCount] = useState('all');      // all | counted | not_counted
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
        vCount !== 'all' ? `count=${vCount}` : '',
        vSuper ? `super_category_id=${vSuper}` : '',
        vCategory ? `category_id=${vCategory}` : '',
        vGroup ? 'group_by=category' : '',
        vSystem !== 'all' ? `system_data=${vSystem}` : '',
        vRate !== 'all' ? `rate=${vRate}` : '',
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
  }, [report, auditId, vCount, vSuper, vCategory, vGroup, vSystem, vRate]);

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
              {a.store_name} — {fmtDate(a.audit_date)} ({a.status})
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

      {/* Value figures are only as complete as the rates behind them. Say so up
          front rather than letting a reader assume the totals are the whole
          picture. */}
      {report === 'variance' && loadedReport === 'variance' && data?.totals?.no_rate > 0 && (
        <div className="mb-4 rounded-xl border-2 border-amber-300 bg-amber-50 px-4 py-3 text-amber-900">
          <span className="font-bold">{data.totals.no_rate} items have no rate</span>
          {' '}— value figures exclude them.{' '}
          <button className="underline font-medium" onClick={() => setVRate('without')}>
            Show only those items
          </button>
          {' · '}
          <Link className="underline font-medium" to="/admin/items">Set rates in the item master</Link>
        </div>
      )}

      {/* Case (c): the system says stock is there and nobody counted it. Each
          one is a full shortage that has not been looked at. */}
      {report === 'variance' && loadedReport === 'variance' && data?.totals?.not_counted > 0 && (
        <div className="mb-4 rounded-xl border-2 border-red-300 bg-red-50 px-4 py-3 text-red-900">
          <span className="font-bold">{data.totals.not_counted} items have system stock but were never counted</span>
          {' '}— each is shown as a full shortage
          {data.totals.not_counted_value ? <> worth ₹{money(Math.abs(data.totals.not_counted_value))}</> : null}
          {' '}and flagged <span className="font-mono font-bold">NOT COUNTED</span>.{' '}
          <button className="underline font-medium" onClick={() => setVCount('not_counted')}>
            Show only those items
          </button>
        </div>
      )}

      {/* A physical-only audit is a complete deliverable — say so plainly
          instead of demanding a system stock upload. */}
      {report === 'variance' && loadedReport === 'variance' && data?.withSystem === false && (
        <div className="mb-4 rounded-xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
          <span className="font-semibold">Physical count only.</span>{' '}
          No system stock has been imported for this audit, so the report shows the physical
          columns. Variance and value appear automatically once system figures exist.{' '}
          <Link className="underline font-medium" to={`/admin/audits/${auditId}/system-stock`}>
            Import system stock
          </Link>
        </div>
      )}

      {/* Case (d): master items this outlet does not stock. Off the table, but
          accounted for, so nothing in the master goes unexplained. */}
      {report === 'variance' && loadedReport === 'variance' && data?.notStocked?.count > 0 && (
        <p className="mb-4 text-sm text-slate-500">
          {data.notStocked.count} master items neither counted nor present in system stock —
          not stocked at this outlet, excluded from this report.
        </p>
      )}

      {report === 'variance' && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {/* [All] [Counted] [Not counted with system stock] */}
          <span className="flex gap-1">
            {[['all', 'All'], ['counted', 'Counted'],
              ['not_counted', 'Not counted with system stock']].map(([k, l]) => (
              <button key={k} className={vCount === k ? 'chip-on' : 'chip-off'}
                      onClick={() => setVCount(k)}>{l}</button>
            ))}
          </span>
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
          <span className="flex gap-1">
            {[['all', 'All'], ['with', 'With system data'], ['without', 'No system data']].map(([k, l]) => (
              <button key={k} className={vSystem === k ? 'chip-on' : 'chip-off'}
                      onClick={() => setVSystem(k)}>{l}</button>
            ))}
          </span>
          {/* Isolates the items the value columns cannot speak for. */}
          <span className="flex gap-1">
            {[['all', 'All'], ['with', 'With rate'], ['without', 'No rate']].map(([k, l]) => (
              <button key={k} className={vRate === k ? 'chip-on' : 'chip-off'}
                      onClick={() => setVRate(k)}>{l}</button>
            ))}
          </span>
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

      {/* Provenance — the variance report always states where the system
          figures came from, so a wrong file is noticeable. */}
      {report === 'variance' && loadedReport === 'variance' && data?.provenance && data?.hasSystemStock && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm">
          <div className="font-semibold text-slate-700">System stock source</div>
          <div className="text-slate-600">
            {data.provenance.source?.filename
              ? <span className="font-mono">{data.provenance.source.filename}</span>
              : 'Entered manually'}
          </div>
          {data.provenance.source && (
            <div className="text-slate-500">
              Imported: {fmtDateTime(data.provenance.source.imported_at)}
              {data.provenance.source.imported_by_name ? ` by ${data.provenance.source.imported_by_name}` : ''}
            </div>
          )}
          <div className="text-slate-500">
            Coverage: {data.provenance.with_system} of {data.provenance.master_total} master items
          </div>
          {data.totals?.no_system_data > 0 && (
            <div className="text-amber-700 mt-1">
              {data.totals.no_system_data} item(s) have no system figure — shown as NO SYSTEM DATA and
              excluded from variance totals.
            </div>
          )}
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
              {a.store_name} {fmtDate(a.audit_date)}
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
            <Table cols={['Store', 'Date', 'Status', 'Items', 'Uncounted', 'Physical value',
                          'Total variance', 'Variance value', 'Critical']}
                   align={['', '', '', 'right', 'right', 'right', 'right', 'right', 'right']}
                   rows={consolidated.rows.map((r) => [r.store_name, fmtDate(r.audit_date),
                     r.status, r.items, r.uncounted, money(r.physical_value),
                     r.total_variance_qty, money(r.total_variance_value), r.critical_items])} />
            {/* Super-category-level comparison across stores. */}
            <h3 className="font-bold mt-6 mb-2">By super category</h3>
            <Table cols={['Super Category', 'Store', 'Items', 'Physical', 'System', 'Variance',
                          'Physical value', 'Variance value']}
                   align={['', '', 'right', 'right', 'right', 'right', 'right', 'right']}
                   rows={(consolidated.superCategories || []).map((r) => [
                     r.super_category, r.store_name, r.items, r.physical_qty,
                     r.system_qty, r.variance, money(r.physical_value), money(r.variance_value)])} />
          </div>
        )}
      </div>
    </div>
  );
}

// `align` marks columns that hold numbers so figures line up on the decimal
// point instead of drifting left. `rowClass` lets a caller emphasise subtotal
// and total lines without a second table component.
function Table({ cols, rows, align = [], rowClass }) {
  const cell = (j) => (align[j] === 'right' ? 'px-3 py-2 text-right tabular-nums' : 'px-3 py-2');
  const head = (j) => (align[j] === 'right' ? 'px-3 py-2 text-right' : 'px-3 py-2');
  return (
    <table className="w-full text-sm">
      <thead className="bg-slate-50 text-left text-slate-500">
        <tr>{cols.map((c, j) => <th key={c} className={head(j)}>{c}</th>)}</tr>
      </thead>
      <tbody className="divide-y">
        {rows.map((r, i) => (
          <tr key={i} className={rowClass ? rowClass(r, i) : undefined}>
            {r.map((c, j) => <td key={j} className={cell(j)}>{c}</td>)}
          </tr>
        ))}
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
    // The standard audit report format. BASE columns are always present — a
    // physical-only audit is a complete deliverable and never asks for a
    // system stock upload. The five system columns appear only when system
    // figures exist, and nothing else about the layout changes.
    const withSystem = !!data.withSystem;

    const BASE = [
      ['s_no', 'S.No.', 'right'],
      ['loc', 'LOC', ''],
      ['super_category', 'Super Category', ''],
      ['category', 'Category', ''],
      ['name', 'Item Name', ''],
      ['unit', 'Unit', ''],
      ['bottle_unit_size', 'Bottle/Unit Size (ml)', 'right'],
      ['store_room_qty', 'Store Room Qty (Physical)', 'right'],
      ['outlet_qty', 'Outlet Qty (Physical)', 'right'],
      ['store_outlet_total', 'Store+Outlet Total', 'right'],
      ['loose_ml', 'ML / Loose Qty', 'right'],
      ['final_total_qty', 'Final Total Qty', 'right'],
      ['remarks', 'Remarks', ''],
    ];
    const SYSTEM = [
      ['system_qty', 'System Qty', 'right'],
      ['rate', 'Rate', 'right'],
      ['physical_value', 'Value', 'right'],
      ['variance', 'Variance', 'right'],
      ['variance_value', 'Variance Value', 'right'],
    ];
    const spec = withSystem ? [...BASE, ...SYSTEM] : BASE;
    const cols = spec.map(([, label]) => label);
    const align = spec.map(([, , a]) => a);

    // Quantities print as given; money is formatted; a missing figure is '—',
    // never 0.
    const cell = (r, key) => {
      if (key === 'rate' || key === 'physical_value' || key === 'variance_value') return money(r[key]);
      if (key === 'system_qty' || key === 'variance') return num(r[key]);
      if (key === 'remarks') {
        // NOT COUNTED rides alongside the measurement basis rather than
        // replacing it, so neither piece of information is lost.
        return r.not_counted ? (
          <span className="whitespace-nowrap">
            {r.remarks}{' '}
            <span className="chip bg-red-100 text-red-700 border-red-200 font-semibold">NOT COUNTED</span>
          </span>
        ) : r.remarks;
      }
      return r[key];
    };
    const toRow = (r) => spec.map(([key]) => cell(r, key));

    // Subtotal / total lines carry the same figures in the same columns, so a
    // column reads straight down from an item line to the grand total.
    const summaryRow = (label, b, labelCol = 3) => {
      const r = spec.map(([key]) => {
        if (['store_room_qty', 'outlet_qty', 'store_outlet_total', 'loose_ml',
             'final_total_qty', 'system_qty', 'variance'].includes(key)) return b[key];
        if (key === 'physical_value' || key === 'variance_value') return money(b[key]);
        if (key === 'remarks') return `${b.items} items`;
        return '';
      });
      r[labelCol] = label;
      return r;
    };
    const isSummary = (r) => /SUBTOTAL|GRAND TOTAL|^TOTAL$/.test(`${r[2]} ${r[3]}`);
    const emphasise = (r) => (isSummary(r) ? 'bg-slate-50 font-semibold' : undefined);

    const table = (rows, rowClass) => (
      <div className="overflow-x-auto">
        <Table cols={cols} align={align} rowClass={rowClass} rows={rows} />
      </div>
    );

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
                    {table([...c.rows.map(toRow), summaryRow(`${c.category} SUBTOTAL`, c)], emphasise)}
                  </div>
                ))}
              </div>
              <div className="mt-2">
                {table([summaryRow(`${g.super_category} SUBTOTAL`, g, 2)], () => 'bg-slate-100 font-bold')}
              </div>
            </div>
          ))}
          {groups.length > 0 && data.grand && (
            <div>
              <h3 className="font-bold text-lg mb-2">Grand total</h3>
              {table([summaryRow('GRAND TOTAL', data.grand, 2)], () => 'bg-teal-50 font-bold')}
              <p className="mt-2 text-sm text-slate-600">
                Final total quantity:{' '}
                <span className="font-bold tabular-nums">{data.grand.final_total_qty}</span>
                {withSystem && data.grand.variance_value != null && (
                  <>
                    {' · '}total variance value:{' '}
                    <span className={`font-bold tabular-nums ${data.grand.variance_value < 0 ? 'text-red-700' : 'text-green-700'}`}>
                      ₹{money(data.grand.variance_value)}
                    </span>
                  </>
                )}
              </p>
            </div>
          )}
          {groups.length === 0 && <p className="text-slate-400">No data.</p>}
          {data.summary && <SummaryReport summary={data.summary} />}
        </div>
      );
    }

    return (
      <>
        {table(data.rows.map(toRow))}
        {data.totals && (
          <div className="mt-3 rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-700">
            <div className="font-semibold">
              Totals — store room {data.totals.store_room_qty} · outlet {data.totals.outlet_qty}
              {' '}· store+outlet {data.totals.store_outlet_total} · loose {data.totals.loose_ml} ml
              {' '}· <span className="tabular-nums">final total {data.totals.final_total_qty}</span>
            </div>
            {withSystem && (
              <div className="mt-1">
                System {data.totals.system_qty} · variance {data.totals.variance}
                {data.totals.variance_pct != null && <> ({data.totals.variance_pct}%)</>}
                {' '}· value <span className="font-semibold tabular-nums">₹{money(data.totals.physical_value)}</span>
                {' '}· variance value{' '}
                <span className={`font-bold tabular-nums ${data.totals.variance_value < 0 ? 'text-red-700' : 'text-green-700'}`}>
                  ₹{money(data.totals.variance_value)}
                </span>
              </div>
            )}
            {(data.totals.no_system_data > 0 || data.totals.no_rate > 0) && withSystem && (
              <div className="mt-1 text-amber-700">
                {data.totals.no_system_data > 0 &&
                  <>{data.totals.no_system_data} item(s) with NO SYSTEM DATA excluded from variance totals. </>}
                {data.totals.no_rate > 0 &&
                  <>{data.totals.no_rate} item(s) have no rate — value figures exclude them.</>}
              </div>
            )}
          </div>
        )}
        {data.summary && <SummaryReport summary={data.summary} />}
      </>
    );
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
        <Section title={`No system data (${data.noSystemData?.length || 0}) — data gap, not a variance`}
                 cols={['Super Category', 'Category', 'Item Name', 'Unit', 'Physical qty']}
                 rows={(data.noSystemData || []).map((v) => [v.super_category, v.category, v.name, v.unit, v.physical_qty])} />
        {/* System stock exists and nobody counted it — a full shortage that has
            not been looked at, so it gets its own section to chase up. */}
        <div>
          <h3 className="font-bold mb-1">
            Not counted ({data.notCounted?.length || 0}) — system stock exists, no count recorded
          </h3>
          <p className="text-xs text-slate-500 mb-1">
            Each of these appears on the variance report as a full shortage.
            {data.notStockedCount > 0 && (
              <> A further {data.notStockedCount} master item(s) were neither counted nor present in
              system stock — not stocked at this outlet.</>
            )}
          </p>
          <Table cols={['Super Category', 'Category', 'Item Name', 'Unit', 'System qty',
                        'Shortage qty', 'Shortage value', 'Marked N/A']}
                 align={['', '', '', '', 'right', 'right', 'right', '']}
                 rows={(data.notCounted || []).map((v) => [
                   v.super_category, v.category, v.name, v.unit, v.system_qty,
                   v.shortage_qty, money(v.shortage_value), v.not_applicable ? 'Yes' : ''])} />
        </div>
        <Section title="Counted without photo" cols={['Super Category', 'Category', 'Item Name', 'Entries']}
                 rows={data.noPhoto.map((v) => [v.super_category, v.category, v.name, v.entries])} />
      </div>
    );
  }
  return <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>;
}

// ── Summary report ─────────────────────────────────────────────────────────
// The second sheet of the export, shown on screen so what is downloaded is
// what was reviewed.
function SummaryReport({ summary }) {
  const h = summary.header;
  const bases = Object.entries(h.by_basis || {});
  return (
    <div className="mt-8 pt-6 border-t">
      <h3 className="font-bold text-lg mb-2">Summary report</h3>
      <div className="card p-4 mb-3 text-sm grid sm:grid-cols-3 gap-3">
        <div><span className="text-slate-500">Location</span><div className="font-semibold">{h.location || '—'}</div></div>
        <div><span className="text-slate-500">Audit date</span><div className="font-semibold">{fmtDate(h.audit_date)}</div></div>
        <div><span className="text-slate-500">Total items</span><div className="font-semibold">{h.total_items}</div></div>
        <div className="sm:col-span-3">
          <span className="text-slate-500">Items by measurement type</span>
          <div className="flex flex-wrap gap-2 mt-1">
            {bases.map(([b, c]) => (
              <span key={b} className={`chip ${c > 0 ? 'bg-slate-100 text-slate-700 border-slate-200' : 'bg-white text-slate-300 border-slate-100'}`}>
                {b} {c}
              </span>
            ))}
          </div>
        </div>
      </div>
      <Table
        cols={['Super Category', 'Category', 'Items', 'Store Room Qty', 'Outlet Qty',
               'Store+Outlet Total', 'ML / Loose Qty', 'Final Total Qty']}
        align={['', '', 'right', 'right', 'right', 'right', 'right', 'right']}
        rowClass={(r) => (/SUBTOTAL|GRAND TOTAL/.test(String(r[0])) ? 'bg-slate-50 font-semibold' : undefined)}
        rows={[
          ...summary.superCategories.flatMap((g) => [
            ...summary.categories
              .filter((c) => c.super_category === g.super_category)
              .map((c) => [c.super_category, c.category, c.items, c.store_room_qty,
                           c.outlet_qty, c.store_outlet_total, c.loose_ml, c.final_total_qty]),
            [`${g.super_category} — SUBTOTAL`, '', g.items, g.store_room_qty, g.outlet_qty,
             g.store_outlet_total, g.loose_ml, g.final_total_qty],
          ]),
          ['GRAND TOTAL', '', summary.grand.items, summary.grand.store_room_qty,
           summary.grand.outlet_qty, summary.grand.store_outlet_total,
           summary.grand.loose_ml, summary.grand.final_total_qty],
        ]} />
    </div>
  );
}

function Section({ title, cols, rows }) {
  return <div><h3 className="font-bold mb-1">{title}</h3><Table cols={cols} rows={rows} /></div>;
}
