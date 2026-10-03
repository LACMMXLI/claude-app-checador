'use client';

import Link from 'next/link';
import { Card, ErrorBox, Loading, useLoad } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

interface Dashboard { branches: { total: number; active: number }; employees: { active: number }; members: number | null; kiosks: number | null }

export default function DashboardPage() {
  const { data, error } = useLoad(() => api<Dashboard>('/dashboard'));
  const { can } = useSession();
  const approver = can('attendance.correction.apply');
  const pending = useLoad(() => (approver ? api<{ pending: number }>('/attendance/correction-requests/summary') : Promise.resolve({ pending: 0 })), [approver]);
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
          {approver && (
            <Card title={t('req.title')}>
              <div className="stat" data-testid="dashboard-pending">{pending.data?.pending ?? 0}</div>
              <Link href="/solicitudes">{t('req.pending')} →</Link>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
