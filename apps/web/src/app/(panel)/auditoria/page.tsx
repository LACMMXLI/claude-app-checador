'use client';

import { useEffect, useState } from 'react';
import { Card, ErrorBox, Loading, useAction } from '@/components/ui';
import { api } from '@/lib/api';
import { t } from '@/lib/i18n';

interface AuditRow { id: number; occurredAt: string; actorType: string; actorUserId: string | null; action: string; entityType: string; entityId: string | null; branchId: string | null; reason: string | null; before: unknown; after: unknown }

export default function AuditPage() {
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [done, setDone] = useState(false);
  const action = useAction();

  async function load(beforeId?: number) {
    const page = await action.run(() => api<AuditRow[]>(`/audit?limit=50${beforeId ? `&beforeId=${beforeId}` : ''}`));
    if (!page) return;
    setRows((prev) => (beforeId && prev ? [...prev, ...page] : page));
    setDone(page.length < 50);
  }
  useEffect(() => { void load(); }, []);

  return (
    <>
      <h1>{t('audit.title')}</h1>
      <ErrorBox message={action.error} />
      <Card>
        {!rows ? <Loading /> : (
          <table>
            <thead><tr><th>{t('audit.when')}</th><th>{t('audit.action')}</th><th>{t('audit.actor')}</th><th>{t('audit.entity')}</th><th>{t('common.reason')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.occurredAt).toLocaleString('es-MX')}</td>
                  <td><code>{r.action}</code></td>
                  <td>{r.actorType}{r.actorUserId ? ` · ${r.actorUserId.slice(0, 8)}` : ''}</td>
                  <td>{r.entityType}{r.entityId ? ` · ${r.entityId.slice(0, 8)}` : ''}</td>
                  <td>{r.reason ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows && !done && <button onClick={() => void load(rows[rows.length - 1]?.id)}>{t('audit.more')}</button>}
      </Card>
    </>
  );
}
