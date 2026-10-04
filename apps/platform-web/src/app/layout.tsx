import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { SessionProvider } from '@/lib/session';
import { ToastHost } from '@/lib/toast';
import './globals.css';

export const metadata: Metadata = { title: 'Consola de plataforma · Fatboy', robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="es-MX">
      <body>
        <SessionProvider>{children}</SessionProvider>
        <ToastHost />
      </body>
    </html>
  );
}
