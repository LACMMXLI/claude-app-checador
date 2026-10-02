'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Card, ErrorBox, Field, useAction } from '@/components/ui';
import { api, type Me } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

export default function LoginPage() {
  const router = useRouter();
  const { reload } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { error, busy, run } = useAction();

  async function submit(e: FormEvent) {
    e.preventDefault();
    const me = await run(() => api<Me>('/auth/login', { method: 'POST', body: { email, password } }));
    setPassword('');
    if (!me) return;
    await reload();
    router.replace(me.activeOrganization ? '/' : '/seleccionar-negocio');
  }

  return (
    <div className="center">
      <Card title={t('login.title')}>
        <form className="stack" onSubmit={submit}>
          <Field label={t('login.email')}>
            <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          <Field label={t('login.password')}>
            <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <ErrorBox message={error} />
          <button className="primary" disabled={busy}>{t('login.submit')}</button>
        </form>
      </Card>
    </div>
  );
}
