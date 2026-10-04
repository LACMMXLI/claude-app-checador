'use client';

import { useCallback, useEffect, useState } from 'react';
import { ShiftDialog } from '@/components/shift-dialog';
import { Card, ErrorBox, Field, Loading, useAction } from '@/components/ui';
import { api, type Branch, type Shift, type Week } from '@/lib/api';
import { addDays, dayLabel, shiftLabel, todayLocal } from '@/lib/format';
import { errorText, t } from '@/lib/i18n';

interface CopyResult {
  weekStart: string;
  dryRun: boolean;
  created: Shift[];
  conflicts: { sourceShiftId: string | null; employeeId: string; date: string; startTime: string; endTime: string; code: string }[];
}

/**
 * Horario semanal por sucursal: cuadrícula empleado × día. Cada cambio se guarda al momento (el
 * horario permanece en BORRADOR hasta que se publica explícitamente). El día de un turno nocturno es
 * el día en que inicia: "7p–3a (+1)".
 */
export default function SchedulePage() {
  const branches = useAction();
  const [branchList, setBranchList] = useState<Branch[] | null>(null);
  const [branchId, setBranchId] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [week, setWeek] = useState<Week | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ shift: Shift | null; preset?: { employeeId: string; date: string } } | null>(null);
  const [copy, setCopy] = useState<CopyResult | null>(null);
  const action = useAction();

  useEffect(() => {
    void branches.run(() => api<Branch[]>('/branches')).then((list) => {
      if (!list) return;
      const active = list.filter((b) => b.isActive);
      setBranchList(active);
      if (active[0]) setBranchId((prev) => prev || active[0]!.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      setLoadError(null);
      setWeek(await api<Week>(`/schedules/week?branchId=${branchId}&date=${date}`));
    } catch (e) {
      setLoadError(errorText((e as { code?: string }).code));
    }
  }, [branchId, date]);

  useEffect(() => {
    setCopy(null);
    void load();
  }, [load]);

  async function publish() {
    if (!week?.schedule || !window.confirm(t('schedule.publishedConfirm'))) return;
    if (await action.run(() => api(`/schedules/${week.schedule!.id}/publish`, { method: 'POST', body: { expectedVersion: week.schedule!.version } }))) await load();
  }

  async function copyPrevious(dryRun: boolean) {
    if (!week) return;
    const r = await action.run(() => api<CopyResult>('/schedules/copy', { method: 'POST', body: { branchId, sourceWeek: addDays(week.weekStart, -7), targetWeek: week.weekStart, dryRun } }));
    if (r) {
      setCopy(r);
      if (!dryRun) await load();
    }
  }

  const name = (id: string) => {
    const p = week?.employees.find((e) => e.id === id);
    return p ? `${p.firstName} ${p.lastName}`.trim() : id.slice(0, 8);
  };
  const status = week?.schedule?.status ?? 'NONE';

  return (
    <>
      <h1>{t('schedule.title')}</h1>
      <ErrorBox message={branches.error ?? loadError ?? action.error} />
      <div className="filters">
        <div className="row">
          <Field label={t('common.branch')}>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              {branchList?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <div className="btn-row">
            <button className="secondary" onClick={() => setDate(addDays(week?.weekStart ?? date, -7))}>{t('schedule.prev')}</button>
            <button className="secondary" onClick={() => setDate(todayLocal())}>{t('schedule.today')}</button>
            <button className="secondary" onClick={() => setDate(addDays(week?.weekStart ?? date, 7))}>{t('schedule.next')}</button>
          </div>
        </div>
      </div>
      {!week ? <Loading /> : (
        <Card
          title={`${dayLabel(week.days[0]!)} – ${dayLabel(week.days[6]!)} · ${week.branch.timezone}`}
          actions={
            <div className="row">
              <span className={`badge ${status === 'PUBLISHED' ? 'ok' : 'off'}`} data-testid="schedule-status">{t(`schedule.status.${status}`)}</span>
              {status !== 'PUBLISHED' && <button disabled={action.busy} onClick={() => void copyPrevious(true)}>{t('schedule.copyPrev')}</button>}
              {week.schedule && status === 'DRAFT' && <button className="primary" disabled={action.busy} onClick={() => void publish()}>{t('schedule.publish')}</button>}
            </div>
          }
        >
          {copy && (
            <div className="secret" role="status">
              <strong>{copy.dryRun ? t('schedule.preview') : t('schedule.copyResult')}</strong>
              <p>{t('schedule.created')}: {copy.created.length}</p>
              {copy.conflicts.length > 0 && (
                <>
                  <p>{t('schedule.conflicts')}:</p>
                  <ul>
                    {copy.conflicts.map((c, i) => (
                      <li key={i}>{name(c.employeeId)} · {dayLabel(c.date)} {c.startTime}–{c.endTime}: {errorText(c.code)}</li>
                    ))}
                  </ul>
                </>
              )}
              <div className="row">
                {copy.dryRun && copy.created.length > 0 && <button className="primary" disabled={action.busy} onClick={() => void copyPrevious(false)}>{t('schedule.copyPrev')}</button>}
                <button onClick={() => setCopy(null)}>{t('secret.close')}</button>
              </div>
            </div>
          )}
          <table className="week">
            <thead>
              <tr>
                <th>{t('schedule.employee')}</th>
                {week.days.map((d) => <th key={d}>{dayLabel(d)}</th>)}
              </tr>
            </thead>
            <tbody>
              {week.employees.map((p) => (
                <tr key={p.id}>
                  <td className="who-cell">{p.firstName} {p.lastName}{p.temporary && <span className="muted"> (temporal)</span>}</td>
                  {week.days.map((d) => {
                    const cell = week.shifts.filter((s) => s.employeeId === p.id && s.businessDate === d);
                    return (
                      <td key={d} data-label={dayLabel(d)} className={cell.length === 0 ? 'rest-cell' : ''}>
                        {cell.map((s) => (
                          <button key={s.id} className={`shift ${s.status === 'CANCELLED' ? 'cancelled' : ''}`} onClick={() => setDialog({ shift: s })} title={`${s.startDate} ${s.startTime} → ${s.endDate} ${s.endTime}`}>
                            {shiftLabel(s)}
                          </button>
                        ))}
                        {cell.length === 0 && <span className="muted rest">{t('schedule.rest')}</span>}
                        <button className="link add" aria-label={`${t('schedule.newShift')} ${p.firstName} ${d}`} onClick={() => setDialog({ shift: null, preset: { employeeId: p.id, date: d } })}>＋</button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
      {dialog && week && (
        <ShiftDialog
          week={week}
          shift={dialog.shift}
          preset={dialog.preset}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            void load();
          }}
        />
      )}
    </>
  );
}
