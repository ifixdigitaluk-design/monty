import { ReactNode } from 'react';

/** Layout for signed-out single-purpose pages (reset password, verify email, invitations). */
export function CenteredCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6">
        <h1 className="text-lg font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
