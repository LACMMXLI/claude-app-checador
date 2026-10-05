'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { AttendanceHistory } from '@/components/attendance';
import { RestDaysPicker } from '@/components/rest-days';
import { Card, Empty, ErrorBox, Field, Loading, OneTimeSecret, Status, useAction, useLoad } from '@/components/ui';
import { api, type Branch, type Employee, type Shift } from '@/lib/api';
import { dayLabel, minutesLabel, shiftLabel } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Assignment { id: string; branchId: string; kind: 'PRIMARY' | 'TEMPORARY'; validFrom: string; validTo: string | null; reason: string | null }
type Detail = Employee & { hasPin: boolean; notes: string | null; assignments: Assignment[] };

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => api<Detail>(`/employees/${id}`), [id]);
  const branches = useLoad(() => api<Branch[]>('/branches'));
  const upcoming = useLoad(() => (can('schedules.view') ? api<Shift[]>(`/employees/${id}/shifts`) : Promise.resolve([] as Shift[])), [id]);
  const action = useAction();
  const [edit, setEdit] = useState({ firstName: '', lastName: '', phone: '', birthDate: '' });
  const [restDays, setRestDays] = useState<number[]>([]);
  const [assign, setAssign] = useState({ branchId: '', kind: 'TEMPORARY' as 'PRIMARY' | 'TEMPORARY', validFrom: '', validTo: '', reason: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const branchName = (b: string) => branches.data?.find((x) => x.id === b)?.name ?? b.slice(0, 8);

  useEffect(() => {
    if (data) {
      setEdit({ firstName: data.firstName, lastName: data.lastName, phone: data.phone ?? '', birthDate: data.birthDate ?? '' });
      setRestDays(data.restDays);
    }
  }, [data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (await action.run(() => api(`/employees/${id}`, { method: 'PATCH', body: { ...edit, phone: edit.phone || null, birthDate: edit.birthDate || null, restDays } }))) await reload();
  }
  async function resetPin() {
    const reason = window.prompt(t('common.reason')) ?? undefined;
    const r = await action.run(() => api<{ pin: string }>(`/employees/${id}/pin`, { method: 'POST', body: { reason } }));
    if (r) setSecret(r.pin);
  }
  async function toggle() {
    if (!data) return;
    if (data.status === 'ACTIVE') {
      const reason = window.prompt(t('common.reason'));
      if (!reason) return;
      if (await action.run(() => api(`/employees/${id}/deactivate`, { method: 'POST', body: { reason } }))) await reload();
    } else {
      const r = await action.run(() => api<{ pin: string }>(`/employees/${id}/reactivate`, { method: 'POST', body: {} }));
      if (r) { setSecret(r.pin); await reload(); }
    }
  }
  async function addAssignment(e: FormEvent) {
    e.preventDefault();
    const body = { ...assign, validTo: assign.validTo || null, reason: assign.reason || undefined };
    if (await action.run(() => api(`/employees/${id}/assignments`, { method: 'POST', body }))) await reload();
  }

  if (!data) return error ? <ErrorBox message={error} /> : <Loading />;
  const manage = can('employees.manage');
  return (
    <>
      <h1>{data.firstName} {data.lastName} <Status active={data.status === 'ACTIVE'} /></h1>
      <ErrorBox message={action.error} />
      {secret && <OneTimeSecret label={t('employees.pinCreated')} value={secret} onClose={() => setSecret(null)} />}
      <Card title={`${t('employees.number')} ${data.employeeNumber}`} actions={
        <div className="row">
          {can('employees.pin.manage') && data.status === 'ACTIVE' && <button onClick={() => void resetPin()}>{t('employees.resetPin')}</button>}
          {manage && <button onClick={() => void toggle()}>{data.status === 'ACTIVE' ? t('common.deactivate') : t('common.activate')}</button>}
          {can('settings.manage') && <Link href={`/politicas?employeeId=${id}&branchId=${data.primaryBranchId ?? ''}`}>{t('employees.policy')}</Link>}
        </div>
      }>
        <form className="row" onSubmit={save}>
          <Field label={t('employees.firstName')}><input disabled={!manage} value={edit.firstName} onChange={(e) => setEdit({ ...edit, firstName: e.target.value })} /></Field>
          <Field label={t('employees.lastName')}><input disabled={!manage} value={edit.lastName} onChange={(e) => setEdit({ ...edit, lastName: e.target.value })} /></Field>
          <Field label={t('employees.phone')}><input disabled={!manage} value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} /></Field>
          <Field label={`${t('employees.birthDate')}${data.age !== null ? ` · ${data.age} ${t('employees.ageYears')}` : ''}`}>
            <input type="date" disabled={!manage} value={edit.birthDate} max={new Date().toISOString().slice(0, 10)} onChange={(e) => setEdit({ ...edit, birthDate: e.target.value })} />
          </Field>
          <RestDaysPicker value={restDays} onChange={setRestDays} disabled={!manage} />
          {manage && <button className="primary" disabled={action.busy}>{t('common.save')}</button>}
        </form>
      </Card>
      {can('schedules.view') && (
        <Card title={t('schedule.upcoming')}>
          {!upcoming.data ? <Loading /> : upcoming.data.length === 0 ? <Empty /> : (
            <table>
              <thead><tr><th>{t('schedule.date')}</th><th>{t('common.branch')}</th><th>{t('schedule.start')} – {t('schedule.end')}</th><th>{t('schedule.duration')}</th><th>{t('common.status')}</th><th>{t('nav.schedule')}</th></tr></thead>
              <tbody>
                {upcoming.data.map((s) => (
                  <tr key={s.id}>
                    <td>{dayLabel(s.businessDate)}</td>
                    <td>{branchName(s.branchId)}</td>
                    <td>{shiftLabel(s)}</td>
                    <td>{minutesLabel(s.scheduledMinutes)}</td>
                    <td>{s.status === 'CANCELLED' ? t('schedule.cancelled') : '—'}</td>
                    <td>{s.scheduleStatus ? t(`schedule.status.${s.scheduleStatus}`) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {can('attendance.view') && <AttendanceHistory employeeId={id} />}
      <Card title={t('employees.assignments')}>
        <table>
          <thead><tr><th>{t('common.branch')}</th><th>Tipo</th><th>{t('employees.validFrom')}</th><th>{t('employees.validTo')}</th><th>{t('common.reason')}</th></tr></thead>
          <tbody>
            {data.assignments.map((a) => (
              <tr key={a.id}><td>{branchName(a.branchId)}</td><td>{t(`employees.kind.${a.kind}`)}</td><td>{a.validFrom}</td><td>{a.validTo ?? '—'}</td><td>{a.reason ?? ''}</td></tr>
            ))}
          </tbody>
        </table>
        {manage && (
          <form className="row" onSubmit={addAssignment} style={{ marginTop: '1rem' }}>
            <Field label={t('common.branch')}>
              <select required value={assign.branchId} onChange={(e) => setAssign({ ...assign, branchId: e.target.value })}>
                <option value="" />
                {branches.data?.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <Field label="Tipo">
              <select value={assign.kind} onChange={(e) => setAssign({ ...assign, kind: e.target.value as 'PRIMARY' | 'TEMPORARY' })}>
                <option value="TEMPORARY">{t('employees.kind.TEMPORARY')}</option>
                <option value="PRIMARY">{t('employees.kind.PRIMARY')}</option>
              </select>
            </Field>
            <Field label={t('employees.validFrom')}><input type="date" required value={assign.validFrom} onChange={(e) => setAssign({ ...assign, validFrom: e.target.value })} /></Field>
            <Field label={t('employees.validTo')}><input type="date" value={assign.validTo} onChange={(e) => setAssign({ ...assign, validTo: e.target.value })} /></Field>
            <Field label={t('common.reason')}><input value={assign.reason} onChange={(e) => setAssign({ ...assign, reason: e.target.value })} /></Field>
            <button className="primary" disabled={action.busy}>{t('employees.assign')}</button>
          </form>
        )}
      </Card>
    </>
  );
}
