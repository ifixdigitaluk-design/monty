'use client';

import type { ReadinessReport } from '@monty/domain';
import { Badge } from '../ui';
import { STATUS_LABEL, STATUS_TONE } from '@/lib/labels';

export function ReadinessPanel({
  report,
  onOpenTask,
  taskTitle,
}: {
  report: ReadinessReport;
  onOpenTask: (taskId: string) => void;
  taskTitle: (taskId: string) => string;
}) {
  const { health } = report;
  return (
    <section aria-labelledby="readiness-title" className="rounded-xl border border-line bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h2 id="readiness-title" className="font-semibold">
          Readiness
        </h2>
        <Badge tone={STATUS_TONE[report.computedStatus]}>{STATUS_LABEL[report.computedStatus]}</Badge>
      </div>
      <ul className="mt-1 text-[13px] text-muted" aria-label="Why this status">
        {report.statusReasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>

      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Stat label="Done" value={`${health.percentComplete}%`} />
        <Stat label="Overdue" value={health.overdueTasks} warn={health.overdueTasks > 0} />
        <Stat label="Blocked" value={health.blockedTasks} warn={health.blockedTasks > 0} />
      </dl>

      <p className="mt-4 text-[12px] font-medium uppercase tracking-wide text-muted">
        Checks · {report.passedCount}/{report.checkCount} passing
      </p>
      <ul className="mt-2 space-y-2">
        {report.checks.map((c) => (
          <li key={c.id} className="flex gap-2" data-check={c.id} data-passed={c.passed}>
            <span aria-hidden className={c.passed ? 'text-success' : c.severity === 'required' ? 'text-danger' : 'text-warning'}>
              {c.passed ? '✓' : c.severity === 'required' ? '✕' : '!'}
            </span>
            <div className="min-w-0">
              <p className="text-[13px] font-medium">
                {c.title}
                <span className="sr-only">{c.passed ? ' — passing' : ' — failing'}</span>
                {c.severity === 'recommended' ? <span className="ml-1 font-normal text-muted">(recommended)</span> : null}
              </p>
              {!c.passed ? <p className="text-[13px] text-muted">{c.reason}</p> : null}
              {!c.passed && c.affectedTaskIds.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1">
                  {c.affectedTaskIds.slice(0, 5).map((id) => (
                    <button key={id} className="max-w-full truncate text-[12px] text-accent underline" onClick={() => onOpenTask(id)}>
                      {taskTitle(id)}
                    </button>
                  ))}
                  {c.affectedTaskIds.length > 5 ? (
                    <span className="text-[12px] text-muted">+{c.affectedTaskIds.length - 5} more</span>
                  ) : null}
                </div>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-4 text-[12px] text-muted">Calculated from this project’s data on {report.evaluatedOn}. No AI involved.</p>
    </section>
  );
}

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className="rounded-lg bg-surface-2 p-2">
      <dt className="text-[12px] text-muted">{label}</dt>
      <dd className={warn ? 'font-semibold text-warning' : 'font-semibold'}>{value}</dd>
    </div>
  );
}
