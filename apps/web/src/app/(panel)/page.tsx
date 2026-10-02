'use client';

import { Card, ErrorBox, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

interface Dashboard { branches: { total: number; active: number }; employees: { active: number }; members: number | null; kiosks: number | null }

export default function DashboardPage() {
  const { data, error } = useLoad(() => api<Dashboard>('/dashboard'));
  return (
    <>
      <h1>{t('dashboard.title')}</h1>
      <ErrorBox message={error} />
      {!data ? <Loading /> : (
        <div className="grid">
          <Card title={t('dashboard.branches')}><div className="stat">{data.branches.active}</div></Card>
          <Card title={t('dashboard.employees')}><div className="stat">{data.employees.active}</div></Card>
          {data.members !== null && <Card title={t('dashboard.members')}><div className="stat">{data.members}</div></Card>}
          {data.kiosks !== null && <Card title={t('dashboard.kiosks')}><div className="stat">{data.kiosks}</div></Card>}
        </div>
      )}
    </>
  );
}
