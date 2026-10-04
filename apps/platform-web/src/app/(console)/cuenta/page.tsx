'use client';

import { type FormEvent, useState } from 'react';
import { Card, ErrorBox, Field, PasswordInput, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

export default function AccountPage() {
  const { operator } = useSession();
  const { error, busy, run, setError } = useAction();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (next !== again) { setError(t('account.mismatch')); return; }
    const ok = await run(() => api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } }).then(() => true));
    if (ok) { setCurrent(''); setNext(''); setAgain(''); }
  }

  return (
    <>
      <h1>{t('account.title')}</h1>
      <div className="account">
        <Card title={operator?.displayName ?? ''} icon="user"><p className="muted">{operator?.email}</p></Card>
        <Card title={t('account.password')} icon="key">
          <form className="stack" onSubmit={submit} data-testid="password-form">
            <Field label={t('account.current')}><PasswordInput autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} /></Field>
            <Field label={t('account.new')}><PasswordInput autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} /></Field>
            <Field label={t('account.again')}><PasswordInput autoComplete="new-password" required minLength={10} value={again} onChange={(e) => setAgain(e.target.value)} /></Field>
            <p className="muted">{t('account.help')}</p>
            <ErrorBox message={error} />
            <button className="primary" disabled={busy}>{t('account.save')}</button>
          </form>
        </Card>
      </div>
    </>
  );
}
