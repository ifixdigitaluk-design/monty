'use client';

import type { CreatedDataExportDto, DataExportDto, DeletionBlockerDto, PendingOrganisationDeletionDto } from '@monty/validation';
import Link from 'next/link';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { Button, ErrorBanner, Field, Input, PageLoading, useToast } from '@/components/ui';
import { api, errorMessage, formatDate } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function AccountPage() {
  return (
    <AppShell>
      <Account />
    </AppShell>
  );
}

function Account() {
  const { user, refreshOrganisations } = useSession();
  const toast = useToast();
  const [exports, setExports] = useState<DataExportDto[] | null>(null);
  const [fresh, setFresh] = useState<CreatedDataExportDto | null>(null);
  const [pending, setPending] = useState<PendingOrganisationDeletionDto[]>([]);
  const [blockers, setBlockers] = useState<DeletionBlockerDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [e, p, b] = await Promise.all([api.account.exports(), api.organisations.pendingDeletion(), api.account.deletionBlockers()]);
      setExports(e.exports);
      setPending(p.organisations);
      setBlockers(b.blockers);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function createExport() {
    setBusy('export');
    try {
      const { export: ex } = await api.account.createExport();
      setFresh(ex);
      void load();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function restore(o: PendingOrganisationDeletionDto) {
    setBusy(o.id);
    try {
      await api.organisations.restore(o.id);
      toast({ tone: 'success', message: `${o.name} was restored.` });
      await Promise.all([load(), refreshOrganisations()]);
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  if (error) return <div className="p-8"><ErrorBanner message={error} onRetry={load} /></div>;
  if (!exports) return <PageLoading />;

  return (
    <div className="mx-auto max-w-3xl space-y-8 p-6">
      <header>
        <h1 className="text-xl font-semibold">Account & data</h1>
        <p className="text-muted">Signed in as {user.email}</p>
      </header>

      <section aria-labelledby="export-heading" className="rounded-xl border border-line bg-surface p-4">
        <h2 id="export-heading" className="font-semibold">Download your data</h2>
        <p className="mt-1 text-[13px] text-muted">
          A JSON file with your account, sessions, memberships, and the tasks, comments and documents you created or were assigned in organisations you
          belong to. The download link works only while you are signed in and expires after 24 hours.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button onClick={createExport} busy={busy === 'export'}>Prepare export</Button>
          {fresh ? (
            <a className="text-[13px] font-medium text-accent underline" href={fresh.downloadPath} download>
              Download export ({Math.max(1, Math.round(fresh.sizeBytes / 1024))} KB)
            </a>
          ) : null}
        </div>
        {exports.length ? (
          <ul className="mt-3 text-[12px] text-muted" aria-label="Recent exports">
            {exports.map((e) => (
              <li key={e.id}>
                Prepared {new Date(e.createdAt).toLocaleString()} · expires {new Date(e.expiresAt).toLocaleString()}
                {e.downloadedAt ? ' · downloaded' : ''}
                {fresh?.id === e.id ? '' : ' · link shown only once; prepare a new export to download again'}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      {pending.length ? (
        <section aria-labelledby="pending-heading" className="rounded-xl border border-line bg-surface p-4">
          <h2 id="pending-heading" className="font-semibold">Organisations scheduled for deletion</h2>
          <ul className="mt-2 divide-y divide-line">
            {pending.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 py-2">
                <span>
                  <strong>{o.name}</strong> — erased permanently on {formatDate(o.purgeAfter.slice(0, 10))}
                </span>
                <Button onClick={() => restore(o)} busy={busy === o.id}>Restore {o.name}</Button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <DeleteAccount blockers={blockers} />
      <p className="text-[12px] text-muted">
        How long we keep what, and what deletion removes: see <Link className="underline" href="/settings/sessions">Sessions & security</Link> for active sign-ins.
      </p>
    </div>
  );
}

function DeleteAccount({ blockers }: { blockers: DeletionBlockerDto[] }) {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.account.requestDeletion(password);
      setSent(true);
      setPassword('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="delete-heading" className="rounded-xl border border-danger/40 bg-surface p-4">
      <h2 id="delete-heading" className="font-semibold text-danger">Delete your account</h2>
      <p className="mt-1 text-[13px] text-muted">
        This permanently erases your account, your personal space and any team organisation where you are the only member. In organisations you share with
        others, your tasks, comments and documents stay with the organisation and are shown as “Deleted user”. This cannot be undone.
      </p>
      {blockers.length ? (
        <div role="alert" className="mt-3 rounded-lg bg-surface-2 p-3 text-[13px]">
          You are the only owner of {blockers.map((b) => `${b.name} (${b.memberCount} members)`).join(', ')}. Make another member an owner, or delete
          the organisation, before deleting your account.
        </div>
      ) : sent ? (
        <p role="status" className="mt-3 text-[13px]">
          We’ve emailed you a confirmation link (valid for 1 hour). Open it while signed in to finish deleting your account.
        </p>
      ) : (
        <form onSubmit={submit} className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Your password" htmlFor="delete-password">
            <Input id="delete-password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" variant="danger" busy={busy} disabled={!password}>Email me a deletion link</Button>
        </form>
      )}
      {error ? <p role="alert" className="mt-2 text-danger">{error}</p> : null}
    </section>
  );
}
