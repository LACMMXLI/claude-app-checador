/**
 * Textos de los reportes EXPORTADOS (D-74). La API devuelve códigos a la interfaz (que traduce con su catálogo), pero
 * un archivo XLSX/CSV necesita texto legible: este es el catálogo es-MX del servidor, solo para exportaciones.
 */
export const INCIDENT_LABELS: Record<string, string> = {
  RETARDO: 'Retardo',
  FALTA: 'Falta',
  SIN_TURNO_PROGRAMADO: 'Sin turno programado',
  SIN_ASIGNACION_SUCURSAL: 'Sin asignación a la sucursal',
  TURNO_EN_OTRA_SUCURSAL: 'Tenía turno en otra sucursal',
  ENTRADA_FALTANTE: 'Entrada después del fin de su turno',
  SALIDA_OLVIDADA: 'Salida olvidada',
  JORNADA_ABIERTA_EXCEDIDA: 'Jornada abierta demasiado tiempo',
  REGRESO_COMIDA_FALTANTE: 'Regreso de comida faltante',
  COMIDA_EXCEDIDA: 'Comida excedida',
  SALIDA_ANTICIPADA: 'Salida anticipada',
  SIN_COMIDA: 'Sin comida',
};

export const INCIDENT_STATUS_LABELS: Record<string, string> = { OPEN: 'Abierta', RESOLVED: 'Resuelta' };

export const RESOLUTION_LABELS: Record<string, string> = {
  CORRECTED: 'Corregida',
  JUSTIFIED: 'Justificada',
  CONFIRMED: 'Confirmada',
  DISMISSED: 'Descartada',
  VOIDED: 'Anulada por el sistema',
};

export const RESOLUTION_SOURCE_LABELS: Record<string, string> = { USER: 'Persona', CORRECTION: 'Corrección', SYSTEM: 'Sistema' };

export const SESSION_STATUS_LABELS: Record<string, string> = { OPEN: 'Abierta', REVIEW: 'Requiere corrección', CLOSED: 'Cerrada' };

export const ORIGIN_LABELS: Record<string, string> = { KIOSK: 'Kiosco', CORRECTION: 'Creada por corrección' };

export const ACTION_LABELS: Record<string, string> = {
  CREATE_SESSION: 'Jornada no registrada',
  SET_CLOCK_IN: 'Hora de Entrada',
  SET_CLOCK_OUT: 'Hora de Salida',
  SET_BREAK_START: 'Inicio de pausa',
  SET_BREAK_END: 'Regreso de pausa',
  LINK_SHIFT: 'Ligar a turno',
  UNLINK_SHIFT: 'Quitar turno',
  ADD_BREAK: 'Pausa omitida',
};

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  PENDING: 'Solicitud pendiente',
  APPROVED: 'Solicitud aprobada',
  REJECTED: 'Solicitud rechazada',
  CANCELLED: 'Solicitud cancelada',
};

export const REPORT_TITLES: Record<string, string> = {
  summary: 'Resumen por empleado',
  sessions: 'Detalle de jornadas',
  incidents: 'Incidencias',
  corrections: 'Correcciones y solicitudes',
};

export const label = (map: Record<string, string>, code: string | null | undefined) => (code ? (map[code] ?? code) : '');
