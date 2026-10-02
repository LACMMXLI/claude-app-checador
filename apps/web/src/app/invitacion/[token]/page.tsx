'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

interface Preview { organizationName: string; email: string; expiresAt: string; userExists: boolean }

/** Reclamar una invitación: el invitado pone SUS credenciales (o prueba las actuales si ya tiene cuenta). */
export default function InvitationPage() {
  const { token } = useParams<{ token: string }>();
  const { data, error: loadError } = useLoad(() => api<Preview>(`/auth/invitations/${encodeURIComponent(token)}`), [token]);
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [done, setDone] = useState(false);
  const { error, busy, run } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await run(() => api(`/auth/invitations/${encodeURIComponent(token)}/accept`, { method: 'POST', body: { password, displayName } }));
    setPassword('');
    if (ok) setDone(true);
  }

  return (
    <div className="center">
      <Card title={t('invitation.title')}>
        {loadError && <ErrorBox message={loadError} />}
        {!data && !loadError && <Loading />}
        {done && <p>{t('invitation.done')} <Link href="/login">{t('login.title')}</Link></p>}
        {data && !done && (
          <form className="stack" onSubmit={submit}>
            <p><strong>{data.organizationName}</strong> · {data.email}</p>
            <p className="muted">{data.userExists ? t('invitation.existing') : t('invitation.new')}</p>
            {!data.userExists && (
              <Field label={t('invitation.displayName')}>
                <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
            )}
            <Field label={t('login.password')}>
              <input type="password" autoComplete={data.userExists ? 'current-password' : 'new-password'} required minLength={data.userExists ? 1 : 10} value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <ErrorBox message={error} />
            <button className="primary" disabled={busy}>{t('invitation.accept')}</button>
          </form>
        )}
      </Card>
    </div>
  );
}
