'use client';

import type { MfaSetupDto, MfaStatusDto } from '@monty/validation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { Badge, Button, ErrorBanner, Field, Input, PageLoading, useToast } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

/** Two-factor authentication: set up with an authenticator app, recovery codes, turn off. */
export function TwoFactor() {
  const toast = useToast();
  const [status, setStatus] = useState<MfaStatusDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<MfaSetupDto | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [mode, setMode] = useState<'idle' | 'disable' | 'regenerate'>('idle');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await api.auth.mfaStatus());
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setFormError(null);
    try {
      await fn();
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  const start = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setSetup(await api.auth.mfaSetup(password));
      setPassword('');
    });
  };
  const confirm = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.auth.mfaEnable(code);
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      await load();
      toast({ tone: 'success', message: 'Two-factor authentication is on.' });
    });
  };
  const disable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const recovery = code.includes('-') || code.length > 6;
      await api.auth.mfaDisable({ password, ...(recovery ? { recoveryCode: code } : { code }) });
      setPassword('');
      setCode('');
      setMode('idle');
      await load();
      toast({ tone: 'success', message: 'Two-factor authentication is off.' });
    });
  };
  const regenerate = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      setCodes((await api.auth.mfaRecoveryCodes(code)).recoveryCodes);
      setCode('');
      setMode('idle');
      await load();
    });
  };

  if (error) return <ErrorBanner message={error} onRetry={load} />;
  if (!status) return <PageLoading />;

  return (
    <section aria-labelledby="mfa-heading" className="rounded-xl border border-line bg-surface p-4">
      <h2 id="mfa-heading" className="font-semibold">
        Two-factor authentication {status.enabled ? <Badge tone="success">On</Badge> : <Badge>Off</Badge>}
      </h2>
      <p className="mt-1 text-[13px] text-muted">
        Ask for a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) whenever you sign in with your password.
      </p>

      {codes ? (
        <div role="status" className="mt-3 rounded-lg bg-surface-2 p-3">
          <p className="font-medium">Save these recovery codes now</p>
          <p className="text-[13px] text-muted">Each works once if you lose your phone. They won’t be shown again.</p>
          <ul aria-label="Recovery codes" className="mt-2 grid grid-cols-2 gap-1 font-mono text-[13px]">
            {codes.map((c) => <li key={c}>{c}</li>)}
          </ul>
          <div className="mt-2 flex gap-2">
            <Button onClick={() => void navigator.clipboard?.writeText(codes.join('\n'))}>Copy codes</Button>
            <Button onClick={() => setCodes(null)}>I’ve saved them</Button>
          </div>
        </div>
      ) : null}

      {!status.enabled && !setup ? (
        <form onSubmit={start} className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Your password" htmlFor="mfa-password">
            <Input id="mfa-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" variant="primary" busy={busy} disabled={!password}>Set up two-factor</Button>
        </form>
      ) : null}

      {setup ? (
        <form onSubmit={confirm} className="mt-3 space-y-3">
          <p className="text-[13px]">1. Scan this QR code with your authenticator app, or enter the key manually.</p>
          <img src={setup.qrSvgDataUrl} alt="QR code for your authenticator app" width={176} height={176} className="rounded bg-white p-2" />
          <p className="font-mono text-[13px]" aria-label="Setup key">{setup.secret.match(/.{1,4}/g)?.join(' ')}</p>
          <Field label="2. Enter the 6-digit code it shows" htmlFor="mfa-confirm">
            <Input id="mfa-confirm" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.trim())} required />
          </Field>
          <div className="flex gap-2">
            <Button type="submit" variant="primary" busy={busy}>Turn on</Button>
            <Button type="button" onClick={() => setSetup(null)}>Cancel</Button>
          </div>
        </form>
      ) : null}

      {status.enabled && mode === 'idle' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-[13px] text-muted">{status.recoveryCodesRemaining} recovery codes left.</span>
          <Button onClick={() => setMode('regenerate')}>New recovery codes</Button>
          <Button variant="danger" onClick={() => setMode('disable')}>Turn off</Button>
        </div>
      ) : null}

      {status.enabled && mode === 'disable' ? (
        <form onSubmit={disable} className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Your password" htmlFor="mfa-off-password">
            <Input id="mfa-off-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Field label="Code or recovery code" htmlFor="mfa-off-code">
            <Input id="mfa-off-code" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value.trim())} required />
          </Field>
          <Button type="submit" variant="danger" busy={busy}>Turn off two-factor</Button>
          <Button type="button" onClick={() => setMode('idle')}>Cancel</Button>
        </form>
      ) : null}

      {status.enabled && mode === 'regenerate' ? (
        <form onSubmit={regenerate} className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Current 6-digit code" htmlFor="mfa-regen-code">
            <Input id="mfa-regen-code" inputMode="numeric" pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.trim())} required />
          </Field>
          <Button type="submit" busy={busy}>Replace recovery codes</Button>
          <Button type="button" onClick={() => setMode('idle')}>Cancel</Button>
        </form>
      ) : null}

      {formError ? <p role="alert" className="mt-2 text-danger">{formError}</p> : null}
    </section>
  );
}
