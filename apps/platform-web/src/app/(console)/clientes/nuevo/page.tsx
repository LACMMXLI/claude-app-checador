'use client';

import Link from 'next/link';
import { type FormEvent, useState } from 'react';
import { Card, ErrorBox, Field, OneTimeSecret, PasswordInput, useAction, useLoad } from '@/components/ui';
import { Icon } from '@/components/icons';
import { api, type Plan } from '@/lib/api';
import { t } from '@/lib/i18n';

interface Created { organizationId: string; slug: string; admin: { email: string; createdUser: boolean; initialPassword: string | null } }

const slugify = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
const ZONES = ['America/Tijuana', 'America/Mexico_City', 'America/Hermosillo', 'America/Mazatlan', 'America/Chihuahua', 'America/Monterrey', 'America/Cancun'];

export default function NewCustomerPage() {
  const plans = useLoad(() => api<Plan[]>('/plans'));
  const { error, busy, run } = useAction();
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [timezone, setTimezone] = useState('');
  const [branches, setBranches] = useState([{ code: '', name: '' }]);
  const [admin, setAdmin] = useState({ displayName: '', email: '', password: '' });
  const [planCode, setPlanCode] = useState('');
  const [mode, setMode] = useState<'TRIAL' | 'ACTIVE'>('TRIAL');
  const [trialDays, setTrialDays] = useState(14);
  const [periodEnd, setPeriodEnd] = useState('');
  const [notes, setNotes] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const available = plans.data?.filter((p) => p.isActive) ?? [];
  const chosen = planCode || available[0]?.code || '';

  async function submit(e: FormEvent) {
    e.preventDefault();
    const subscription = mode === 'TRIAL'
      ? { mode, planCode: chosen, trialDays }
      : { mode, planCode: chosen, currentPeriodEnd: periodEnd ? new Date(`${periodEnd}T23:59:59`).toISOString() : null };
    const res = await run(() => api<Created>('/customers', {
      method: 'POST',
      body: { name, slug, timezone, branches, admin: { displayName: admin.displayName, email: admin.email, ...(admin.password ? { password: admin.password } : {}) }, subscription, ...(notes ? { notes } : {}) },
    }), t('new.created'));
    if (res) setCreated(res);
  }

  if (created) {
    return (
      <>
        <h1>{t('new.created')}</h1>
        <Card>
          <p><strong>{created.slug}</strong> · {created.admin.email}</p>
          {created.admin.initialPassword
            ? <OneTimeSecret label={t('new.credentials')} value={created.admin.initialPassword} onClose={() => setCreated({ ...created, admin: { ...created.admin, initialPassword: null } })} />
            : <p className="muted" data-testid="no-password">{created.admin.createdUser ? '' : t('new.credentialsReuse')}</p>}
          <div className="btn-row"><Link href={`/clientes/${created.organizationId}`} className="btn-link primary-link">{t('new.goDetail')}</Link></div>
        </Card>
      </>
    );
  }

  return (
    <>
      <div className="hero"><div><Link href="/clientes" className="muted">← {t('detail.back')}</Link><h1>{t('new.title')}</h1></div></div>
      <form className="stack" onSubmit={submit} data-testid="new-customer">
        <Card title={t('new.business')} icon="building">
          <div className="row">
            <Field label={t('new.name')}><input required value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} /></Field>
            <Field label={t('new.slug')}><input required pattern="[a-z0-9]([a-z0-9\-]{0,62}[a-z0-9])?" value={slug} onChange={(e) => { setSlug(e.target.value); setSlugTouched(true); }} /></Field>
            <Field label={t('new.timezone')}>
              <select required value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                <option value="" />
                {ZONES.map((z) => <option key={z} value={z}>{z}</option>)}
              </select>
            </Field>
          </div>
          <p className="muted">{t('new.timezoneHelp')}</p>
        </Card>
        <Card title={t('new.branches')} icon="tablet">
          {branches.map((b, i) => (
            <div className="row" key={i} style={{ marginBottom: '.5rem' }}>
              <Field label={t('new.branchCode')}><input required pattern="[A-Za-z0-9_\-]{1,32}" value={b.code} onChange={(e) => setBranches(branches.map((x, j) => (j === i ? { ...x, code: e.target.value } : x)))} /></Field>
              <Field label={t('new.branchName')}><input required value={b.name} onChange={(e) => setBranches(branches.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} /></Field>
              {branches.length > 1 && <button type="button" className="secondary" onClick={() => setBranches(branches.filter((_, j) => j !== i))}>{t('new.removeBranch')}</button>}
            </div>
          ))}
          <button type="button" className="secondary" onClick={() => setBranches([...branches, { code: '', name: '' }])}><Icon name="plus" size={16} />{t('new.addBranch')}</button>
        </Card>
        <Card title={t('new.admin')} icon="user">
          <div className="row">
            <Field label={t('new.adminName')}><input required value={admin.displayName} onChange={(e) => setAdmin({ ...admin, displayName: e.target.value })} /></Field>
            <Field label={t('new.adminEmail')}><input type="email" required value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} /></Field>
            <Field label={t('new.adminPassword')}><PasswordInput autoComplete="new-password" minLength={10} value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} /></Field>
          </div>
          <p className="muted">{t('new.adminPasswordHelp')}</p>
        </Card>
        <Card title={t('new.subscription')} icon="layers">
          <div className="row">
            <Field label={t('customers.plan')}>
              <select value={chosen} onChange={(e) => setPlanCode(e.target.value)} data-testid="plan-select">
                {available.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
              </select>
            </Field>
            <Field label={t('customers.state')}>
              <select value={mode} onChange={(e) => setMode(e.target.value as 'TRIAL' | 'ACTIVE')} data-testid="mode-select">
                <option value="TRIAL">{t('new.mode.TRIAL')}</option>
                <option value="ACTIVE">{t('new.mode.ACTIVE')}</option>
              </select>
            </Field>
            {mode === 'TRIAL'
              ? <Field label={t('new.trialDays')}><input type="number" min={1} max={90} required value={trialDays} onChange={(e) => setTrialDays(Number(e.target.value))} /></Field>
              : <Field label={t('new.periodEnd')}><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></Field>}
          </div>
          <Field label={t('new.notes')}><input value={notes} maxLength={2000} onChange={(e) => setNotes(e.target.value)} /></Field>
        </Card>
        <ErrorBox message={error} />
        <div><button className="primary" disabled={busy || !chosen}>{busy ? '…' : t('new.submit')}</button></div>
      </form>
    </>
  );
}
