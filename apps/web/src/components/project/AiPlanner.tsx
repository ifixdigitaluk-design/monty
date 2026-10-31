'use client';

import type { AiProposalDto } from '@monty/validation';
import { FormEvent, useEffect, useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button, Field, Modal, Spinner, Textarea, useToast } from '../ui';

/** Idea → plan: the assistant proposes tasks; nothing changes until the user picks what to add. */
export function AiPlanner({ projectId, open, onClose, onApplied }: { projectId: string; open: boolean; onClose: () => void; onApplied: () => void }) {
  const toast = useToast();
  const [proposal, setProposal] = useState<AiProposalDto | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [guidance, setGuidance] = useState('');
  const [busy, setBusy] = useState<'plan' | 'apply' | null>(null);

  useEffect(() => {
    if (!open) return;
    api.ai
      .proposals(projectId)
      .then((r) => {
        const pending = r.proposals.find((p) => p.status === 'PENDING') ?? null;
        setProposal(pending);
        setSelected(new Set(pending?.plan.tasks.map((_, i) => i)));
      })
      .catch(() => undefined);
  }, [open, projectId]);

  async function plan(e?: FormEvent) {
    e?.preventDefault();
    setBusy('plan');
    try {
      if (proposal) await api.ai.reject(proposal.id).catch(() => undefined);
      const { proposal: p } = await api.ai.plan(projectId, guidance.trim() || undefined);
      setProposal(p);
      setSelected(new Set(p.plan.tasks.map((_, i) => i)));
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    if (!proposal) return;
    setBusy('apply');
    try {
      await api.ai.apply(proposal.id, [...selected].sort((a, b) => a - b));
      toast({ tone: 'success', message: `Added ${selected.size} task${selected.size === 1 ? '' : 's'} to the project.` });
      setProposal(null);
      onApplied();
      onClose();
    } catch (err) {
      toast({ tone: 'error', message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  return (
    <Modal open={open} onClose={onClose} title="Plan with AI">
      <form onSubmit={plan} className="space-y-3">
        <Field label="Anything the plan should consider? (optional)" htmlFor="ai-guidance">
          <Textarea id="ai-guidance" rows={2} value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder="e.g. launch before the trade show, two designers available" />
        </Field>
        <Button type="submit" busy={busy === 'plan'}>{proposal ? 'Suggest a new plan' : 'Suggest tasks'}</Button>
      </form>
      {busy === 'plan' ? (
        <p className="mt-3 flex items-center gap-2 text-muted"><Spinner /> Thinking…</p>
      ) : proposal ? (
        <div className="mt-4 space-y-2" data-proposal={proposal.id}>
          <p className="text-[12px] text-muted">
            Suggested by {proposal.providerLabel}. Review before adding — nothing changes until you choose. {proposal.plan.summary}
          </p>
          <ul className="max-h-[40vh] space-y-1 overflow-y-auto">
            {proposal.plan.tasks.map((t, i) => (
              <li key={i}>
                <label className="flex items-start gap-2 rounded-md p-1 hover:bg-surface-2">
                  <input
                    type="checkbox"
                    className="mt-1 accent-[var(--accent)]"
                    checked={selected.has(i)}
                    onChange={(e) =>
                      setSelected((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(i);
                        else n.delete(i);
                        return n;
                      })
                    }
                  />
                  <span>
                    <span className="font-medium">{t.title}</span>
                    {t.description ? <span className="block text-[12px] text-muted">{t.description}</span> : null}
                    <span className="block text-[11px] text-muted">
                      {t.dueInDays !== null ? `Due in ${t.dueInDays} days` : 'No due date'}
                      {t.dependsOn.length ? ` · after “${proposal.plan.tasks[t.dependsOn[0]!]?.title}”` : ''}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <Button onClick={async () => { await api.ai.reject(proposal.id).catch(() => undefined); setProposal(null); }}>Discard</Button>
            <Button variant="primary" busy={busy === 'apply'} disabled={selected.size === 0} onClick={() => void apply()}>
              Add {selected.size} task{selected.size === 1 ? '' : 's'}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
