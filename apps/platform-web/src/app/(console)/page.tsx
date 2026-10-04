'use client';

import Link from 'next/link';
import { Icon, type IconName } from '@/components/icons';
import { StatusBadge } from '@/components/status';
import { Card, Empty, ErrorBox, Loading, useLoad } from '@/components/ui';
import { api, type Dashboard, type SubStatus } from '@/lib/api';
import { fmtDate, t } from '@/lib/i18n';

type Tone = 'green' | 'blue' | 'amber' | 'red' | 'coral';
function Kpi({ tone, icon, label, value, testid, href }: { tone: Tone; icon: IconName; label: string; value: number; testid: string; href?: string }) {
  const body = (
    <>
      <div className="kpi-top"><span className="kpi-icon"><Icon name={icon} size={18} /></span>{label}</div>
      <div className="kpi-value" data-testid={testid}>{value}</div>
    </>
  );
  return href ? <Link href={href} className={`kpi t-${tone}`}>{body}</Link> : <div className={`kpi t-${tone}`}>{body}</div>;
}

export default function SummaryPage() {
  const { data, error } = useLoad(() => api<Dashboard>('/dashboard'));
  const by = (s: string) => data?.byStatus[s] ?? 0;
  return (
    <>
      <div className="hero">
        <div>
          <h1>{t('summary.title')}</h1>
          <p>{t('summary.employees')}: <strong data-testid="total-employees">{data?.totals.employees ?? '…'}</strong></p>
        </div>
        <div className="quick">
          <Link href="/clientes/nuevo"><Icon name="plus" size={16} />{t('customers.new')}</Link>
        </div>
      </div>
      <ErrorBox message={error} />
      {!data ? <Loading /> : (
        <>
          <div className="kpis" data-testid="kpis">
            <Kpi tone="blue" icon="building" label={t('summary.customers')} value={data.totals.customers} testid="kpi-customers" href="/clientes" />
            <Kpi tone="green" icon="check" label={t('summary.active')} value={by('ACTIVE')} testid="kpi-active" href="/clientes?status=ACTIVE" />
            <Kpi tone="amber" icon="clock" label={t('summary.trial')} value={by('TRIAL')} testid="kpi-trial" href="/clientes?status=TRIAL" />
            <Kpi tone={by('SUSPENDED') + by('EXPIRED') ? 'red' : 'green'} icon="alert" label={t('summary.attention')} value={by('SUSPENDED') + by('EXPIRED')} testid="kpi-attention" />
          </div>
          <div className="home-grid">
            <Card title={t('summary.expiring')} icon="clock">
              {data.expiringSoon.length === 0 ? <Empty text={t('summary.none')} /> : (
                <table data-testid="expiring">
                  <thead><tr><th>{t('customers.business')}</th><th>{t('customers.plan')}</th><th>{t('customers.state')}</th><th>{t('customers.validity')}</th></tr></thead>
                  <tbody>
                    {data.expiringSoon.map((c) => (
                      <tr key={c.id} className="attention">
                        <td><Link href={`/clientes/${c.id}`}>{c.name}</Link></td>
                        <td>{c.planCode}</td>
                        <td><StatusBadge status={c.status as SubStatus} /></td>
                        <td>{fmtDate(c.endsAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Card>
            <div>
              <Card title={t('summary.byPlan')} icon="layers">
                <ul className="mini-list" data-testid="by-plan">
                  {data.byPlan.map((p) => <li key={p.planCode}><span>{p.planName}</span><strong>{p.customers}</strong></li>)}
                </ul>
              </Card>
              <Card title={t('summary.recent')} icon="sparkles">
                {data.recent.length === 0 ? <Empty text={t('summary.noCustomers')} /> : (
                  <ul className="mini-list">
                    {data.recent.map((c) => <li key={c.id}><Link href={`/clientes/${c.id}`}>{c.name}</Link><span className="muted">{fmtDate(c.createdAt)}</span></li>)}
                  </ul>
                )}
              </Card>
            </div>
          </div>
        </>
      )}
    </>
  );
}
