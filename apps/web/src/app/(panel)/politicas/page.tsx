'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Card, ErrorBox, Field, Loading, useAction, useLoad } from '@/components/ui';
import { api, type Branch, type Employee } from '@/lib/api';
import { t } from '@/lib/i18n';

type Scope = 'ORGANIZATION' | 'BRANCH' | 'EMPLOYEE';
interface Row {
  key: string;
  effective: number | boolean | string;
  source: 'PLATFORM' | Scope;
  levels: { PLATFORM: unknown; ORGANIZATION: unknown; BRANCH?: unknown; EMPLOYEE?: unknown };
  allowedScopes: Scope[];
}

const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? 'Sí' : 'No') : String(v));

/** Muestra, por parámetro, el override GUARDADO en cada nivel y el valor EFECTIVO con su ORIGEN. */
function PoliciesView() {
  const params = useSearchParams();
  const [branchId, setBranchId] = useState(params.get('branchId') ?? '');
  const [employeeId, setEmployeeId] = useState(params.get('employeeId') ?? '');
  const [level, setLevel] = useState<Scope>(params.get('employeeId') ? 'EMPLOYEE' : 'ORGANIZATION');
  const branches = useLoad(() => api<Branch[]>('/branches'));
  const employees = useLoad(() => api<Employee[]>('/employees?status=ACTIVE'));
  const query = new URLSearchParams({ ...(branchId ? { branchId } : {}), ...(employeeId ? { employeeId } : {}) }).toString();
  const { data, error, reload } = useLoad(() => api<Row[]>(`/policies/effective${query ? `?${query}` : ''}`), [query]);
  const action = useAction();
  const targetId = level === 'BRANCH' ? branchId : level === 'EMPLOYEE' ? employeeId : null;

  async function saveValue(key: string, raw: string, type: 'number' | 'boolean' | 'time') {
    const value = raw === '' ? null : type === 'number' ? Number(raw) : type === 'boolean' ? raw === 'true' : raw;
    if (await action.run(() => api('/policies/override', { method: 'PUT', body: { scope: level, targetId, values: { [key]: value } } }))) await reload();
  }

  const levelValue = (r: Row) => (level === 'ORGANIZATION' ? r.levels.ORGANIZATION : level === 'BRANCH' ? r.levels.BRANCH : r.levels.EMPLOYEE);
  const canEdit = (r: Row) => r.allowedScopes.includes(level) && (level === 'ORGANIZATION' || Boolean(targetId));

  return (
    <>
      <h1>{t('policies.title')}</h1>
      <ErrorBox message={error ?? action.error} />
      <div className="filters">
        <div className="row">
          <Field label={t('common.branch')}>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
              <option value="">—</option>
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label={t('nav.employees')}>
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)}>
              <option value="">—</option>
              {employees.data?.map((e) => <option key={e.id} value={e.id}>{e.employeeNumber} · {e.firstName} {e.lastName}</option>)}
            </select>
          </Field>
          <Field label={t('policies.level')}>
            <select value={level} onChange={(e) => setLevel(e.target.value as Scope)}>
              <option value="ORGANIZATION">{t('policies.source.ORGANIZATION')}</option>
              <option value="BRANCH" disabled={!branchId}>{t('policies.source.BRANCH')}</option>
              <option value="EMPLOYEE" disabled={!employeeId}>{t('policies.source.EMPLOYEE')}</option>
            </select>
          </Field>
        </div>
      </div>
      <Card>
        {!data ? <Loading /> : (
          <table>
            <thead>
              <tr>
                <th>{t('policies.param')}</th><th>{t('policies.effective')}</th><th>{t('policies.source')}</th>
                <th>Plataforma</th><th>Negocio</th>{branchId && <th>Sucursal</th>}{employeeId && <th>Empleado</th>}
                <th>{t('policies.override')} ({t(`policies.source.${level}`)})</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => {
                const type = typeof r.levels.PLATFORM === 'boolean' ? 'boolean' : r.key === 'operationalCutoff' ? 'time' : 'number';
                const current = levelValue(r);
                return (
                  <tr key={r.key}>
                    <td>{t(`policy.${r.key}`)}</td>
                    <td><strong>{show(r.effective)}</strong></td>
                    <td>{t(`policies.source.${r.source}`)}</td>
                    <td>{show(r.levels.PLATFORM)}</td>
                    <td>{show(r.levels.ORGANIZATION)}</td>
                    {branchId && <td>{show(r.levels.BRANCH)}</td>}
                    {employeeId && <td>{show(r.levels.EMPLOYEE)}</td>}
                    <td>
                      {canEdit(r) ? (
                        type === 'boolean' ? (
                          <select defaultValue={current === null || current === undefined ? '' : String(current)} onChange={(e) => void saveValue(r.key, e.target.value, type)}>
                            <option value="">— hereda —</option><option value="true">Sí</option><option value="false">No</option>
                          </select>
                        ) : (
                          <input
                            key={`${r.key}-${level}-${String(current)}`}
                            type={type === 'time' ? 'time' : 'number'}
                            defaultValue={current === null || current === undefined ? '' : String(current).slice(0, type === 'time' ? 5 : undefined)}
                            placeholder="hereda"
                            onBlur={(e) => { if (e.target.value !== (current === null || current === undefined ? '' : String(current).slice(0, type === 'time' ? 5 : undefined))) void saveValue(r.key, e.target.value, type); }}
                            style={{ width: '7rem' }}
                          />
                        )
                      ) : <span className="muted">no aplica</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </>
  );
}

export default function PoliciesPage() {
  return (
    <Suspense fallback={<Loading />}>
      <PoliciesView />
    </Suspense>
  );
}
