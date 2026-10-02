'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PunchAction, ShiftSummary } from '@/lib/api';
import { shiftLabel, timeIn } from '@/lib/format';
import { errorText, t } from '@/lib/i18n';

/**
 * Kiosco (D-56, D-57, D-58, D-59). Pantalla táctil a pantalla completa.
 * - La credencial del DISPOSITIVO es una cookie HttpOnly que fija el servidor al activar: aquí no se guarda
 *   ningún secreto (ni en localStorage ni en memoria más allá de la petición de activación).
 * - El PIN solo vive en el estado del componente mientras se captura, enmascarado; nunca va en la URL.
 * - Tras cada checada se muestra la confirmación unos segundos y se vuelve al PIN sin datos del empleado.
 */
interface KioskInfo {
  organization: { name: string; branding: { logoUrl?: string } | null };
  branch: { id: string; name: string; timezone: string };
  device: { name: string };
  serverTime: string;
}

interface Identified {
  ticket: string;
  employee: { displayName: string };
  status: 'NONE' | 'WORKING' | 'ON_BREAK';
  actions: PunchAction[];
  shift: ShiftSummary | null;
  session: { startedAt: string; branchName: string | null } | null;
  openBreak: { startedAt: string; allowedMinutes: number } | null;
}

interface Done {
  action: PunchAction;
  name: string;
  occurredAt: string;
  breakExcess: number | null;
}

class KioskError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly details: Record<string, unknown> = {}) {
    super(code);
  }
}

async function kioskApi<T>(path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/kiosk/${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body === undefined ? {} : { 'content-type': 'application/json', 'x-requested-with': 'checador' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new KioskError(0, 'API_UNAVAILABLE');
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new KioskError(res.status, data?.error?.code ?? 'HTTP_ERROR', data?.error?.details ?? {});
  return data as T;
}

const IDLE_MS = 20_000; // RN-PIN-10: inactividad con datos del empleado en pantalla
const DONE_MS = 4_000;
const PIN_LENGTH = 6;

export default function KioskPage() {
  const [info, setInfo] = useState<KioskInfo | null>(null);
  const [mode, setMode] = useState<'loading' | 'activate' | 'pin' | 'employee' | 'done'>('loading');
  const [offline, setOffline] = useState(false);
  const [pin, setPin] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [who, setWho] = useState<Identified | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [credential, setCredential] = useState('');
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const pendingAction = useRef<{ action: PunchAction; clientEventId: string } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reset = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    pendingAction.current = null;
    setWho(null);
    setDone(null);
    setPin('');
    setMessage(null);
    setMode('pin');
  }, []);

  const handleError = useCallback(
    (e: unknown) => {
      const err = e instanceof KioskError ? e : new KioskError(0, 'API_UNAVAILABLE');
      if (err.code === 'API_UNAVAILABLE') {
        setOffline(true);
        return;
      }
      setOffline(false);
      if (err.status === 401 && (err.code === 'KIOSK_TOKEN_INVALID' || err.code === 'KIOSK_NOT_ACTIVATED')) {
        setInfo(null);
        setMode('activate');
        setMessage(errorText(err.code));
        return;
      }
      if (err.code === 'PIN_PAUSED') {
        setMessage(`${errorText(err.code)} (${String(err.details.retryAfterSec ?? '')} s)`);
        return;
      }
      setMessage(errorText(err.code));
    },
    [],
  );

  const loadSession = useCallback(async () => {
    try {
      const s = await kioskApi<KioskInfo>('session');
      setInfo(s);
      setClockOffset(new Date(s.serverTime).getTime() - Date.now()); // la hora oficial es la del servidor
      setOffline(false);
      setMode((m) => (m === 'loading' || m === 'activate' ? 'pin' : m));
    } catch (e) {
      if (e instanceof KioskError && e.status === 401) {
        setMode('activate');
        return;
      }
      handleError(e);
    }
  }, [handleError]);

  useEffect(() => {
    void loadSession();
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const heartbeat = setInterval(() => void loadSession(), 60_000);
    const goOnline = () => void loadSession();
    const goOffline = () => setOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      clearInterval(tick);
      clearInterval(heartbeat);
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, [loadSession]);

  // inactividad: nunca dejar en pantalla los datos de un empleado
  useEffect(() => {
    if (mode !== 'employee' && mode !== 'done') return;
    timer.current = setTimeout(reset, mode === 'done' ? DONE_MS : IDLE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [mode, reset]);

  async function activate() {
    setBusy(true);
    setMessage(null);
    try {
      await kioskApi('activate', { credential });
      setCredential(''); // el token ya no se necesita: el servidor dejó una cookie HttpOnly
      await loadSession();
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function identify() {
    if (pin.length !== PIN_LENGTH || busy) return;
    setBusy(true);
    setMessage(null);
    const typed = pin;
    setPin(''); // el PIN no se queda en pantalla ni en memoria
    try {
      const r = await kioskApi<Identified>('identify', { pin: typed });
      setOffline(false);
      setWho(r);
      setMode('employee');
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function punch(action: PunchAction) {
    if (!who || busy) return;
    // mismo clientEventId si se reintenta la MISMA acción (timeout, doble toque): el servidor no la duplica
    if (!pendingAction.current || pendingAction.current.action !== action) pendingAction.current = { action, clientEventId: crypto.randomUUID() };
    setBusy(true);
    setMessage(null);
    try {
      const r = await kioskApi<{ action: PunchAction; occurredAt: string; break?: { exceededMinutes?: number | null } }>('punch', {
        ticket: who.ticket,
        action,
        clientEventId: pendingAction.current.clientEventId,
      });
      setOffline(false);
      setDone({ action: r.action, name: who.employee.displayName, occurredAt: r.occurredAt, breakExcess: r.break?.exceededMinutes ?? null });
      setWho(null);
      pendingAction.current = null;
      setMode('done');
    } catch (e) {
      if (e instanceof KioskError && e.code === 'KIOSK_TICKET_INVALID') {
        reset();
        setMessage(errorText(e.code));
        return;
      }
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  const press = (digit: string) => {
    setMessage(null);
    setPin((p) => (p.length < PIN_LENGTH ? p + digit : p));
  };

  useEffect(() => {
    if (mode !== 'pin') return;
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
      else if (e.key === 'Enter') void identify();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const tz = info?.branch.timezone ?? 'UTC';
  const serverNow = new Date(now + clockOffset);
  const clock = new Intl.DateTimeFormat('es-MX', { hour: 'numeric', minute: '2-digit', second: '2-digit', timeZone: tz }).format(serverNow);
  const today = new Intl.DateTimeFormat('es-MX', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz }).format(serverNow);

  if (mode === 'loading') return <div className="kiosk" />;

  if (mode === 'activate') {
    return (
      <div className="kiosk">
        <div className="kiosk-panel">
          <h1>{t('kiosk.activate.title')}</h1>
          <p className="muted">{t('kiosk.activate.help')}</p>
          <label htmlFor="kiosk-credential">{t('kiosk.activate.credential')}</label>
          <input
            id="kiosk-credential"
            className="kiosk-input"
            value={credential}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => setCredential(e.target.value)}
          />
          {message && <p className="error" role="alert">{message}</p>}
          <button className="primary kiosk-wide" disabled={busy || credential.trim().length < 6} onClick={() => void activate()}>
            {t('kiosk.activate.submit')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="kiosk">
      <header className="kiosk-header">
        <div className="kiosk-brand">
          {info?.organization.branding?.logoUrl && <img src={info.organization.branding.logoUrl} alt="" className="kiosk-logo" />}
          <div>
            <div className="kiosk-org">{info?.organization.name}</div>
            <div className="kiosk-branch" data-testid="kiosk-branch">{info?.branch.name}</div>
          </div>
        </div>
        <div className="kiosk-clock">
          <div className="kiosk-time" aria-live="off">{clock}</div>
          <div className="muted">{today}</div>
        </div>
        <button className="link" onClick={() => void document.documentElement.requestFullscreen?.()}>{t('kiosk.fullscreen')}</button>
      </header>
      {offline && <div className="kiosk-offline" role="alert">{t('kiosk.offline')}</div>}

      {mode === 'pin' && (
        <div className="kiosk-panel">
          <h1>{t('kiosk.pin.prompt')}</h1>
          <div className="pin-dots" aria-label={t('kiosk.pin.prompt')} data-testid="pin-dots">
            {Array.from({ length: PIN_LENGTH }, (_, i) => <span key={i} className={i < pin.length ? 'filled' : ''} />)}
          </div>
          {message && <p className="error kiosk-message" role="alert">{message}</p>}
          <div className="keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
              <button key={d} onClick={() => press(d)} disabled={busy}>{d}</button>
            ))}
            <button className="key-secondary" onClick={() => setPin((p) => p.slice(0, -1))} disabled={busy}>{t('kiosk.pin.delete')}</button>
            <button onClick={() => press('0')} disabled={busy}>0</button>
            <button className="primary" onClick={() => void identify()} disabled={busy || pin.length !== PIN_LENGTH}>{t('kiosk.pin.confirm')}</button>
          </div>
        </div>
      )}

      {mode === 'employee' && who && (
        <div className="kiosk-panel">
          <h1 data-testid="kiosk-employee">{t('kiosk.hello')}, {who.employee.displayName}</h1>
          <p className="kiosk-info">
            {who.shift ? `${t('kiosk.shift')}: ${shiftLabel(who.shift)}${who.shift.branchName ? ` · ${who.shift.branchName}` : ''}` : t('kiosk.noShift')}
          </p>
          {who.session && who.status === 'WORKING' && (
            <p className="muted">
              {t('kiosk.working')} {timeIn(who.session.startedAt, tz)}
              {who.session.branchName ? ` · ${t('kiosk.otherBranch')} ${who.session.branchName}` : ''}
            </p>
          )}
          {who.openBreak && <p className="muted">{t('kiosk.onBreak')} {timeIn(who.openBreak.startedAt, tz)}</p>}
          {message && <p className="error kiosk-message" role="alert">{message}</p>}
          <div className="kiosk-actions">
            {who.actions.map((a) => (
              <button key={a} className={`kiosk-action ${a === 'CLOCK_IN' || a === 'BREAK_END' ? 'primary' : ''}`} disabled={busy} onClick={() => void punch(a)}>
                {t(`kiosk.action.${a}`)}
              </button>
            ))}
          </div>
          <button className="link" onClick={reset}>{t('kiosk.back')}</button>
        </div>
      )}

      {mode === 'done' && done && (
        <div className="kiosk-panel kiosk-done" role="status" data-testid="kiosk-done">
          <div className="kiosk-check">✓</div>
          <h1>{t(`kiosk.done.${done.action}`)}</h1>
          <p className="kiosk-info">{done.name} · {timeIn(done.occurredAt, tz)}</p>
          {done.breakExcess ? <p className="kiosk-info">{t('kiosk.done.breakExcess')} {done.breakExcess} min</p> : null}
        </div>
      )}
      <footer className="kiosk-footer muted">{info?.device.name}</footer>
    </div>
  );
}
