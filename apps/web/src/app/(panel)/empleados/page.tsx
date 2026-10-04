'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { Card, Disclosure, Empty, ErrorBox, Field, Loading, OneTimeSecret, Status, useAction, useLoad } from '@/components/ui';
import { api, type Branch, type Employee } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

export default function EmployeesPage() {
  const { can } = useSession();
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'INACTIVE'>('ACTIVE');
  const { data, error, reload } = useLoad(() => api<Employee[]>(`/employees${status ? `?status=${status}` : ''}`), [status]);
  const branches = useLoad(() => api<Branch[]>('/branches'));
  const action = useAction();
  const [form, setForm] = useState({ employeeNumber: '', firstName: '', lastName: '', phone: '', primaryBranchId: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const branchName = (id: string) => branches.data?.find((b) => b.id === id)?.name ?? '—';

  async function create(e: FormEvent) {
    e.preventDefault();
    const res = await action.run(() => api<{ pin: string }>('/employees', { method: 'POST', body: { ...form, phone: form.phone || undefined } }));
    if (res) {
      setSecret(res.pin);
      setForm({ employeeNumber: '', firstName: '', lastName: '', phone: '', primaryBranchId: form.primaryBranchId });
      await reload();
    }
  }

  return (
    <>
      <h1>{t('employees.title')}</h1>
      <ErrorBox message={error ?? action.error} />
      {secret && <OneTimeSecret label={t('employees.pinCreated')} value={secret} onClose={() => setSecret(null)} />}
      {can('employees.manage') && (
        <Disclosure title={t('employees.new')}>
          <form className="row" onSubmit={create}>
            <Field label={t('employees.number')}><input required value={form.employeeNumber} onChange={(e) => setForm({ ...form, employeeNumber: e.target.value })} /></Field>
            <Field label={t('employees.firstName')}><input required value={form.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} /></Field>
            <Field label={t('employees.lastName')}><input value={form.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} /></Field>
            <Field label={t('employees.phone')}><input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label={t('employees.primaryBranch')}>
              <select required value={form.primaryBranchId} onChange={(e) => setForm({ ...form, primaryBranchId: e.target.value })}>
                <option value="" />
                {branches.data?.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
            <button className="primary" disabled={action.busy}>{t('common.create')}</button>
          </form>
        </Disclosure>
      )}
      <Card actions={
        <select value={status} onChange={(e) => setStatus(e.target.value as typeof status)} aria-label={t('common.status')}>
          <option value="ACTIVE">{t('common.active')}</option>
          <option value="INACTIVE">{t('common.inactive')}</option>
          <option value="">—</option>
        </select>
      }>
        {!data ? <Loading /> : data.length === 0 ? <Empty /> : (
          <table>
            <thead><tr><th>{t('employees.number')}</th><th>{t('common.name')}</th><th>{t('employees.primaryBranch')}</th><th>{t('employees.branches')}</th><th>{t('common.status')}</th></tr></thead>
            <tbody>
              {data.map((e) => (
                <tr key={e.id}>
                  <td>{e.employeeNumber}</td>
                  <td><Link href={`/empleados/${e.id}`}>{e.firstName} {e.lastName}</Link></td>
                  <td>{e.primaryBranchId ? branchName(e.primaryBranchId) : '—'}</td>
                  <td>{e.branchIds.map(branchName).join(', ')}</td>
                  <td><Status active={e.status === 'ACTIVE'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
