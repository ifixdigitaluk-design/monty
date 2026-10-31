import type { Metadata, Viewport } from 'next';
import { ReactNode } from 'react';
import { ToastProvider } from '@/components/ui';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Monty', template: '%s · Monty' },
  description: 'Plan, organise and deliver projects — with readiness you can trust.',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans antialiased">
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
