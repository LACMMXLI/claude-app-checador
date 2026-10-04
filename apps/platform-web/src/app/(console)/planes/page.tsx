'use client';

import { useState } from 'react';
import { Icon } from '@/components/icons';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '@/components/ui';
import { api, type Limits, type Plan } from '@/lib/api';
import { t } from '@/lib/i18n';

const KEYS: (keyof Limits)[] = ['branches', 'employees', 'kiosks', 'members'];

function PlanEditor({ plan, onSaved }: { plan: Plan; onSaved: () => Promise<void> }) {
  const { error, busy, run } = useAction();
  const [name, setName] = useState(plan.name);
  const [description, setDescription] = useState(plan.description);
  const [limits, setLimits] = useState<Record<keyof Limits, string>>(Object.fromEntries(KEYS.map((k) => [k, plan.limits[k] === null ? '' : String(plan.limits[k])])) as Record<keyof Limits, string>);
  const [features, setFeatures] = useState(plan.features);
  const [isActive, setIsActive] = useState(plan.isActive);

  async function save() {
    const body = {
      name, description, isActive, features,
      limits: Object.fromEntries(KEYS.map((k) => [k, limits[k].trim() === '' ? null : Number(limits[k])])),
    };
    if (await run(() => api(`/plans/${plan.code}`, { method: 'PATCH', body }))) await onSaved();
  }

  return (
    <Card title={`${plan.name} · ${plan.code}`} icon="layers" actions={<span className="muted">{plan.customers} {t('plans.customers')}</span>}>
      <form className="stack" data-testid={`plan-${plan.code}`} onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <Field label={t('plans.name')}><input required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <Field label={t('plans.description')}><input maxLength={300} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <fieldset className="limits">
          <legend>{t('plans.limits')}</legend>
          {KEYS.map((k) => (
            <Field key={k} label={t(`res.${k}`)}>
              <input type="number" min={1} max={100000} placeholder={t('plans.unlimited')} value={limits[k]} onChange={(e) => setLimits({ ...limits, [k]: e.target.value })} />
            </Field>
          ))}
        </fieldset>
        <fieldset className="limits">
          <legend>{t('plans.features')}</legend>
          {(['reportsExport', 'scheduleTemplates'] as const).map((f) => (
            <label key={f} className="check"><input type="checkbox" checked={features[f]} onChange={(e) => setFeatures({ ...features, [f]: e.target.checked })} />{t(`plans.f.${f}`)}</label>
          ))}
        </fieldset>
        <label className="check"><input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)} />{t('plans.available')}</label>
        <ErrorBox message={error} />
        <div><button className="primary" disabled={busy}><Icon name="check" size={16} />{t('plans.save')}</button></div>
      </form>
    </Card>
  );
}

export default function PlansPage() {
  const { data, error, reload } = useLoad(() => api<Plan[]>('/plans'));
  return (
    <>
      <h1>{t('plans.title')}</h1>
      <p className="muted">{t('plans.help')}</p>
      <ErrorBox message={error} />
      {!data ? <Loading /> : <div className="plan-grid">{data.map((p) => <PlanEditor key={`${p.code}-${p.name}-${p.isActive}-${JSON.stringify(p.limits)}`} plan={p} onSaved={reload} />)}</div>}
    </>
  );
}
