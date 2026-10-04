'use client';

import { Icon, type IconName } from '@/components/icons';
import { Card, ErrorBox, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import type { SubscriptionView } from '@/lib/plan';

const RESOURCES: { key: keyof SubscriptionView['limits']; icon: IconName }[] = [
  { key: 'branches', icon: 'building' },
  { key: 'employees', icon: 'users' },
  { key: 'kiosks', icon: 'tablet' },
  { key: 'members', icon: 'shield' },
];

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('es-MX', { dateStyle: 'long' }) : null);

/** Mi plan (D-87): plan, estado y vigencia, uso frente a los límites y funciones incluidas. Solo lectura. */
export default function PlanPage() {
  const { data, error } = useLoad(() => api<SubscriptionView>('/subscription'));
  const ends = data ? (data.status === 'TRIAL' ? date(data.trialEndsAt) : date(data.currentPeriodEnd)) : null;
  return (
    <>
      <h1>{t('plan.title')}</h1>
      <ErrorBox message={error} />
      {!data ? <Loading /> : (
        <>
          <div className="plan-head" data-testid="plan-head">
            <div>
              <div className="plan-name" data-testid="plan-name">{data.planName}</div>
              <div className="muted">
                {t(`plan.status.${data.status}`)}
                {ends ? ` · ${data.status === 'TRIAL' ? t('plan.trialUntil') : t('plan.validUntil')} ${ends}` : data.status === 'ACTIVE' ? ` · ${t('plan.noExpiry')}` : ''}
              </div>
            </div>
            <span className={`badge plan-${data.status}`} data-testid="plan-status">{t(`plan.status.${data.status}`)}</span>
          </div>
          <div className="plan-grid">
            <Card title={t('plan.usage')} icon="chart">
              <ul className="usage" data-testid="plan-usage">
                {RESOURCES.map(({ key, icon }) => {
                  const used = data.usage[key];
                  const limit = data.limits[key];
                  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
                  return (
                    <li key={key}>
                      <div className="usage-row">
                        <span><Icon name={icon} size={16} /> {t(`plan.res.${key}`)}</span>
                        <strong data-testid={`usage-${key}`}>{used} / {limit ?? t('plan.unlimited')}</strong>
                      </div>
                      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={limit ?? undefined} aria-valuenow={used} aria-label={t(`plan.res.${key}`)}>
                        <span className={pct >= 100 ? 'full' : pct >= 80 ? 'near' : ''} style={{ width: `${limit ? pct : 0}%` }} />
                      </div>
                    </li>
                  );
                })}
              </ul>
              <p className="muted">{t('plan.usageHelp')}</p>
            </Card>
            <Card title={t('plan.features')} icon="sparkles">
              <ul className="features" data-testid="plan-features">
                {(['reportsExport', 'scheduleTemplates'] as const).map((f) => (
                  <li key={f} className={data.features[f] ? 'on' : 'off'}>
                    <Icon name={data.features[f] ? 'check' : 'lock'} size={16} />
                    <span>{t(`plan.feature.${f}`)}</span>
                    <span className="muted">{data.features[f] ? t('plan.included') : t('plan.notIncluded')}</span>
                  </li>
                ))}
              </ul>
              <p className="muted">{t('plan.contact')}</p>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
