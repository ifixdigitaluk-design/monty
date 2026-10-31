'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button, Field, Input } from './ui';

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
  const [error, setError] = useState<string | null>(null);
  const [checkEmail, setCheckEmail] = useState(false);
  const [mfaToken, setMfaToken] = useState<string | null>(null);
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
