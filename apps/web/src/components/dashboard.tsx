'use client';

import type { ReactNode } from 'react';
import { Glyph, type GlyphName } from './icons';
import { signed } from '@/lib/dashboard';

/**
 * Piezas visuales del tablero de Inicio (diseño con tarjetas de color, minigráficas y línea de tiempo). Solo pintan:
 * todo número que reciben sale de datos reales calculados en `lib/dashboard.ts`.
 */

export type KpiTone = 'green' | 'blue' | 'red' | 'orange';

/** Minigráfica de línea con área (serie de números). */
export function SparkLine({ values, label }: { values: number[]; label: string }) {
  const w = 120, h = 48, pad = 4;
  const max = Math.max(1, ...values);
  const pts = values.length === 1 ? [values[0]!, values[0]!] : values;
  const x = (i: number) => pad + (i * (w - pad * 2)) / (pts.length - 1);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2);
  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="none">
      <path d={`${line} L${x(pts.length - 1).toFixed(1)} ${h} L${x(0).toFixed(1)} ${h} Z`} className="spark-area" />
      <path d={line} className="spark-line" fill="none" />
      <circle cx={x(pts.length - 1)} cy={y(pts[pts.length - 1]!)} r="2.6" className="spark-dot" />
    </svg>
  );
}

/** Minigráfica de barras. */
export function SparkBars({ values, label }: { values: number[]; label: string }) {
  const w = 120, h = 48;
  const max = Math.max(1, ...values);
  const gap = 3;
  const bw = (w - gap * (values.length - 1)) / values.length;
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={label} preserveAspectRatio="none">
      {values.map((v, i) => {
        const bh = Math.max(v > 0 ? 3 : 1.5, (v / max) * (h - 2));
        return <rect key={i} x={i * (bw + gap)} y={h - bh} width={bw} height={bh} rx="1.5" className={`spark-bar ${v === 0 ? 'zero' : ''}`} />;
      })}
    </svg>
  );
}

export function Kpi({ tone, glyph, label, value, note, delta, deltaGood, deltaText, chart, href, testid }: {
  tone: KpiTone;
  glyph: GlyphName;
  label: string;
  value: number;
  note?: string;
  /** Diferencia contra el mismo momento de ayer (o `null` si no se pudo calcular). */
  delta: number | null;
  /** `true` si subir es bueno (verde); `false` si subir es malo (rojo). */
  deltaGood: boolean;
  deltaText: string;
  chart: ReactNode;
  href: string;
  testid: string;
}) {
  const direction = delta === null ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const good = delta === null || delta === 0 ? null : (delta > 0) === deltaGood;
  return (
    <a href={href} className={`kpi k-${tone}`} data-testid={`${testid}-card`}>
      <Glyph name={glyph} size={96} className="kpi-mark" />
      <div className="kpi-head">
        <span className="kpi-icon"><Glyph name={glyph} size={52} /></span>
        <div>
          <div className="kpi-label">{label}</div>
          <div className="kpi-value" data-testid={testid}>{value}</div>
        </div>
      </div>
      <div className="kpi-foot">
        <div className="kpi-delta">
          {direction === null ? (
            <span className="muted">{note}</span>
          ) : (
            <>
              <span className={`delta ${good === null ? 'flat' : good ? 'good' : 'bad'}`} data-testid={`${testid}-delta`}>
                {direction !== 'flat' && <Glyph name={direction === 'up' ? 'trendUp' : 'trendDown'} size={16} />}
                {signed(delta!)}
              </span>
              <span className="muted">{deltaText}</span>
            </>
          )}
        </div>
        <div className="kpi-chart">{chart}</div>
      </div>
    </a>
  );
}
