import ExcelJS from 'exceljs';
import { REPORT_TITLES } from './labels.js';
import type { ReportTable } from './reports.service.js';

/** Máximo de filas por exportación (decisión 7). */
export const MAX_EXPORT_ROWS = 100_000;
/** Exportaciones por minuto por usuario (decisión 7). */
export const MAX_EXPORTS_PER_MINUTE = 10;

/**
 * Neutraliza inyección de fórmulas (CSV/Excel injection): un texto que empieza con = + - @ TAB o CR se antepone con
 * un apóstrofo. Solo aplica a TEXTO (los números se exportan como números).
 */
export function neutralize(value: string): string {
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

const cell = (v: string | number | null): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return String(v);
  const s = neutralize(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** CSV RFC 4180 (CRLF, comillas dobles) con BOM UTF-8 para que Excel lea acentos. */
export function toCsv(table: ReportTable): Buffer {
  const lines = [table.columns.map((c) => cell(c.header)).join(',')];
  for (const row of table.rows) lines.push(table.columns.map((c) => cell(row[c.key] ?? null)).join(','));
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(lines.join('\r\n') + '\r\n', 'utf8')]);
}

export interface ExportMeta {
  organization: string;
  branch: string;
  employee: string | null;
  generatedAt: string; // local, ya formateado
  generatedBy: string;
  timezone: string;
}

/** XLSX: hoja del reporte (encabezado fijo, filtros) + hoja "Parámetros" con los filtros usados. */
export async function toXlsx(table: ReportTable, meta: ExportMeta): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Reloj checador';
  wb.created = new Date();
  const title = REPORT_TITLES[table.report] ?? table.report;
  const ws = wb.addWorksheet(title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = table.columns.map((c) => ({ header: c.header, key: c.key, width: Math.min(40, Math.max(12, c.header.length + 2)) }));
  for (const row of table.rows) {
    ws.addRow(
      Object.fromEntries(
        table.columns.map((c) => {
          const v = row[c.key] ?? null;
          return [c.key, typeof v === 'string' ? neutralize(v) : v];
        }),
      ),
    );
  }
  ws.getRow(1).font = { bold: true };
  if (table.columns.length > 0) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: table.columns.length } };

  const params = wb.addWorksheet('Parámetros');
  params.columns = [
    { header: 'Parámetro', key: 'k', width: 24 },
    { header: 'Valor', key: 'v', width: 48 },
  ];
  params.getRow(1).font = { bold: true };
  const entries: [string, string][] = [
    ['Reporte', title],
    ['Negocio', meta.organization],
    ['Sucursal', meta.branch],
    ['Empleado', meta.employee ?? 'Todos'],
    ['Desde (día operativo)', table.from],
    ['Hasta (día operativo)', table.to],
    ['Zona horaria', meta.timezone],
    ['Filas', String(table.rows.length)],
    ['Generado', meta.generatedAt],
    ['Generado por', meta.generatedBy],
  ];
  for (const [k, v] of entries) params.addRow({ k, v: neutralize(v) });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
