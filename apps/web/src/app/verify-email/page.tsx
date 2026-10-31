'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { CenteredCard } from '@/components/CenteredCard';
import { PageLoading } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function VerifyEmailPage() {
  return (
    <Suspense fallback={<PageLoading />}>
      <VerifyEmail />
    </Suspense>
  );
}

function VerifyEmail() {
  const token = useSearchParams().get('token') ?? '';
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [error, setError] = useState('');
  const started = useRef(false); // React strict mode runs effects twice in development; the token is single-use.

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.auth
      .verifyEmail(token)
      .then(() => setState('done'))
      .catch((err) => {
        setError(errorMessage(err));
        setState('error');
      });
  }, [token]);

  return (
    <CenteredCard title="Confirm your email">
      {state === 'working' ? <PageLoading /> : null}
      {state === 'done' ? <p role="status">Thanks — your email address is confirmed.</p> : null}
      {state === 'error' ? (
        <p role="alert" className="text-danger">
          {error} You can send a new link from the banner in the app.
        </p>
      ) : null}
      {state !== 'working' ? (
        <Link className="text-accent underline" href="/tasks">
          Continue to Monty
        </Link>
      ) : null}
    </CenteredCard>
  );
}
