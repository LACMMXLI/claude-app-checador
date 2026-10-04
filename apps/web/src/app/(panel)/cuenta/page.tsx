'use client';

import { type FormEvent, useMemo, useState } from 'react';
import { Icon } from '@/components/icons';
import { Card, ErrorBox, Field, PasswordInput, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

/** 0–4 según longitud y variedad; solo orienta (la regla real es 10+ caracteres, validada en el servidor). */
function strength(pw: string): number {
  if (!pw) return 0;
  let score = 0;
  if (pw.length >= 10) score += 1;
  if (pw.length >= 14) score += 1;
  if (/[a-z]/.test(pw) && /[A-Z]/.test(pw)) score += 1;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score += 1;
  return pw.length < 10 ? Math.min(score, 1) || 1 : Math.max(score, 1);
}

/**
 * Mi cuenta (D-80): perfil y cambio de la PROPIA contraseña. La contraseña es de la persona (identidad global): nadie
 * más puede verla ni cambiarla. Al cambiarla se cierran sus demás sesiones y esta se conserva.
 */
export default function AccountPage() {
  const { me } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const { error, busy, run } = useAction();
  const level = useMemo(() => strength(next), [next]);
  if (!me) return null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMismatch(false);
    if (next !== again) return setMismatch(true);
    const ok = await run(() => api('/auth/change-password', { method: 'POST', body: { currentPassword: current, newPassword: next } }), t('account.changed'));
    if (ok) {
      setCurrent('');
      setNext('');
      setAgain('');
    }
  }

  return (
    <>
      <h1>{t('account.title')}</h1>
      <p className="muted" style={{ marginTop: '-.6rem', marginBottom: '1.2rem' }}>{t('account.subtitle')}</p>
      <div className="account">
        <Card title={t('account.profile')} icon="user">
          <div className="profile">
            <span className="avatar" aria-hidden="true">{(me.user.displayName || me.user.email).charAt(0).toUpperCase()}</span>
            <dl>
              <dt>{t('account.name')}</dt><dd>{me.user.displayName}</dd>
              <dt>{t('account.email')}</dt><dd>{me.user.email}</dd>
              <dt>{t('account.business')}</dt><dd>{me.activeOrganization?.name ?? '—'}</dd>
            </dl>
          </div>
        </Card>
        <Card title={t('account.password')} icon="key">
          <form className="stack" onSubmit={submit} data-testid="password-form">
            <Field label={t('account.current')}>
              <PasswordInput autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
            </Field>
            <Field label={t('account.new')}>
              <PasswordInput autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
            </Field>
            {next && (
              <div aria-live="polite">
                <div className="meter" data-level={level} aria-hidden="true"><span /><span /><span /><span /></div>
                <div className="meter-label"><span>{t(`account.strength.${level}`)}</span><span>{t('account.min')}</span></div>
              </div>
            )}
            <Field label={t('account.confirm')}>
              <PasswordInput autoComplete="new-password" required value={again} onChange={(e) => setAgain(e.target.value)} />
            </Field>
            {mismatch && <p className="error" role="alert">{t('account.mismatch')}</p>}
            <ErrorBox message={error} />
            <p className="muted" style={{ margin: 0, display: 'flex', gap: '.5rem', alignItems: 'flex-start' }}><Icon name="lock" size={16} style={{ marginTop: 3 }} />{t('account.hint')}</p>
            <div><button className="primary" disabled={busy || !current || next.length < 10 || !again}>{t('account.submit')}</button></div>
          </form>
        </Card>
      </div>
    </>
  );
}
