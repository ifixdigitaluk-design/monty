'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';
import { CenteredCard } from '@/components/CenteredCard';
import { Button, Field, Input } from '@/components/ui';
import { api, errorMessage } from '@/lib/api';

export default function ConfirmDeletionPage() {
  return (
    <Suspense>
      <ConfirmDeletion />
    </Suspense>
  );
}

function ConfirmDeletion() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.account.confirmDeletion(token);
      setDone(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <CenteredCard title="Your account was deleted">
        <p className="text-muted">Your account and personal data have been erased. You have been signed out.</p>
        <Button className="mt-4" onClick={() => router.replace('/register')}>Back to Monty</Button>
      </CenteredCard>
    );
  }
  return (
    <CenteredCard title="Delete your account permanently">
      <form onSubmit={submit} className="space-y-4">
        <p className="text-muted">
          This erases your account and personal space right away. You must be signed in as the account that requested this. It cannot be undone.
        </p>
        <Field label='Type DELETE to confirm' htmlFor="confirm-delete">
          <Input id="confirm-delete" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" required />
        </Field>
        {error ? (
          <p role="alert" className="text-danger">
            {error}{' '}
            <a className="underline" href="/login">Sign in</a> as the account to delete, then open the link from the email again.
          </p>
        ) : null}
        <Button type="submit" variant="danger" busy={busy} disabled={typed !== 'DELETE' || !token}>Delete my account</Button>
        {!token ? <p role="alert" className="text-danger">This link is missing its token. Open the link from the email again.</p> : null}
      </form>
    </CenteredCard>
  );
}
