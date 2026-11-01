/**
 * HR rules shared by the API and the web app: leave day counting and balances, management chains and
 * who may see an employee's private details. Pure functions; the API is the authority.
 */

export const LEAVE_TYPES = ['annual', 'sick', 'unpaid', 'parental', 'other'] as const;
export type LeaveType = (typeof LEAVE_TYPES)[number];
export const LEAVE_LABEL: Record<LeaveType, string> = { annual: 'Annual leave', sick: 'Sick', unpaid: 'Unpaid', parental: 'Parental', other: 'Other' };
export const LEAVE_STATUSES = ['pending', 'approved', 'declined', 'cancelled'] as const;
export type LeaveStatus = (typeof LEAVE_STATUSES)[number];
export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractor', 'intern'] as const;
export const EMPLOYMENT_LABEL: Record<(typeof EMPLOYMENT_TYPES)[number], string> = { full_time: 'Full-time', part_time: 'Part-time', contractor: 'Contractor', intern: 'Intern' };
export const HR_DOC_CATEGORIES = ['contract', 'identity', 'certificate', 'review', 'other'] as const;

const day = (iso: string) => new Date(`${iso}T00:00:00Z`);

/** Working days (Mon–Fri) from start to end inclusive. A half day counts 0.5 and only applies to single-day requests. */
export function workingDays(start: string, end: string, halfDay = false): number {
  const s = day(start);
  const e = day(end);
  if (e < s) return 0;
  let n = 0;
  for (let d = new Date(s); d <= e; d.setUTCDate(d.getUTCDate() + 1)) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) n++;
  }
  if (halfDay && start === end && n === 1) return 0.5;
  return n;
}

/** The working days of a request that fall inside a calendar year (requests can span New Year). */
export function workingDaysInYear(start: string, end: string, halfDay: boolean, year: number): number {
  const from = start > `${year}-01-01` ? start : `${year}-01-01`;
  const to = end < `${year}-12-31` ? end : `${year}-12-31`;
  if (to < from) return 0;
  return halfDay && start === end ? workingDays(from, to, true) : workingDays(from, to);
}

export interface LeaveLike {
  type: string;
  status: string;
  startDate: string;
  endDate: string;
  halfDay: boolean;
}

/** Annual leave balance for a calendar year. Pending requests are shown separately (not yet deducted). */
export function leaveBalance(allowance: number, requests: LeaveLike[], year: number) {
  const annual = requests.filter((r) => r.type === 'annual');
  const sum = (status: string) => annual.filter((r) => r.status === status).reduce((a, r) => a + workingDaysInYear(r.startDate, r.endDate, r.halfDay, year), 0);
  const taken = sum('approved');
  const pending = sum('pending');
  return { allowance, taken, pending, remaining: allowance - taken, remainingAfterPending: allowance - taken - pending };
}

export function overlaps(a: { startDate: string; endDate: string }, b: { startDate: string; endDate: string }) {
  return a.startDate <= b.endDate && b.startDate <= a.endDate;
}

/** Everyone above `userId` in the reporting line, nearest first. Stops safely on cycles. */
export function managementChain(userId: string, managerOf: Map<string, string | null>): string[] {
  const chain: string[] = [];
  let cur = managerOf.get(userId) ?? null;
  while (cur && !chain.includes(cur) && cur !== userId && chain.length < 50) {
    chain.push(cur);
    cur = managerOf.get(cur) ?? null;
  }
  return chain;
}

/** True if making `managerId` the manager of `userId` would create a loop (including managing yourself). */
export function wouldCreateManagerCycle(userId: string, managerId: string | null, managerOf: Map<string, string | null>): boolean {
  if (!managerId) return false;
  if (managerId === userId) return true;
  return managementChain(managerId, managerOf).includes(userId);
}

/** Everyone who reports to `userId`, directly or indirectly. */
export function allReports(userId: string, managerOf: Map<string, string | null>): string[] {
  return [...managerOf.keys()].filter((u) => u !== userId && managementChain(u, managerOf).includes(userId));
}

export interface HrViewer {
  userId: string;
  isHrAdmin: boolean;
}

/** Private details (salary, address, documents, reviews…): the person, HR admins, and their management chain. */
export function canSeePrivate(viewer: HrViewer, subjectId: string, managerOf: Map<string, string | null>): boolean {
  return viewer.userId === subjectId || viewer.isHrAdmin || managementChain(subjectId, managerOf).includes(viewer.userId);
}

/** Who may approve someone's leave: HR admins and their management chain — never the requester. */
export function canApproveLeave(viewer: HrViewer, requesterId: string, managerOf: Map<string, string | null>): boolean {
  if (viewer.userId === requesterId) return false;
  return viewer.isHrAdmin || managementChain(requesterId, managerOf).includes(viewer.userId);
}

/** Default checklist steps; HR can edit them per checklist. Offsets are days from the due date. */
export const CHECKLIST_TEMPLATES: Record<'onboarding' | 'offboarding', { title: string; role: 'hr' | 'manager' | 'it'; offset: number }[]> = {
  onboarding: [
    { title: 'Send contract and collect signed copy', role: 'hr', offset: -14 },
    { title: 'Collect right-to-work documents and bank details', role: 'hr', offset: -7 },
    { title: 'Order laptop and accounts (email, Monty)', role: 'it', offset: -7 },
    { title: 'Invite to Monty and team channels', role: 'it', offset: -1 },
    { title: 'Plan first-week schedule and a buddy', role: 'manager', offset: -3 },
    { title: 'Welcome meeting on day one', role: 'manager', offset: 0 },
    { title: 'Agree objectives for the first 90 days', role: 'manager', offset: 14 },
  ],
  offboarding: [
    { title: 'Confirm leaving date and final pay', role: 'hr', offset: -14 },
    { title: 'Handover plan for work and clients', role: 'manager', offset: -10 },
    { title: 'Exit interview', role: 'hr', offset: -2 },
    { title: 'Collect laptop, keys and cards', role: 'it', offset: 0 },
    { title: 'Remove access to email, Monty and other systems', role: 'it', offset: 0 },
  ],
};
