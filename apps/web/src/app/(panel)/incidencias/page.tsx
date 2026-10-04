'use client';

import Link from 'next/link';
import { type FormEvent, useCallback, useEffect, useState } from 'react';
import { shiftDate, useBranches, useOperationalToday } from '@/components/attendance';
import { Card, Empty, ErrorBox, Field, Loading, useAction } from '@/components/ui';
import { api, type Incident, personName, type PersonRef, type ShiftSummary } from '@/lib/api';
import { dateTimeIn, shiftLabel } from '@/lib/format';
import { errorText, t } from '@/lib/i18n';

type Row = Incident & { employee: PersonRef; branchName: string | null; shift: ShiftSummary | null; canResolve: boolean; canCorrect: boolean };

const TYPES = ['FALTA', 'RETARDO', 'SALIDA_ANTICIPADA', 'SIN_COMIDA', 'SALIDA_OLVIDADA', 'JORNADA_ABIERTA_EXCEDIDA', 'REGRESO_COMIDA_FALTANTE', 'COMIDA_EXCEDIDA', 'SIN_TURNO_PROGRAMADO', 'SIN_ASIGNACION_SUCURSAL', 'TURNO_EN_OTRA_SUCURSAL', 'ENTRADA_FALTANTE'];

/**
 * Incidencias: nunca se borran; se resuelven con motivo (justificada, confirmada, descartada) o quedan
 * "corregidas" por una corrección. Una FALTA se corrige registrando la jornada que sí ocurrió (D-53).
 */
export default function IncidentsPage() {
  const { branches, tzOf } = useBranches();
  // D-78: el rango por defecto parte del día operativo del negocio (lo calcula el servidor)
  const today = useOperationalToday();
  const [filter, setFilter] = useState({ branchId: '', status: 'OPEN', type: '', from: '', to: '' });
  useEffect(() => {
    if (today) setFilter((f) => (f.to ? f : { ...f, from: shiftDate(today, -30), to: today }));
  }, [today]);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<{ row: Row; resolution: 'JUSTIFIED' | 'CONFIRMED' | 'DISMISSED'; reason: string } | null>(null);
  const [registering, setRegistering] = useState<{ row: Row; start: string; end: string; reason: string } | null>(null);
  const action = useAction();

  const load = useCallback(async () => {
    if (!filter.from || !filter.to) return;
    const q = new URLSearchParams({ from: filter.from, to: filter.to });
    for (const k of ['branchId', 'status', 'type'] as const) if (filter[k]) q.set(k, filter[k]);
    try {
      setRows(await api<Row[]>(`/attendance/incidents?${q}`));
      setError(null);
    } catch (e) {
      setError(errorText((e as { code?: string }).code));
    }
  }, [filter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(ev: FormEvent) {
    ev.preventDefault();
    if (!resolving) return;
    const { row, resolution, reason } = resolving;
    if (await action.run(() => api(`/attendance/incidents/${row.id}/resolve`, { method: 'POST', body: { resolution, reason, expectedVersion: row.version } }))) {
      setResolving(null);
      await load();
    }
  }

  async function register(ev: FormEvent) {
    ev.preventDefault();
    if (!registering?.row.shift) return;
    const { row, start, end, reason } = registering;
    const shift = row.shift!;
    const body = {
      employeeId: row.employeeId,
      branchId: row.branchId,
      shiftId: shift.id,
      incidentId: row.id,
      start: { date: shift.businessDate, time: start },
      end: { date: end < start ? shiftDate(shift.businessDate, 1) : shift.businessDate, time: end },
      reason,
    };
    if (await action.run(() => api('/attendance/sessions', { method: 'POST', body }))) {
      setRegistering(null);
      await load();
    }
  }

  return (
    <>
      <h1>{t('incident.title')}</h1>
      <div className="row" style={{ marginBottom: '1rem' }}>
        <Field label={t('common.branch')}>
          <select value={filter.branchId} onChange={(e) => setFilter({ ...filter, branchId: e.target.value })}>
            <option value="">{t('live.all')}</option>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label={t('common.status')}>
          <select value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
            <option value="">{t('live.all')}</option>
            <option value="OPEN">{t('incident.status.OPEN')}</option>
            <option value="RESOLVED">{t('incident.status.RESOLVED')}</option>
          </select>
        </Field>
        <Field label={t('att.incidents')}>
          <select value={filter.type} onChange={(e) => setFilter({ ...filter, type: e.target.value })}>
            <option value="">{t('live.all')}</option>
            {TYPES.map((x) => <option key={x} value={x}>{t(`incident.type.${x}`)}</option>)}
          </select>
        </Field>
        <Field label={t('att.from')}><input type="date" value={filter.from} onChange={(e) => setFilter({ ...filter, from: e.target.value })} /></Field>
        <Field label={t('att.to')}><input type="date" value={filter.to} onChange={(e) => setFilter({ ...filter, to: e.target.value })} /></Field>
      </div>
      <ErrorBox message={error ?? action.error} />

      {resolving && (
        <Card title={`${t('incident.resolve')} · ${t(`incident.type.${resolving.row.type}`)} · ${personName(resolving.row.employee)}`}>
          <form className="row" onSubmit={resolve}>
            <Field label={t('incident.resolution')}>
              <select value={resolving.resolution} onChange={(e) => setResolving({ ...resolving, resolution: e.target.value as 'JUSTIFIED' })}>
                {(['JUSTIFIED', 'CONFIRMED', 'DISMISSED'] as const).map((r) => <option key={r} value={r}>{t(`incident.resolution.${r}`)}</option>)}
              </select>
            </Field>
            <Field label={t('common.reason')}><input required value={resolving.reason} onChange={(e) => setResolving({ ...resolving, reason: e.target.value })} /></Field>
            <button className="primary" disabled={action.busy || !resolving.reason.trim()}>{t('common.save')}</button>
            <button type="button" onClick={() => setResolving(null)}>{t('common.cancel')}</button>
          </form>
        </Card>
      )}

      {registering && (
        <Card title={`${t('incident.registerSession')} · ${personName(registering.row.employee)} · ${registering.row.operationalDate}`}>
          <form className="row" onSubmit={register} data-testid="register-session">
            <Field label={t('att.in')}><input type="time" required value={registering.start} onChange={(e) => setRegistering({ ...registering, start: e.target.value })} /></Field>
            <Field label={t('att.out')}><input type="time" required value={registering.end} onChange={(e) => setRegistering({ ...registering, end: e.target.value })} /></Field>
            <Field label={t('common.reason')}><input required value={registering.reason} onChange={(e) => setRegistering({ ...registering, reason: e.target.value })} /></Field>
            <button className="primary" disabled={action.busy || !registering.reason.trim()}>{t('common.save')}</button>
            <button type="button" onClick={() => setRegistering(null)}>{t('common.cancel')}</button>
          </form>
        </Card>
      )}

      <Card>
        {!rows ? <Loading /> : rows.length === 0 ? <Empty /> : (
          <table data-testid="incidents">
            <thead>
              <tr><th>{t('incident.date')}</th><th>{t('att.employee')}</th><th>{t('common.branch')}</th><th>{t('att.incidents')}</th><th>{t('att.shift')}</th><th>{t('common.status')}</th><th>{t('audit.when')}</th><th /></tr>
            </thead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.id} data-testid={`incident-${i.type}`}>
                  <td>{i.operationalDate}</td>
                  <td>{personName(i.employee)}</td>
                  <td>{i.branchName}</td>
                  <td>{t(`incident.type.${i.type}`)}</td>
                  <td>{i.shift ? shiftLabel(i.shift) : '—'}</td>
                  <td title={i.resolution === 'VOIDED' ? t('incident.voidedHelp') : undefined}>
                    {t(`incident.status.${i.status}`)}{i.resolution ? ` · ${t(`incident.resolution.${i.resolution}`)}` : ''}
                    {i.resolutionSource === 'SYSTEM' && i.resolutionReason ? <div className="muted">{i.resolutionReason}</div> : null}
                  </td>
                  <td>{dateTimeIn(i.detectedAt, tzOf(i.branchId))}</td>
                  <td className="row">
                    {i.workSessionId && <Link href={`/jornadas/${i.workSessionId}`}>{t('att.detail')}</Link>}
                    {i.status === 'OPEN' && i.canResolve && <button onClick={() => setResolving({ row: i, resolution: 'JUSTIFIED', reason: '' })}>{t('incident.resolve')}</button>}
                    {i.status === 'OPEN' && i.type === 'FALTA' && i.canCorrect && i.shift && (
                      <button onClick={() => setRegistering({ row: i, start: i.shift!.startTime, end: i.shift!.endTime, reason: '' })}>{t('incident.registerSession')}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
