'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useEffect, useState } from 'react';
import { Card, ErrorBox, Field, Loading, OneTimeSecret, Status, useAction, useLoad } from '@/components/ui';
import { api, type Branch, type Employee } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Assignment { id: string; branchId: string; kind: 'PRIMARY' | 'TEMPORARY'; validFrom: string; validTo: string | null; reason: string | null }
type Detail = Employee & { hasPin: boolean; notes: string | null; assignments: Assignment[] };

export default function EmployeeDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => api<Detail>(`/employees/${id}`), [id]);
  const branches = useLoad(() => api<Branch[]>('/branches'));
  const action = useAction();
  const [edit, setEdit] = useState({ firstName: '', lastName: '', phone: '' });
  const [assign, setAssign] = useState({ branchId: '', kind: 'TEMPORARY' as 'PRIMARY' | 'TEMPORARY', validFrom: '', validTo: '', reason: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const branchName = (b: string) => branches.data?.find((x) => x.id === b)?.name ?? b.slice(0, 8);

  useEffect(() => {
    if (data) setEdit({ firstName: data.firstName, lastName: data.lastName, phone: data.phone ?? '' });
  }, [data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (await action.run(() => api(`/employees/${id}`, { method: 'PATCH', body: { ...edit, phone: edit.phone || null } }))) await reload();
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
          {manage && <button className="primary" disabled={action.busy}>{t('common.save')}</button>}
        </form>
      </Card>
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
