'use client';

import Link from 'next/link';
import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Icon } from '@/components/icons';
import { LimitText, StatusBadge } from '@/components/status';
import { Card, Empty, ErrorBox, Field, Loading, useLoad } from '@/components/ui';
import { api, type Customer, type Plan, type SubStatus } from '@/lib/api';
import { fmtDate, t } from '@/lib/i18n';

const PAGE = 25;
const STATUSES: SubStatus[] = ['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED', 'CANCELLED'];

function Validity({ c }: { c: Customer }) {
  const end = c.status === 'TRIAL' ? c.trialEndsAt : c.currentPeriodEnd;
  if (c.status !== 'TRIAL' && c.status !== 'ACTIVE') return <span className="muted">—</span>;
  if (!end) return <span className="muted">{t('customers.noValidity')}</span>;
  const expired = c.daysLeft !== null && c.daysLeft <= 0;
  return <span className={expired ? 'late' : ''}>{fmtDate(end)}{c.daysLeft !== null && <span className="muted"> · {expired ? t('customers.expired') : `${c.daysLeft} ${t('customers.daysLeft')}`}</span>}</span>;
}

function CustomersList() {
  const params = useSearchParams();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState(params.get('status') ?? '');
  const [plan, setPlan] = useState('');
  const [offset, setOffset] = useState(0);
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = setTimeout(() => { setDebounced(q); setOffset(0); }, 250);
    return () => clearTimeout(id);
  }, [q]);
  const plans = useLoad(() => api<Plan[]>('/plans'));
  const { data, error } = useLoad(() => {
    const s = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
    if (debounced) s.set('q', debounced);
    if (status) s.set('status', status);
    if (plan) s.set('plan', plan);
    return api<{ total: number; items: Customer[] }>(`/customers?${s}`);
  }, [debounced, status, plan, offset]);

  return (
    <>
      <div className="hero">
        <h1>{t('customers.title')}</h1>
        <div className="quick"><Link href="/clientes/nuevo"><Icon name="plus" size={16} />{t('customers.new')}</Link></div>
      </div>
      <div className="filters">
        <Field label={t('customers.search')}><input type="search" value={q} onChange={(e) => setQ(e.target.value)} data-testid="search" /></Field>
        <Field label={t('customers.state')}>
          <select value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }} data-testid="filter-status">
            <option value="">{t('status.all')}</option>
            {STATUSES.map((s) => <option key={s} value={s}>{t(`status.${s}`)}</option>)}
          </select>
        </Field>
        <Field label={t('customers.plan')}>
          <select value={plan} onChange={(e) => { setPlan(e.target.value); setOffset(0); }} data-testid="filter-plan">
            <option value="">{t('plan.all')}</option>
            {plans.data?.map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
          </select>
        </Field>
      </div>
      <ErrorBox message={error} />
      <Card>
        {!data ? <Loading /> : data.items.length === 0 ? <Empty text={t('customers.empty')} /> : (
          <>
            <table data-testid="customers">
              <thead><tr><th>{t('customers.business')}</th><th>{t('customers.plan')}</th><th>{t('customers.state')}</th><th>{t('customers.validity')}</th><th>{t('res.employees')}</th><th>{t('res.branches')}</th><th>{t('customers.admin')}</th></tr></thead>
              <tbody>
                {data.items.map((c) => (
                  <tr key={c.id} data-testid={`customer-${c.slug}`} className={c.effectiveStatus === 'SUSPENDED' || c.effectiveStatus === 'EXPIRED' || c.effectiveStatus === 'CANCELLED' ? 'attention' : ''}>
                    <td><Link href={`/clientes/${c.id}`}>{c.name}</Link><div className="muted">{c.slug}</div></td>
                    <td>{c.planName}</td>
                    <td>
                      <StatusBadge status={c.effectiveStatus} />
                      {c.effectiveStatus !== c.status && <div className="muted">{t('detail.state')}: {t(`status.${c.status}`)}</div>}
                    </td>
                    <td><Validity c={c} /></td>
                    <td><LimitText used={c.usage.employees} limit={null} /></td>
                    <td>{c.usage.branches}</td>
                    <td>{c.adminEmail ?? <span className="muted">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pager">
              <span className="muted" data-testid="total">{data.total} {t('customers.total')}</span>
              <div className="btn-row">
                <button className="secondary" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>{t('customers.prev')}</button>
                <button className="secondary" disabled={offset + PAGE >= data.total} onClick={() => setOffset(offset + PAGE)}>{t('customers.next')}</button>
              </div>
            </div>
          </>
        )}
      </Card>
    </>
  );
}

export default function CustomersPage() {
  return <Suspense fallback={<Loading />}><CustomersList /></Suspense>;
}
