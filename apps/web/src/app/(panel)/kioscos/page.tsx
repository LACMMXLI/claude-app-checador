'use client';

import { type FormEvent, useState } from 'react';
import { Card, ErrorBox, Field, Loading, OneTimeSecret, Status, useAction, useLoad } from '@/components/ui';
import { api, type Branch } from '@/lib/api';
import { t } from '@/lib/i18n';

interface Kiosk {
  id: string;
  name: string;
  branchId: string;
  status: 'ACTIVE' | 'INACTIVE';
  state: 'ACTIVE' | 'PENDING_ACTIVATION' | 'NO_CREDENTIAL' | 'INACTIVE';
  hasToken: boolean;
  tokenIssuedAt: string | null;
  activatedAt: string | null;
  lastSeenAt: string | null;
  lastSeenIp: string | null;
}

/**
 * El token completo solo se muestra al crearlo o regenerarlo; la lista nunca lo incluye. Estado derivado (D-76):
 * pendiente de activar · activo · sin credencial · inactivo. "Revocar ahora" deja fuera al navegador en su siguiente
 * petición aunque conserve su cookie (el servidor valida la credencial en cada llamada).
 */
export default function KiosksPage() {
  const { data, error, reload } = useLoad(() => api<Kiosk[]>('/kiosks'));
  const branches = useLoad(() => api<Branch[]>('/branches'));
  const action = useAction();
  const [form, setForm] = useState({ name: '', branchId: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const when = (d: string | null) => (d ? new Date(d).toLocaleString('es-MX') : '—');

  async function create(e: FormEvent) {
    e.preventDefault();
    const r = await action.run(() => api<{ token: string }>('/kiosks', { method: 'POST', body: form }));
    if (r) { setSecret(r.token); setForm({ ...form, name: '' }); await reload(); }
  }
  async function regenerate(k: Kiosk) {
    const r = await action.run(() => api<{ token: string }>(`/kiosks/${k.id}/token`, { method: 'POST', body: {} }));
    if (r) { setSecret(r.token); await reload(); }
  }
  async function revoke(k: Kiosk) {
    if (await action.run(() => api(`/kiosks/${k.id}/token/revoke`, { method: 'POST', body: {} }))) await reload();
  }
  async function toggle(k: Kiosk) {
    if (await action.run(() => api(`/kiosks/${k.id}/status`, { method: 'POST', body: { status: k.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' } }))) await reload();
  }
  async function move(k: Kiosk, branchId: string) {
    if (await action.run(() => api(`/kiosks/${k.id}`, { method: 'PATCH', body: { branchId } }))) await reload();
  }

  return (
    <>
      <h1>{t('kiosks.title')}</h1>
      <p className="muted">{t('kiosks.howTo')}</p>
      <ErrorBox message={error ?? action.error} />
      {secret && <OneTimeSecret label={t('kiosks.tokenCreated')} value={secret} onClose={() => setSecret(null)} />}
      <Card title={t('kiosks.new')}>
        <form className="row" onSubmit={create}>
          <Field label={t('common.name')}><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label={t('common.branch')}>
            <select required value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
              <option value="" />
              {branches.data?.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <button className="primary" disabled={action.busy}>{t('common.create')}</button>
        </form>
      </Card>
      <Card>
        {!data ? <Loading /> : data.length === 0 ? <p className="muted">{t('common.empty')}</p> : (
          <table>
            <thead><tr><th>{t('common.name')}</th><th>{t('common.branch')}</th><th>{t('kiosks.state')}</th><th>{t('kiosks.token')}</th><th>{t('kiosks.activatedAt')}</th><th>{t('kiosks.lastSeen')}</th><th>{t('common.status')}</th><th>{t('common.actions')}</th></tr></thead>
            <tbody>
              {data.map((k) => (
                <tr key={k.id} data-testid={`kiosk-${k.id}`}>
                  <td>{k.name}</td>
                  <td>
                    <select value={k.branchId} onChange={(e) => void move(k, e.target.value)} aria-label={t('common.branch')}>
                      {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </td>
                  <td><span className={`badge kiosk-${k.state}`} data-testid="kiosk-state">{t(`kiosks.state.${k.state}`)}</span></td>
                  <td>{k.hasToken ? `${t('kiosks.hasToken')} · ${when(k.tokenIssuedAt)}` : t('kiosks.noToken')}</td>
                  <td>{when(k.activatedAt)}</td>
                  <td>{when(k.lastSeenAt)}{k.lastSeenIp ? <div className="muted">{t('kiosks.lastIp')}: {k.lastSeenIp}</div> : null}</td>
                  <td><Status active={k.status === 'ACTIVE'} /></td>
                  <td className="row">
                    <button onClick={() => void regenerate(k)}>{t('kiosks.regenerate')}</button>
                    {k.hasToken && <button className="danger" title={t('kiosks.revokeHelp')} onClick={() => void revoke(k)}>{t('kiosks.revokeNow')}</button>}
                    <button onClick={() => void toggle(k)}>{k.status === 'ACTIVE' ? t('common.deactivate') : t('common.activate')}</button>
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
