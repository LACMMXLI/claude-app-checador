'use client';

import { type FormEvent, useState } from 'react';
import { Card, Disclosure, Empty, ErrorBox, Field, Loading, OneTimeSecret, useAction, useLoad } from '@/components/ui';
import { api, type Branch, type Employee } from '@/lib/api';
import { t } from '@/lib/i18n';

interface RoleRow { id: string; name: string; permissions: string[] }
interface Member {
  membershipId: string; userId: string; email: string; displayName: string; status: 'ACTIVE' | 'INACTIVE' | 'REMOVED'; employeeId: string | null;
  roles: { id: string; roleName: string; scope: 'ORGANIZATION' | 'BRANCHES'; branchIds: string[] }[];
}
interface Invitation { id: string; email: string; scope: string; expiresAt: string; acceptedAt: string | null; revokedAt: string | null }

/**
 * Usuarios = membresías del negocio. Aquí NO existe gestión de contraseñas (pertenecen a la identidad
 * global de la plataforma, D-11): solo invitar, activar/desactivar/quitar, roles y ficha de empleado.
 */
export default function UsersPage() {
  const members = useLoad(() => api<Member[]>('/members'));
  const invitations = useLoad(() => api<Invitation[]>('/invitations'));
  const roles = useLoad(() => api<RoleRow[]>('/roles'));
  const branches = useLoad(() => api<Branch[]>('/branches'));
  const employees = useLoad(() => api<Employee[]>('/employees?status=ACTIVE'));
  const action = useAction();
  const [form, setForm] = useState({ email: '', roleId: '', scope: 'BRANCHES' as 'ORGANIZATION' | 'BRANCHES', branchIds: [] as string[] });
  const [link, setLink] = useState<string | null>(null);
  const branchName = (id: string) => branches.data?.find((b) => b.id === id)?.name ?? id.slice(0, 8);

  async function invite(e: FormEvent) {
    e.preventDefault();
    const scope = form.scope === 'ORGANIZATION' ? { type: 'ORGANIZATION' } : { type: 'BRANCHES', branchIds: form.branchIds };
    const r = await action.run(() => api<{ acceptPath: string }>('/invitations', { method: 'POST', body: { email: form.email, roleId: form.roleId, scope } }));
    if (r) {
      setLink(`${window.location.origin}${r.acceptPath}`);
      setForm({ ...form, email: '' });
      await invitations.reload();
    }
  }
  async function setStatus(m: Member, status: Member['status']) {
    if (await action.run(() => api(`/members/${m.membershipId}/status`, { method: 'PATCH', body: { status } }))) await members.reload();
  }
  async function linkEmployee(m: Member, employeeId: string) {
    if (await action.run(() => api(`/members/${m.membershipId}/employee`, { method: 'PATCH', body: { employeeId: employeeId || null } }))) await members.reload();
  }
  async function revokeInvitation(id: string) {
    if (await action.run(() => api(`/invitations/${id}/revoke`, { method: 'POST' }))) await invitations.reload();
  }

  return (
    <>
      <h1>{t('users.title')}</h1>
      <ErrorBox message={members.error ?? action.error} />
      {link && <OneTimeSecret label={t('users.invitationLink')} value={link} onClose={() => setLink(null)} />}
      <Disclosure title={t('users.invite')}>
        <form className="row" onSubmit={invite}>
          <Field label={t('login.email')}><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label={t('users.role')}>
            <select required value={form.roleId} onChange={(e) => setForm({ ...form, roleId: e.target.value })}>
              <option value="" />
              {roles.data?.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </select>
          </Field>
          <Field label={t('users.scope')}>
            <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value as 'ORGANIZATION' | 'BRANCHES' })}>
              <option value="BRANCHES">{t('users.scope.BRANCHES')}</option>
              <option value="ORGANIZATION">{t('users.scope.ORGANIZATION')}</option>
            </select>
          </Field>
          {form.scope === 'BRANCHES' && (
            <Field label={t('nav.branches')}>
              <select multiple required value={form.branchIds} onChange={(e) => setForm({ ...form, branchIds: [...e.target.selectedOptions].map((o) => o.value) })}>
                {branches.data?.filter((b) => b.isActive).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
            </Field>
          )}
          <button className="primary" disabled={action.busy}>{t('users.invite')}</button>
        </form>
      </Disclosure>
      <Card title={t('users.members')} icon="shield">
        {!members.data ? <Loading /> : (
          <table>
            <thead><tr><th>{t('common.name')}</th><th>{t('users.role')}</th><th>{t('users.linkEmployee')}</th><th>{t('common.status')}</th><th>{t('common.actions')}</th></tr></thead>
            <tbody>
              {members.data.map((m) => (
                <tr key={m.membershipId}>
                  <td>{m.displayName}<br /><span className="muted">{m.email}</span></td>
                  <td>{m.roles.map((r) => <div key={r.id}>{r.roleName} · {r.scope === 'ORGANIZATION' ? t('users.scope.ORGANIZATION') : r.branchIds.map(branchName).join(', ')}</div>)}</td>
                  <td>
                    <select value={m.employeeId ?? ''} onChange={(e) => void linkEmployee(m, e.target.value)} aria-label={t('users.linkEmployee')}>
                      <option value="">{t('users.noEmployee')}</option>
                      {employees.data?.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} · {e.firstName} {e.lastName}</option>)}
                    </select>
                  </td>
                  <td>{t(`users.status.${m.status}`)}</td>
                  <td className="row">
                    {m.status !== 'ACTIVE' && <button onClick={() => void setStatus(m, 'ACTIVE')}>{t('common.activate')}</button>}
                    {m.status === 'ACTIVE' && <button onClick={() => void setStatus(m, 'INACTIVE')}>{t('common.deactivate')}</button>}
                    {m.status !== 'REMOVED' && <button onClick={() => void setStatus(m, 'REMOVED')}>{t('users.status.REMOVED')}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title={t('users.invitations')}>
        {!invitations.data ? <Loading /> : invitations.data.length === 0 ? <Empty /> : (
          <table>
            <thead><tr><th>{t('login.email')}</th><th>{t('users.scope')}</th><th>{t('common.status')}</th><th /></tr></thead>
            <tbody>
              {invitations.data.map((i) => {
                const pending = !i.acceptedAt && !i.revokedAt && new Date(i.expiresAt) > new Date();
                return (
                  <tr key={i.id}>
                    <td>{i.email}</td>
                    <td>{t(`users.scope.${i.scope}`)}</td>
                    <td>{i.acceptedAt ? 'Aceptada' : i.revokedAt ? 'Revocada' : pending ? 'Pendiente' : 'Vencida'}</td>
                    <td>{pending && <button onClick={() => void revokeInvitation(i.id)}>{t('users.revoke')}</button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
