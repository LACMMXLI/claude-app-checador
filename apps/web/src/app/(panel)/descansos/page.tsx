'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Card, Empty, ErrorBox, Field, Loading, useAction } from '@/components/ui';
import { api, type Branch, type Week } from '@/lib/api';
import { addDays, dayLabel, isoWeekday, shiftLabel, todayLocal } from '@/lib/format';
import { errorText, t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

type CellState = 'WORK' | 'REST' | 'OFF';

/**
 * Descansos de la semana (D-92): quién trabaja, quién descansa y cuántos años tiene cada persona.
 *  · Trabaja = tiene turno ese día (si además era su día de descanso se marca como aviso, no se bloquea).
 *  · Descansa = es su día de descanso fijo y no tiene turno.
 *  · Sin turno = no es su día de descanso y tampoco tiene turno.
 */
export default function RestDaysPage() {
  const { can } = useSession();
  const branches = useAction();
  const [branchList, setBranchList] = useState<Branch[] | null>(null);
  const [branchId, setBranchId] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [week, setWeek] = useState<Week | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

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
  useEffect(() => { void load(); }, [load]);

  const today = todayLocal();
  const people = week?.employees.filter((p) => p.status === 'ACTIVE') ?? [];
  const cellOf = (employeeId: string, restDays: number[], day: string) => {
    const shifts = week!.shifts.filter((s) => s.employeeId === employeeId && s.businessDate === day && s.status === 'SCHEDULED');
    const onRestDay = restDays.includes(isoWeekday(day));
    const state: CellState = shifts.length > 0 ? 'WORK' : onRestDay ? 'REST' : 'OFF';
    return { state, shifts, conflict: shifts.length > 0 && onRestDay };
  };
  const totals = week
    ? week.days.map((d) => {
        const states = people.map((p) => cellOf(p.id, p.restDays, d).state);
        return { work: states.filter((s) => s === 'WORK').length, rest: states.filter((s) => s === 'REST').length, off: states.filter((s) => s === 'OFF').length };
      })
    : [];
  const todayIdx = week ? week.days.indexOf(today) : -1;

  return (
    <>
      <h1>{t('rest.title')}</h1>
      <p className="muted">{t('rest.subtitle')}</p>
      <ErrorBox message={branches.error ?? loadError} />
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
        <Card title={`${dayLabel(week.days[0]!)} – ${dayLabel(week.days[6]!)} · ${week.branch.name}`}
          actions={todayIdx >= 0 ? (
            <div className="row" data-testid="rest-today">
              <span className="badge ok">{t('rest.today')}: {totals[todayIdx]!.work} {t('rest.worksCount').toLowerCase()}</span>
              <span className="badge off">{totals[todayIdx]!.rest} {t('rest.restsCount').toLowerCase()}</span>
            </div>
          ) : undefined}>
          {people.length === 0 ? <Empty text={t('rest.empty')} /> : (
            <table className="week rest-table" data-testid="rest-table">
              <thead>
                <tr>
                  <th>{t('schedule.employee')}</th>
                  <th>{t('rest.age')}</th>
                  {week.days.map((d) => <th key={d} className={d === today ? 'is-today' : ''}>{dayLabel(d)}</th>)}
                </tr>
              </thead>
              <tbody>
                {people.map((p) => (
                  <tr key={p.id} data-testid={`rest-row-${p.employeeNumber}`}>
                    <td className="who-cell">
                      {can('employees.view') ? <Link href={`/empleados/${p.id}`}>{p.firstName} {p.lastName}</Link> : <>{p.firstName} {p.lastName}</>}
                      {p.temporary && <span className="muted"> ({t('schedule.temporary')})</span>}
                    </td>
                    <td data-label={t('rest.age')} data-testid="rest-age">{p.age ?? '—'}</td>
                    {week.days.map((d) => {
                      const c = cellOf(p.id, p.restDays, d);
                      return (
                        <td key={d} data-label={dayLabel(d)} data-state={c.state} className={`rest-${c.state.toLowerCase()} ${c.conflict ? 'rest-conflict' : ''} ${d === today ? 'is-today' : ''}`}>
                          {c.state === 'WORK' && (
                            <span className="rest-pill work" title={c.conflict ? t('rest.conflict') : t('rest.working')}>
                              {c.conflict && <span aria-hidden="true">⚠ </span>}{c.shifts.map(shiftLabel).join(' · ')}
                            </span>
                          )}
                          {c.state === 'REST' && <span className="rest-pill rest">{t('rest.restsOn')}</span>}
                          {c.state === 'OFF' && <span className="muted">{t('rest.off')}</span>}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                {(['work', 'rest', 'off'] as const).map((k) => (
                  <tr key={k} className={`rest-total ${k}`} data-testid={`rest-total-${k}`}>
                    <th scope="row" colSpan={2}>{t(k === 'work' ? 'rest.worksCount' : k === 'rest' ? 'rest.restsCount' : 'rest.offCount')}</th>
                    {totals.map((tot, i) => <td key={week.days[i]} data-label={dayLabel(week.days[i]!)}>{tot[k]}</td>)}
                  </tr>
                ))}
              </tfoot>
            </table>
          )}
          <p className="muted hint">{t('rest.legend')}</p>
        </Card>
      )}
    </>
  );
}
