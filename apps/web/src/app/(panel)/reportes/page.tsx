'use client';

import { useEffect, useState } from 'react';
import { useBranches } from '@/components/attendance';
import { Card, ErrorBox, Field, Loading, useAction } from '@/components/ui';
import { api, download, type Employee, type PeriodKey, type ReportKind, type ReportTable } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

const KINDS: ReportKind[] = ['summary', 'sessions', 'incidents', 'corrections'];
const PERIODS: PeriodKey[] = ['today', 'yesterday', 'week_current', 'week_previous', 'fortnight_current', 'fortnight_previous', 'month_current', 'month_previous'];
const PAGE = 200; // filas en pantalla; la exportación lleva todas (hasta 100,000)

/**
 * Reportes (D-73) y exportación XLSX/CSV (D-74). Los periodos rápidos los resuelve el SERVIDOR con el día operativo de
 * la sucursal (zona + hora de corte); el rango personalizado admite hasta 366 días. La sucursal y el empleado son solo
 * filtros: el alcance real (`reports.view` / `reports.export`) lo aplica el backend y el RLS.
 */
export default function ReportsPage() {
  const { can } = useSession();
  const { branches } = useBranches();
  const [filters, setFilters] = useState<{ report: ReportKind; period: PeriodKey | 'custom'; from: string; to: string; branchId: string; employeeId: string }>({
    report: 'summary',
    period: 'week_current',
    from: '',
    to: '',
    branchId: '',
    employeeId: '',
  });
  const [periods, setPeriods] = useState<Record<PeriodKey, { from: string; to: string }> | null>(null);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [table, setTable] = useState<ReportTable | null>(null);
  const [shown, setShown] = useState(PAGE);
  const query = useAction();
  const exporting = useAction();

  useEffect(() => {
    void api<{ today: string; periods: Record<PeriodKey, { from: string; to: string }> }>(`/reports/periods${filters.branchId ? `?branchId=${filters.branchId}` : ''}`).then(
      (r) => {
        setPeriods(r.periods);
        setFilters((f) => (f.from ? f : { ...f, from: r.periods.week_current.from, to: r.periods.week_current.to }));
      },
      () => setPeriods(null),
    );
  }, [filters.branchId]);

  useEffect(() => {
    if (!can('employees.view')) return;
    void api<Employee[]>('/employees').then(setEmployees, () => setEmployees([]));
  }, [can]);

  const params = () => {
    const base = { report: filters.report, ...(filters.branchId ? { branchId: filters.branchId } : {}), ...(filters.employeeId ? { employeeId: filters.employeeId } : {}) };
    return filters.period === 'custom' ? { ...base, from: filters.from, to: filters.to } : { ...base, period: filters.period };
  };

  async function run() {
    const r = await query.run(() => api<ReportTable>(`/reports/attendance?${new URLSearchParams(params() as Record<string, string>)}`));
    if (r) {
      setTable(r);
      setShown(PAGE);
    }
  }

  async function exportAs(format: 'xlsx' | 'csv') {
    await exporting.run(() => download('/reports/export', { format, filters: params() }));
  }

  const range = filters.period === 'custom' ? null : periods?.[filters.period];

  return (
    <>
      <h1>{t('reports.title')}</h1>
      <p className="muted">{t('reports.help')}</p>
      <Card>
        <div className="row">
          <Field label={t('reports.report')}>
            <select value={filters.report} onChange={(e) => setFilters({ ...filters, report: e.target.value as ReportKind })} data-testid="report-kind">
              {KINDS.map((k) => <option key={k} value={k}>{t(`reports.kind.${k}`)}</option>)}
            </select>
          </Field>
          <Field label={t('reports.period')}>
            <select value={filters.period} onChange={(e) => setFilters({ ...filters, period: e.target.value as PeriodKey | 'custom' })} data-testid="report-period">
              {PERIODS.map((p) => <option key={p} value={p}>{t(`reports.period.${p}`)}</option>)}
              <option value="custom">{t('reports.period.custom')}</option>
            </select>
          </Field>
          {filters.period === 'custom' ? (
            <>
              <Field label={t('att.from')}><input type="date" value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })} /></Field>
              <Field label={t('att.to')}><input type="date" value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })} /></Field>
            </>
          ) : (
            <span className="muted" data-testid="report-range">{range ? `${range.from} → ${range.to}` : ''}</span>
          )}
          <Field label={t('common.branch')}>
            <select value={filters.branchId} onChange={(e) => setFilters({ ...filters, branchId: e.target.value })}>
              <option value="">{t('reports.allBranches')}</option>
              {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          {employees.length > 0 && (
            <Field label={t('att.employee')}>
              <select value={filters.employeeId} onChange={(e) => setFilters({ ...filters, employeeId: e.target.value })}>
                <option value="">{t('reports.allEmployees')}</option>
                {employees.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} · {e.firstName} {e.lastName}</option>)}
              </select>
            </Field>
          )}
          <button className="primary" disabled={query.busy} onClick={() => void run()} data-testid="report-run">{t('reports.run')}</button>
          {can('reports.export') && (
            <>
              <button disabled={exporting.busy} onClick={() => void exportAs('xlsx')} data-testid="export-xlsx">{t('reports.export')} XLSX</button>
              <button disabled={exporting.busy} onClick={() => void exportAs('csv')} data-testid="export-csv">{t('reports.export')} CSV</button>
            </>
          )}
        </div>
      </Card>
      <ErrorBox message={query.error ?? exporting.error} />
      {query.busy && !table ? <Loading /> : table && (
        <Card title={`${t(`reports.kind.${table.report}`)} · ${table.from} → ${table.to} · ${table.rows.length} ${t('reports.rows')}`}>
          {table.rows.length === 0 ? <p className="muted">{t('common.empty')}</p> : (
            <>
              <table data-testid="report-table">
                <thead><tr>{table.columns.map((c) => <th key={c.key}>{c.header}</th>)}</tr></thead>
                <tbody>
                  {table.rows.slice(0, shown).map((r, i) => (
                    <tr key={i}>{table.columns.map((c) => <td key={c.key} style={c.kind === 'number' ? { textAlign: 'right' } : undefined}>{r[c.key] ?? ''}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {shown < table.rows.length && <button className="link" onClick={() => setShown(shown + PAGE)}>+{Math.min(PAGE, table.rows.length - shown)}</button>}
            </>
          )}
        </Card>
      )}
    </>
  );
}
