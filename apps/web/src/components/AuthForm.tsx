'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button, Field, Input } from './ui';

const GOOGLE_ERRORS: Record<string, string> = {
  google_cancelled: 'Google sign-in was cancelled.',
  google_expired: 'That Google sign-in took too long or was opened in another browser. Please try again.',
  google_unverified: 'Google hasn’t verified that email address, so it can’t be used to sign in.',
  google_domain: 'That Google account isn’t from an allowed domain. Use your work account.',
  google_not_allowed: 'Monty is invite-only. Ask an administrator for an invitation, then open its link.',
  google_failed: 'Google sign-in didn’t work. Please try again, or sign in with your email and password.',
};

/** Only allow same-site relative redirects after login (prevents open redirects). */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/home';
}

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const params = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState(() => params.get('email') ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => GOOGLE_ERRORS[params.get('error') ?? ''] ?? null);
  const [checkEmail, setCheckEmail] = useState(false);
  // After "Continue with Google" for an account with two-step verification, the server sends us here with a challenge.
  const [mfaToken, setMfaToken] = useState<string | null>(() => (mode === 'login' ? params.get('mfa') : null));
  const [google, setGoogle] = useState(false);
  useEffect(() => {
    api.auth.providers().then((p) => setGoogle(p.google), () => setGoogle(false));
  }, []);
  // Don't leave the one-time challenge in the address bar or history.
  useEffect(() => {
    if (params.get('mfa') && typeof window !== 'undefined') {
      const url = new URL(window.location.href);
      url.searchParams.delete('mfa');
      window.history.replaceState(null, '', url.toString());
    }
  }, [params]);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        const next = params.get('next');
        await api.auth.register({ name, email, password, ...(next && safeNext(next) === next ? { next } : {}) });
        setCheckEmail(true);
        setBusy(false);
        return;
      }
      const result = await api.auth.login({ email, password });
      if (result.mfaRequired) {
        setMfaToken(result.mfaToken);
        setBusy(false);
        return;
      }
      router.replace(safeNext(params.get('next')));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.auth.loginMfa({ mfaToken: mfaToken!, ...(useRecovery ? { recoveryCode: code } : { code }) });
      router.replace(safeNext(params.get('next')));
    } catch (err) {
      const message = errorMessage(err);
      setError(message);
      if (/expired/i.test(message)) setMfaToken(null);
      setBusy(false);
    }
  }

  if (checkEmail) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <div className="w-full max-w-sm space-y-3 rounded-xl border border-line bg-surface p-6" role="status">
          <h1 className="text-lg font-semibold">Check your email</h1>
          <p>
            We’ve sent a link to <strong>{email}</strong>. Open it to confirm your address — it signs you in straight away.
          </p>
          <p className="text-[13px] text-muted">Nothing arrived after a few minutes? Check spam, or try signing in: we’ll send a fresh link.</p>
          <Link className="text-accent underline" href={`/login?email=${encodeURIComponent(email)}`}>Go to sign in</Link>
        </div>
      </main>
    );
  }

  if (mfaToken) {
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <form onSubmit={submitCode} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6">
          <div>
            <h1 className="text-lg font-semibold">Two-step verification</h1>
            <p className="text-muted">{useRecovery ? 'Enter one of your recovery codes.' : 'Enter the 6-digit code from your authenticator app.'}</p>
          </div>
          <Field label={useRecovery ? 'Recovery code' : 'Authentication code'} htmlFor="mfa-code">
            <Input
              id="mfa-code"
              autoComplete="one-time-code"
              inputMode={useRecovery ? 'text' : 'numeric'}
              pattern={useRecovery ? undefined : '[0-9]{6}'}
              maxLength={useRecovery ? 14 : 6}
              value={code}
              onChange={(e) => setCode(e.target.value.trim())}
              required
              autoFocus
            />
          </Field>
          {error ? <p role="alert" className="text-danger">{error}</p> : null}
          <Button type="submit" variant="primary" className="w-full" busy={busy}>Verify</Button>
          <button type="button" className="w-full text-[13px] text-accent underline" onClick={() => { setUseRecovery((v) => !v); setCode(''); setError(null); }}>
            {useRecovery ? 'Use the authenticator app instead' : 'Lost your device? Use a recovery code'}
          </button>
        </form>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6" noValidate={false}>
        <div>
          <h1 className="text-lg font-semibold">{mode === 'login' ? 'Sign in to Monty' : 'Create your Monty account'}</h1>
          <p className="text-muted">
            {mode === 'login' ? 'Welcome back.' : 'We’ll email you a link to confirm your address.'}
          </p>
        </div>
        {mode === 'register' ? (
          <Field label="Name" htmlFor="name">
            <Input id="name" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required />
          </Field>
        ) : null}
        <Field label="Email" htmlFor="email">
          <Input id="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field label="Password" htmlFor="password" hint={mode === 'register' ? 'At least 10 characters.' : undefined}>
          <Input
            id="password"
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={mode === 'register' ? 10 : undefined}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </Field>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
        {mode === 'login' ? (
          <p className="text-right text-[13px]">
            <Link className="text-accent underline" href={`/forgot-password${email ? `?email=${encodeURIComponent(email)}` : ''}`}>
              Forgot password?
            </Link>
          </p>
        ) : null}
        <Button type="submit" variant="primary" className="w-full" busy={busy}>
          {mode === 'login' ? 'Sign in' : 'Create account'}
        </Button>
        {google ? (
          <>
            <div className="flex items-center gap-2 text-[12px] text-muted" aria-hidden="true">
              <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
            </div>
            <a
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-line bg-surface font-medium hover:bg-surface-2"
              href={`/api/v1/auth/google/start${params.get('next') && safeNext(params.get('next')) === params.get('next') ? `?next=${encodeURIComponent(params.get('next')!)}` : ''}`}
            >
              <svg aria-hidden="true" width="16" height="16" viewBox="0 0 48 48">
                <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
                <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
                <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
                <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
              </svg>
              Continue with Google
            </a>
          </>
        ) : null}
        <p className="text-center text-muted">
          {mode === 'login' ? (
            <>
              New here? <Link className="text-accent underline" href="/register">Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link className="text-accent underline" href="/login">Sign in</Link>
            </>
          )}
        </p>
      </form>
    </main>
  );
}
