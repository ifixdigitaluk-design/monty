'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
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
  const params = useSearchParams();
  const token = params.get('token') ?? '';
  const next = params.get('next');
  const router = useRouter();
  const [signedIn, setSignedIn] = useState(false);
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [error, setError] = useState('');
  const started = useRef(false); // React strict mode runs effects twice in development; the token is single-use.

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    api.auth
      .verifyEmail(token)
      .then((r) => {
        setState('done');
        if (r.signedIn) {
          setSignedIn(true);
          // Only same-site relative paths (no open redirects).
          router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : '/home');
        }
      })
      .catch((err) => {
        setError(errorMessage(err));
        setState('error');
      });
  }, [token, next, router]);

  return (
    <CenteredCard title="Confirm your email">
      {state === 'working' ? <PageLoading /> : null}
      {state === 'done' ? (
        <p role="status">{signedIn ? 'Thanks — your email address is confirmed. Signing you in…' : 'Thanks — your email address is confirmed. Sign in to continue.'}</p>
      ) : null}
      {state === 'error' ? (
        <p role="alert" className="text-danger">
          {error} You can send a new link from the banner in the app.
        </p>
      ) : null}
      {state !== 'working' ? (
        <Link className="text-accent underline" href={signedIn ? '/home' : '/login'}>
          {signedIn ? 'Continue to Monty' : 'Sign in'}
        </Link>
      ) : null}
    </CenteredCard>
  );
}
