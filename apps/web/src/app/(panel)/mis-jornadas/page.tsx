'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useBranches } from '@/components/attendance';
import { MyRecords } from '@/components/my-records';
import { ErrorBox, Field, Loading, useAction } from '@/components/ui';
import { api, type OwnRecords, type RequestDraft } from '@/lib/api';
import { errorText, t } from '@/lib/i18n';
import { useSession } from '@/lib/session';

/**
 * "Mis jornadas" (decisión 1): solo para cuentas ligadas a una ficha de empleado. Muestra la propia ficha dentro de
 * la ventana de solicitud y permite SOLICITAR correcciones (nunca aplicarlas). La ficha la determina el servidor por la
 * membresía, nunca el navegador.
 */
export default function MySessionsPage() {
  const { me } = useSession();
  const { branches } = useBranches();
  const [branchId, setBranchId] = useState('');
  const [data, setData] = useState<OwnRecords | null>(null);
  const [error, setError] = useState<string | null>(null);
  const action = useAction();
  const pending = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    if (branches?.[0]) setBranchId((current) => current || branches[0]!.id); // nunca pisa una elección del usuario
  }, [branches]);

  const load = useCallback(async () => {
    if (!branchId) return;
    try {
      setData(await api<OwnRecords>(`/attendance/my/sessions?branchId=${branchId}`));
      setError(null);
    } catch (e) {
      setError(errorText((e as { code?: string }).code));
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!me?.employeeId) return <><h1>{t('nav.mySessions')}</h1><p className="muted">{t('mine.noRecord')}</p></>;

  async function submit(draft: RequestDraft): Promise<boolean> {
    const key = JSON.stringify(draft);
    if (!pending.current || pending.current.key !== key) pending.current = { key, id: crypto.randomUUID() }; // reintento = misma solicitud
    const ok = await action.run(() => api('/attendance/correction-requests', { method: 'POST', body: { ...draft, clientRequestId: pending.current!.id } }));
    if (!ok) return false;
    pending.current = null;
    await load();
    return true;
  }

  async function cancel(id: string) {
    if (await action.run(() => api(`/attendance/correction-requests/${id}/cancel`, { method: 'POST', body: {} }))) await load();
  }

  return (
    <>
      <h1>{t('nav.mySessions')}</h1>
      <div className="row" style={{ marginBottom: '1rem' }}>
        <Field label={t('common.branch')}>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
      </div>
      <ErrorBox message={error ?? action.error} />
      {!data ? <Loading /> : (
        <section className="card">
          <MyRecords data={data} busy={action.busy} onSubmit={submit} onCancelRequest={cancel} branches={branches?.map((b) => ({ id: b.id, name: b.name }))} />
        </section>
      )}
    </>
  );
}
