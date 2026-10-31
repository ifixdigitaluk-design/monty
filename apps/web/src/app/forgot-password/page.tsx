'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { CenteredCard } from '@/components/CenteredCard';
import { Button, Field, Input, PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function ForgotPasswordPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <ForgotPassword />
    </Suspense>
  );
}

function ForgotPassword() {
  const params = useSearchParams();
  const [email, setEmail] = useState(() => params.get('email') ?? '');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setDone((await api.auth.requestPasswordReset(email.trim())).message);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <CenteredCard title="Reset your password">
      {done ? (
        <>
          <p role="status">{done} The link expires in 1 hour.</p>
          <p className="text-[13px] text-muted">Didn’t get it? Check spam, or try again in a few minutes.</p>
          <Link className="text-accent underline" href="/login">
            Back to sign in
          </Link>
        </>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <p className="text-muted">Enter your account email and we’ll send you a link to choose a new password.</p>
          <Field label="Email" htmlFor="email">
            <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {error ? <p role="alert" className="text-danger">{error}</p> : null}
          <Button type="submit" variant="primary" className="w-full" busy={busy} disabled={!email.trim()}>
            Send reset link
          </Button>
          <p className="text-center text-[13px]">
            <Link className="text-accent underline" href="/login">Back to sign in</Link>
          </p>
        </form>
      )}
    </CenteredCard>
  );
}
