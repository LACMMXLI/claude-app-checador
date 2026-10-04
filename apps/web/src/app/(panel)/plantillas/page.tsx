'use client';

import { type FormEvent, useEffect, useState } from 'react';
import { Card, Empty, ErrorBox, Field, Loading, useAction, useLoad } from '@/components/ui';
import { api, type Branch, type Employee } from '@/lib/api';
import { t } from '@/lib/i18n';

interface Entry { employeeId: string; weekday: number; startTime: string; endTime: string }
interface Template { id: string; branchId: string; name: string; isActive: boolean; version: number; entries?: Entry[] }
const WEEKDAYS = ['', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

/** Plantillas: patrones que AYUDAN a generar semanas. Editarlas nunca cambia turnos ya creados. */
export default function TemplatesPage() {
  const branches = useLoad(() => api<Branch[]>('/branches'));
  const employees = useLoad(() => api<Employee[]>('/employees?status=ACTIVE'));
  const list = useLoad(() => api<Template[]>('/schedule-templates'));
  const action = useAction();
  const [form, setForm] = useState({ branchId: '', name: '' });
  const [current, setCurrent] = useState<Template | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [applyWeek, setApplyWeek] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => setEntries(current?.entries ?? []), [current]);

  async function open(id: string) {
    const tpl = await action.run(() => api<Template>(`/schedule-templates/${id}`));
    if (tpl) setCurrent(tpl);
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    const tpl = await action.run(() => api<Template>('/schedule-templates', { method: 'POST', body: form }));
    if (tpl) { setForm({ ...form, name: '' }); await list.reload(); setCurrent(tpl); }
  }
  async function save() {
    if (!current) return;
    const tpl = await action.run(() => api<Template>(`/schedule-templates/${current.id}`, { method: 'PUT', body: { expectedVersion: current.version, entries } }));
    if (tpl) { setCurrent(tpl); setMessage('Plantilla guardada (los turnos existentes no cambian).'); }
  }
  async function apply() {
    if (!current || !applyWeek) return;
    const r = await action.run(() => api<{ created: unknown[]; conflicts: unknown[] }>(`/schedule-templates/${current.id}/apply`, { method: 'POST', body: { weekStart: applyWeek } }));
    if (r) setMessage(`${t('schedule.created')}: ${r.created.length} · ${t('schedule.conflicts')}: ${r.conflicts.length}`);
  }
  const staff = employees.data ?? [];

  return (
    <>
      <h1>{t('nav.templates')}</h1>
      <ErrorBox message={list.error ?? action.error} />
      {message && <p role="status">{message}</p>}
      <Card title="Nueva plantilla">
        <form className="row" onSubmit={create}>
          <Field label={t('common.branch')}>
            <select required value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })}>
              <option value="" />
              {branches.data?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </Field>
          <Field label={t('common.name')}><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <button className="primary" disabled={action.busy}>{t('common.create')}</button>
        </form>
      </Card>
      <Card>
        {!list.data ? <Loading /> : list.data.length === 0 ? <Empty /> : (
          <div className="row">{list.data.map((tpl) => <button key={tpl.id} onClick={() => void open(tpl.id)}>{tpl.name}</button>)}</div>
        )}
      </Card>
      {current && (
        <Card title={current.name}>
          <table>
            <thead><tr><th>{t('schedule.employee')}</th><th>Día</th><th>{t('schedule.start')}</th><th>{t('schedule.end')}</th><th /></tr></thead>
            <tbody>
              {entries.map((en, i) => (
                <tr key={i}>
                  <td>
                    <select value={en.employeeId} onChange={(e) => setEntries(entries.map((x, j) => (j === i ? { ...x, employeeId: e.target.value } : x)))}>
                      <option value="" />
                      {staff.map((p) => <option key={p.id} value={p.id}>{p.firstName} {p.lastName}</option>)}
                    </select>
                  </td>
                  <td>
                    <select value={en.weekday} onChange={(e) => setEntries(entries.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))}>
                      {WEEKDAYS.slice(1).map((d, k) => <option key={d} value={k + 1}>{d}</option>)}
                    </select>
                  </td>
                  <td><input type="time" value={en.startTime} onChange={(e) => setEntries(entries.map((x, j) => (j === i ? { ...x, startTime: e.target.value } : x)))} /></td>
                  <td><input type="time" value={en.endTime} onChange={(e) => setEntries(entries.map((x, j) => (j === i ? { ...x, endTime: e.target.value } : x)))} /></td>
                  <td><button className="link" onClick={() => setEntries(entries.filter((_, j) => j !== i))}>✕</button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="row" style={{ marginTop: '1rem' }}>
            <button onClick={() => setEntries([...entries, { employeeId: staff[0]?.id ?? '', weekday: 1, startTime: '07:00', endTime: '15:00' }])}>＋ Renglón</button>
            <button className="primary" disabled={action.busy} onClick={() => void save()}>{t('common.save')}</button>
            <Field label="Aplicar a la semana que incluye"><input type="date" value={applyWeek} onChange={(e) => setApplyWeek(e.target.value)} /></Field>
            <button disabled={action.busy || !applyWeek} onClick={() => void apply()}>Generar turnos (borrador)</button>
          </div>
        </Card>
      )}
    </>
  );
}
