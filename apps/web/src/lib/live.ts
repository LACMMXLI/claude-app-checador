'use client';

import { useEffect, useRef, useState } from 'react';

export type LiveStatus = 'connecting' | 'connected' | 'reconnecting' | 'polling';
export type LiveKind = 'attendance.session' | 'attendance.incident' | 'attendance.request';

const POLL_MS = 30_000; // sin tiempo real: igual que antes de la Fase 4
const SAFETY_MS = 120_000; // con tiempo real: recarga de respaldo (un aviso perdido nunca deja datos viejos mucho tiempo)
const RETRY_SSE_MS = 60_000; // tras caer a polling, reintentar el canal en vivo
const DEBOUNCE_MS = 300;

/**
 * Tiempo real del panel (D-75): `EventSource` contra `/api/attendance/stream` (misma cookie de sesión, sin tokens en
 * el navegador). Los eventos son SOLO invalidaciones `{id, branchId, op}`: aquí únicamente se agrupan y se llama a
 * `onChange`, que vuelve a consultar los endpoints normales (RBAC + RLS). Si el canal falla (proxy sin streaming,
 * 401/429, red), cae a polling cada 30 s y reintenta el canal cada minuto.
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
    const fallback = () => {
      source?.close();
      source = null;
      setStatus('polling');
      startPolling(POLL_MS);
      if (retry) clearTimeout(retry);
      retry = setTimeout(connect, RETRY_SSE_MS);
    };

    function connect() {
      if (disposed) return;
      if (typeof EventSource === 'undefined') return fallback();
      source = new EventSource(`/api/attendance/stream${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`, { withCredentials: true });
      source.addEventListener('ready', () => {
        setStatus('connected');
        startPolling(SAFETY_MS);
        if (hadError) fire(); // pudo perderse algo mientras no había canal
        hadError = false;
      });
      for (const k of kindsKey.split(',')) if (k) source.addEventListener(k, fire);
      source.addEventListener('resync', fire);
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
    };
  }, [branchId, kindsKey, enabled]);

  return status;
}
