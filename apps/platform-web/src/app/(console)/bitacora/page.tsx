'use client';

import { useEffect, useState } from 'react';
import { Card, ErrorBox, Loading, useAction } from '@/components/ui';
import { api, type AuditEntry } from '@/lib/api';
import { fmtDateTime, t } from '@/lib/i18n';

export default function AuditPage() {
  const [rows, setRows] = useState<AuditEntry[] | null>(null);
  const [done, setDone] = useState(false);
  const action = useAction();

  async function load(beforeId?: number) {
    const page = await action.run(() => api<AuditEntry[]>(`/audit?limit=50${beforeId ? `&beforeId=${beforeId}` : ''}`));
    if (!page) return;
    setRows((prev) => (beforeId && prev ? [...prev, ...page] : page));
    setDone(page.length < 50);
  }
  useEffect(() => { void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <>
      <h1>{t('audit.title')}</h1>
      <p className="muted">{t('audit.help')}</p>
      <ErrorBox message={action.error} />
      <Card>
        {!rows ? <Loading /> : (
          <table data-testid="audit">
            <thead><tr><th>{t('audit.when')}</th><th>{t('audit.actor')}</th><th>{t('audit.action')}</th><th>{t('audit.details')}</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{fmtDateTime(r.occurredAt)}</td>
                  <td>{r.actor}</td>
                  <td><code>{r.action}</code></td>
                  <td className="muted"><code>{JSON.stringify(r.details).slice(0, 140)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {rows && !done && <button className="secondary" onClick={() => void load(rows[rows.length - 1]?.id)}>{t('audit.more')}</button>}
      </Card>
    </>
  );
}
