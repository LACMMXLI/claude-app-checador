import { createHmac, timingSafeEqual } from 'node:crypto';
import { DomainError } from '../../common/errors.js';

/**
 * "Pase" corto que emite el kiosco al identificar un PIN correcto (RN-PIN-10): liga negocio + dispositivo +
 * empleado y vence pronto. Así la acción (Entrada, Salida…) no vuelve a enviar el PIN y no necesita sesión.
 * Firmado con HMAC-SHA256 y una clave DERIVADA del secreto del servidor (separación de dominio); no se guarda.
 */
export interface TicketClaims {
  organizationId: string;
  deviceId: string;
  employeeId: string;
}

export const KIOSK_TICKET_TTL_SEC = 120;

export class KioskTickets {
  private readonly key: Buffer;

  constructor(serverSecret: string) {
    this.key = createHmac('sha256', serverSecret).update('checador/kiosk-ticket/v1').digest();
  }

  private sign(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest('base64url');
  }

  issue(claims: TicketClaims, now: Date): { ticket: string; expiresAt: Date } {
    const expiresAt = new Date(now.getTime() + KIOSK_TICKET_TTL_SEC * 1000);
    const payload = Buffer.from(JSON.stringify({ o: claims.organizationId, d: claims.deviceId, e: claims.employeeId, x: expiresAt.getTime() })).toString('base64url');
    return { ticket: `${payload}.${this.sign(payload)}`, expiresAt };
  }

  /** Válido solo para ESTE negocio y ESTE dispositivo, y sin vencer. Error genérico en cualquier otro caso. */
  verify(ticket: string, expected: { organizationId: string; deviceId: string }, now: Date): string {
    const [payload, signature] = ticket.split('.');
    if (!payload || !signature) throw new DomainError('KIOSK_TICKET_INVALID');
    const a = Buffer.from(this.sign(payload));
    const b = Buffer.from(signature);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new DomainError('KIOSK_TICKET_INVALID');
    let claims: { o?: string; d?: string; e?: string; x?: number };
    try {
      claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    } catch {
      throw new DomainError('KIOSK_TICKET_INVALID');
    }
    if (claims.o !== expected.organizationId || claims.d !== expected.deviceId || !claims.e || !claims.x || claims.x < now.getTime()) {
      throw new DomainError('KIOSK_TICKET_INVALID');
    }
    return claims.e;
  }
}
