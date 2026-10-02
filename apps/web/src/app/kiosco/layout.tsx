import type { Metadata } from 'next';
import type { ReactNode } from 'react';

export const metadata: Metadata = { title: 'Kiosco · Reloj checador', robots: { index: false } };

export default function KioskLayout({ children }: { children: ReactNode }) {
  return children;
}
