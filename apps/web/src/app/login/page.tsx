'use client';

import { useRouter } from 'next/navigation';
import { type FormEvent, useState } from 'react';
import { Icon } from '@/components/icons';
import { ErrorBox, Field, PasswordInput, useAction } from '@/components/ui';
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
    const me = await run(() => api<Me>('/auth/login', { method: 'POST', body: { email, password } }), false);
    setPassword('');
    if (!me) return;
    await reload();
    router.replace(me.activeOrganization ? '/' : '/seleccionar-negocio');
  }

  return (
    <div className="auth">
      <aside className="auth-hero" aria-hidden="true">
        <span className="blob a" />
        <span className="blob b" />
        <span className="brand-mark" style={{ width: 54, height: 54, borderRadius: 16 }}><Icon name="clock" size={30} /></span>
        <h1>{t('login.heroTitle')}</h1>
        <p>{t('login.heroText')}</p>
        <ul>
          <li><span className="dot"><Icon name="tablet" size={18} /></span>{t('login.feature1')}</li>
          <li><span className="dot"><Icon name="activity" size={18} /></span>{t('login.feature2')}</li>
          <li><span className="dot"><Icon name="chart" size={18} /></span>{t('login.feature3')}</li>
        </ul>
      </aside>
      <main className="auth-form">
        <div className="auth-card">
          <h2>{t('login.welcome')}</h2>
          <p>{t('login.subtitle')}</p>
          <form className="stack" onSubmit={submit}>
            <Field label={t('login.email')}>
              <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </Field>
            <Field label={t('login.password')}>
              <PasswordInput autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <ErrorBox message={error} />
            <button className="primary" disabled={busy}>{busy ? '…' : t('login.submit')}</button>
          </form>
        </div>
      </main>
    </div>
  );
}
