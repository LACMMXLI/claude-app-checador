'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { IncidentChips, StateBadge, useBranches } from '@/components/attendance';
import { Card, Empty, ErrorBox, Field, Loading } from '@/components/ui';
import { api, type Board, personName } from '@/lib/api';
import { shiftLabel, signedMinutes, timeIn } from '@/lib/format';
import { errorText, t } from '@/lib/i18n';
import { useLive } from '@/lib/live';

const LIVE_KINDS = ['attendance.session', 'attendance.incident'] as const;

const COUNTERS: { key: string; states: string[] | null; late?: boolean }[] = [
  { key: 'scheduled', states: null },
  { key: 'notArrived', states: ['WITHIN_TOLERANCE', 'LATE_NOT_ARRIVED'] },
  { key: 'late', states: null, late: true },
  { key: 'absent', states: ['ABSENT_NOT_ARRIVED'] },
  { key: 'working', states: ['WORKING'] },
  { key: 'onBreak', states: ['ON_BREAK'] },
  { key: 'needsReview', states: ['NEEDS_REVIEW'] },
  { key: 'left', states: ['LEFT'] },
  { key: 'missed', states: ['MISSED'] },
];

/**
 * Asistencia en vivo (D-60): por sucursal y día operativo. Los estados (aún no llega, retardo, ausente,
 * trabajando, en comida, salió, falta…) los calcula el servidor con turno PUBLICADO + hora + política +
 * jornada real; no se guardan. Fase 4 (D-75): se actualiza al instante por SSE (avisos de invalidación) y, si el
 * canal en vivo no está disponible, cada 30 s como antes.
 */
export default function LiveAttendancePage() {
  const { branches } = useBranches();
  const [branchId, setBranchId] = useState('');
  const [date, setDate] = useState('');
  const [filter, setFilter] = useState<string | null>(null);
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (branches?.[0]) setBranchId((current) => current || branches[0]!.id); // nunca pisa una elección del usuario
  }, [branches]);

  // las recargas pueden traslaparse (cambio de filtro, aviso en vivo, polling): solo cuenta la respuesta más reciente
  const latest = useRef(0);
  const load = useCallback(async () => {
    if (!branchId) return;
    const seq = ++latest.current;
    try {
      const next = await api<Board>(`/attendance/board?branchId=${branchId}${date ? `&date=${date}` : ''}`);
      if (seq !== latest.current) return;
      setError(null);
      setBoard(next);
    } catch (e) {
      if (seq === latest.current) setError(errorText((e as { code?: string }).code));
    }
  }, [branchId, date]);

  useEffect(() => {
    void load();
  }, [load]);
  const live = useLive(branchId || undefined, LIVE_KINDS, () => void load(), Boolean(branchId));

  const selected = COUNTERS.find((c) => c.key === filter);
  const rows = (board?.rows ?? []).filter((r) => !selected || (selected.late ? r.late || r.state === 'LATE_NOT_ARRIVED' : !selected.states || selected.states.includes(r.state)));
  const tz = board?.branch.timezone ?? 'UTC';

  return (
    <>
      <h1>{t('live.title')}</h1>
      <div className="filters">
        <Field label={t('common.branch')}>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)}>
            {branches?.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </Field>
        <Field label={t('live.date')}>
          <input type="date" value={date || board?.operationalDate || ''} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={t('live.state')}>
          <select value={filter ?? ''} onChange={(e) => setFilter(e.target.value || null)}>
            <option value="">{t('live.all')}</option>
            {COUNTERS.filter((c) => c.key !== 'scheduled').map((c) => <option key={c.key} value={c.key}>{t(`live.counter.${c.key}`)}</option>)}
          </select>
        </Field>
        <button onClick={() => void load()}>{t('live.refresh')}</button>
        <span className={`live-indicator ${live}`} data-testid="live-indicator" data-status={live}>
          {live === 'connected' ? t('live.connected') : live === 'polling' ? t('live.polling') : t('live.reconnecting')}
        </span>
      </div>
      <ErrorBox message={error} />
      {!board ? <Loading /> : (
        <>
          <div className="counters" data-testid="counters">
            {COUNTERS.map((c) => (
              <button key={c.key} data-key={c.key} className={`counter ${filter === c.key ? 'selected' : ''}`} onClick={() => setFilter(filter === c.key ? null : c.key)} data-testid={`counter-${c.key}`}>
                <strong>{board.counters[c.key] ?? 0}</strong>
                {t(`live.counter.${c.key}`)}
              </button>
            ))}
          </div>
          <Card title={`${board.branch.name} · ${board.operationalDate}`}>
            {rows.length === 0 ? <Empty /> : (
              <table>
                <thead>
                  <tr>
                    <th>{t('att.employee')}</th><th>{t('att.shift')}</th><th>{t('live.state')}</th><th>{t('att.in')}</th>
                    <th>{t('att.arrival')}</th><th>{t('att.breaks')}</th><th>{t('att.out')}</th><th>{t('att.incidents')}</th><th />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={`${r.shift?.id ?? ''}-${r.session?.id ?? ''}`} data-testid={`live-row-${r.employee.id}`}>
                      <td>{personName(r.employee)}</td>
                      <td>{r.shift ? shiftLabel(r.shift) : <span className="muted">{t('att.noShift')}</span>}</td>
                      <td><StateBadge state={r.state} /></td>
                      <td>{timeIn(r.session?.startedAt, tz)}</td>
                      <td className={r.late ? 'late' : ''} data-testid="arrival">{signedMinutes(r.arrivalDeltaMinutes)}</td>
                      <td>
                        {r.currentBreak
                          ? <span className={r.currentBreak.minutes > r.currentBreak.allowedMinutes ? 'late' : ''}>{r.currentBreak.minutes} / {r.currentBreak.allowedMinutes} min</span>
                          : r.session && r.session.metrics.breakCount > 0 ? `${r.session.metrics.breakMinutes} min${r.session.metrics.breakExcessMinutes ? ` (+${r.session.metrics.breakExcessMinutes})` : ''}` : '—'}
                      </td>
                      <td>{timeIn(r.session?.endedAt, tz)}</td>
                      <td><IncidentChips incidents={r.incidents} /></td>
                      <td>{r.session && <Link href={`/jornadas/${r.session.id}`}>{t('att.detail')}</Link>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>
        </>
      )}
    </>
  );
}
