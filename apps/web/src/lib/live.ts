'use client';

import { useEffect, useRef, useState } from 'react';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting' | 'polling';
export type LiveKind = 'attendance.session' | 'attendance.incident' | 'attendance.request';

const POLL_MS = 30_000; // sin tiempo real: igual que antes de la Fase 4
const SAFETY_MS = 120_000; // con tiempo real: recarga de respaldo (un aviso perdido nunca deja datos viejos mucho tiempo)
const SILENCE_MS = 60_000; // el servidor manda `ping` cada 25 s: 60 s sin nada = canal muerto (proxy que acumula, red)
const RETRY_MIN_MS = 15_000; // reintento del canal en vivo con espera creciente…
const RETRY_MAX_MS = 300_000; // …hasta 5 min
const DEBOUNCE_MS = 300;

/**
 * Tiempo real del panel (D-75): `EventSource` contra `/api/attendance/stream` (misma cookie de sesión, sin tokens en
 * el navegador). Los eventos son SOLO invalidaciones `{id, branchId, op}`: aquí únicamente se agrupan y se llama a
 * `onChange`, que vuelve a consultar los endpoints normales (RBAC + RLS). Si el canal falla (proxy sin streaming,
 * 401/429, red) o pasan 60 s sin `ping`, cae a polling cada 30 s y reintenta el canal con espera creciente.
 */
export function useLive(branchId: string | undefined, kinds: readonly LiveKind[], onChange: () => void, enabled = true): LiveStatus {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const callback = useRef(onChange);
  callback.current = onChange;
  const kindsKey = kinds.join(',');

  useEffect(() => {
    if (!enabled) return;
    let source: EventSource | null = null;
    let poll: ReturnType<typeof setInterval> | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let watchdog: ReturnType<typeof setTimeout> | null = null;
    let retryDelay = RETRY_MIN_MS;
    let hadError = false;
    let disposed = false;

    const fire = () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => callback.current(), DEBOUNCE_MS);
    };
    const startPolling = (ms: number) => {
      if (poll) clearInterval(poll);
      poll = setInterval(() => callback.current(), ms);
    };
    const alive = () => {
      if (watchdog) clearTimeout(watchdog);
      watchdog = setTimeout(fallback, SILENCE_MS);
    };
    function fallback() {
      if (disposed) return;
      hadError = true;
      source?.close();
      source = null;
      if (watchdog) clearTimeout(watchdog);
      setStatus('polling');
      startPolling(POLL_MS);
      if (retry) clearTimeout(retry);
      retry = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
    }

    function connect() {
      if (disposed) return;
      if (typeof EventSource === 'undefined') return fallback();
      source = new EventSource(`/api/attendance/stream${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`, { withCredentials: true });
      alive();
      source.addEventListener('ready', () => {
        alive();
        setStatus('connected');
        startPolling(SAFETY_MS);
        retryDelay = RETRY_MIN_MS;
        if (hadError) fire(); // pudo perderse algo mientras no había canal
        hadError = false;
      });
      source.addEventListener('ping', alive);
      for (const k of kindsKey.split(',')) {
        if (k)
          source.addEventListener(k, () => {
            alive();
            fire();
          });
      }
      source.addEventListener('resync', () => {
        alive();
        fire();
      });
      source.onerror = () => {
        hadError = true;
        // CLOSED = el servidor respondió con error (401, 404, 429…) o el proxy no transmite: polling
        if (!source || source.readyState === EventSource.CLOSED) fallback();
        else {
          setStatus('reconnecting');
          startPolling(POLL_MS);
        }
      };
    }

    connect();
    return () => {
      disposed = true;
      source?.close();
      if (poll) clearInterval(poll);
      if (retry) clearTimeout(retry);
      if (debounce) clearTimeout(debounce);
      if (watchdog) clearTimeout(watchdog);
    };
  }, [branchId, kindsKey, enabled]);

  return status;
}
