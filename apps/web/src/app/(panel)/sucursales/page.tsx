'use client';

import { type FormEvent, useState } from 'react';
import { Card, ErrorBox, Field, Loading, Status, useAction, useLoad } from '@/components/ui';
import { api, type Branch } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

export default function BranchesPage() {
  const { can } = useSession();
  const { data, error, reload } = useLoad(() => api<Branch[]>('/branches'));
  const action = useAction();
  const [form, setForm] = useState({ code: '', name: '', timezone: '' });
  const [editing, setEditing] = useState<Branch | null>(null);
  const manage = can('branches.manage');

  async function create(e: FormEvent) {
    e.preventDefault();
    const ok = await action.run(() => api('/branches', { method: 'POST', body: { ...form, timezone: form.timezone || null } }));
    if (ok) { setForm({ code: '', name: '', timezone: '' }); await reload(); }
  }
  async function save(e: FormEvent) {
    e.preventDefault();
    if (!editing) return;
    const ok = await action.run(() => api(`/branches/${editing.id}`, { method: 'PATCH', body: { name: editing.name, timezone: editing.timezone || null } }));
    if (ok) { setEditing(null); await reload(); }
  }
  async function toggle(b: Branch) {
    if (await action.run(() => api(`/branches/${b.id}`, { method: 'PATCH', body: { isActive: !b.isActive } }))) await reload();
  }

  return (
    <>
      <h1>{t('branches.title')}</h1>
      <ErrorBox message={error ?? action.error} />
      {manage && (
        <Card title={editing ? `${t('common.edit')}: ${editing.code}` : t('branches.new')}>
          {editing ? (
            <form className="row" onSubmit={save}>
              <Field label={t('common.name')}><input required value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label={t('branches.timezone')}><input placeholder={t('common.inherited')} value={editing.timezone ?? ''} onChange={(e) => setEditing({ ...editing, timezone: e.target.value })} /></Field>
              <button className="primary" disabled={action.busy}>{t('common.save')}</button>
              <button type="button" onClick={() => setEditing(null)}>{t('common.cancel')}</button>
            </form>
          ) : (
            <form className="row" onSubmit={create}>
              <Field label={t('common.code')}><input required pattern="[A-Za-z0-9_-]{1,32}" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} /></Field>
              <Field label={t('common.name')}><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label={t('branches.timezone')}><input placeholder={t('common.inherited')} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></Field>
              <button className="primary" disabled={action.busy}>{t('common.create')}</button>
            </form>
          )}
        </Card>
      )}
      <Card>
        {!data ? <Loading /> : data.length === 0 ? <p className="muted">{t('common.empty')}</p> : (
          <table>
            <thead><tr><th>{t('common.code')}</th><th>{t('common.name')}</th><th>{t('branches.effectiveTimezone')}</th><th>{t('common.status')}</th>{manage && <th>{t('common.actions')}</th>}</tr></thead>
            <tbody>
              {data.map((b) => (
                <tr key={b.id}>
                  <td>{b.code}</td>
                  <td>{b.name}</td>
                  <td>{b.effectiveTimezone}{!b.timezone && <span className="muted"> ({t('common.inherited').toLowerCase()})</span>}</td>
                  <td><Status active={b.isActive} /></td>
                  {manage && (
                    <td className="row">
                      <button onClick={() => setEditing(b)}>{t('common.edit')}</button>
                      <button onClick={() => void toggle(b)}>{b.isActive ? t('common.deactivate') : t('common.activate')}</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}
