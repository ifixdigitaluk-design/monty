'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button, Field, Input } from './ui';

/** Only allow same-site relative redirects after login (prevents open redirects). */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/tasks';
}

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const router = useRouter();
  const params = useSearchParams();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') await api.auth.register({ name, email, password });
      else await api.auth.login({ email, password });
      router.replace(safeNext(params.get('next')));
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-xl border border-line bg-surface p-6" noValidate={false}>
        <div>
          <h1 className="text-lg font-semibold">{mode === 'login' ? 'Sign in to Monty' : 'Create your Monty account'}</h1>
          <p className="text-muted">
            {mode === 'login' ? 'Welcome back.' : 'You get a personal workspace straight away.'}
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
    </div>
  );
}
