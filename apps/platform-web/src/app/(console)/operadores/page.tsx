'use client';

import { type FormEvent, useState } from 'react';
import { Card, Disclosure, ErrorBox, Field, Loading, OneTimeSecret, PasswordInput, useAction, useLoad } from '@/components/ui';
import { api, type OperatorRow } from '@/lib/api';
import { fmtDateTime, t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

export default function OperatorsPage() {
  const { operator } = useSession();
  const { data, error, reload } = useLoad(() => api<OperatorRow[]>('/operators'));
  const action = useAction();
  const [form, setForm] = useState({ displayName: '', email: '', password: '' });
  const [secret, setSecret] = useState<{ label: string; value: string } | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    const res = await action.run(() => api<{ operator: OperatorRow; initialPassword: string | null }>('/operators', { method: 'POST', body: { displayName: form.displayName, email: form.email, ...(form.password ? { password: form.password } : {}) } }), t('operators.created'));
    if (!res) return;
    if (res.initialPassword) setSecret({ label: `${t('new.credentials')} · ${res.operator.email}`, value: res.initialPassword });
    setForm({ displayName: '', email: '', password: '' });
    await reload();
  }
  async function setStatus(o: OperatorRow, status: 'ACTIVE' | 'DISABLED') {
    if (await action.run(() => api(`/operators/${o.id}/status`, { method: 'POST', body: { status } }))) await reload();
  }
  async function reset(o: OperatorRow) {
    if (!window.confirm(t('detail.resetConfirm'))) return;
    const res = await action.run(() => api<{ password: string }>(`/operators/${o.id}/reset-password`, { method: 'POST' }));
    if (res) setSecret({ label: `${t('detail.newPassword')} · ${o.email}`, value: res.password });
  }

  return (
    <>
      <h1>{t('operators.title')}</h1>
      <p className="muted">{t('operators.help')}</p>
      <ErrorBox message={error ?? action.error} />
      {secret && <OneTimeSecret label={secret.label} value={secret.value} onClose={() => setSecret(null)} />}
      <Disclosure title={t('operators.new')}>
        <form className="row" onSubmit={create} data-testid="new-operator">
          <Field label={t('operators.name')}><input required value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} /></Field>
          <Field label={t('operators.email')}><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label={t('operators.password')}><PasswordInput autoComplete="new-password" minLength={10} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <button className="primary" disabled={action.busy}>{t('operators.create')}</button>
        </form>
        <p className="muted">{t('operators.passwordHelp')}</p>
      </Disclosure>
      <Card>
        {!data ? <Loading /> : (
          <table data-testid="operators">
            <thead><tr><th>{t('operators.name')}</th><th>{t('operators.email')}</th><th>{t('customers.state')}</th><th>{t('operators.lastLogin')}</th><th /></tr></thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id}>
                  <td>{o.displayName}{o.id === operator?.id ? <span className="muted"> (tú)</span> : null}</td>
                  <td>{o.email}</td>
                  <td><span className={`badge ${o.status === 'ACTIVE' ? 'ok' : 'off'}`}>{o.status === 'ACTIVE' ? t('common.active') : t('common.inactive')}</span></td>
                  <td>{o.lastLoginAt ? fmtDateTime(o.lastLoginAt) : t('operators.never')}</td>
                  <td className="row">
                    {o.id !== operator?.id && (o.status === 'ACTIVE'
                      ? <button className="danger" onClick={() => void setStatus(o, 'DISABLED')}>{t('operators.disable')}</button>
                      : <button className="secondary" onClick={() => void setStatus(o, 'ACTIVE')}>{t('operators.enable')}</button>)}
                    {o.id !== operator?.id && <button className="secondary" onClick={() => void reset(o)}>{t('operators.reset')}</button>}
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
