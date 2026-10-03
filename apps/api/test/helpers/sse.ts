import type { Agent } from './http.js';

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

/** Cliente SSE de prueba (fetch + lectura del flujo) con la cookie del Agent. */
export async function openStream(agent: Agent, baseUrl: string, path = '/api/attendance/stream') {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { cookie: [...agent.cookies].map(([k, v]) => `${k}=${v}`).join('; '), accept: 'text/event-stream' },
    signal: controller.signal,
  });
  const events: SseEvent[] = [];
  let ended = false;
  const waiters: (() => void)[] = [];
  if (res.ok && res.body) {
    void (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event) events.push({ event, data: data ? JSON.parse(data) : {} });
            waiters.splice(0).forEach((w) => w());
          }
        }
      } catch {
        /* abortado */
      }
      ended = true;
      waiters.splice(0).forEach((w) => w());
    })();
  }
  const waitFor = async (predicate: (e: SseEvent) => boolean, timeoutMs = 3000): Promise<SseEvent | null> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = events.find(predicate);
      if (found) return found;
      if (ended || Date.now() > deadline) return null;
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
        setTimeout(resolve, 100);
      });
    }
  };
  return {
    status: res.status,
    headers: res.headers,
    events,
    get ended() {
      return ended;
    },
    waitFor,
    close: () => controller.abort(),
  };
}
