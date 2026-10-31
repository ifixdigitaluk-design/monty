/**
 * Central entitlement rules (one place, used by the API — never scattered checks in the UI).
 * Plan names are product tiers; prices are deliberately NOT defined here (pricing is undecided).
 * Limit values are initial placeholders to be confirmed by the business; `null` means unlimited.
 */
export type Plan = 'FREE' | 'PRO' | 'TEAM' | 'BUSINESS' | 'ENTERPRISE';
export type LimitKey = 'projects' | 'members' | 'aiRequestsPerMonth' | 'automationRules';

export const PLAN_LIMITS: Record<Plan, Record<LimitKey, number | null>> = {
  FREE: { projects: 10, members: 5, aiRequestsPerMonth: 20, automationRules: 3 },
  PRO: { projects: null, members: 5, aiRequestsPerMonth: 200, automationRules: 20 },
  TEAM: { projects: null, members: 50, aiRequestsPerMonth: 1000, automationRules: 50 },
  BUSINESS: { projects: null, members: 500, aiRequestsPerMonth: 5000, automationRules: 200 },
  ENTERPRISE: { projects: null, members: null, aiRequestsPerMonth: null, automationRules: null },
};

export const LIMIT_LABEL: Record<LimitKey, string> = {
  projects: 'projects',
  members: 'members (including pending invitations)',
  aiRequestsPerMonth: 'AI requests this month',
  automationRules: 'automation rules',
};

export function checkLimit(plan: Plan, key: LimitKey, currentUsage: number): { ok: boolean; limit: number | null } {
  const limit = PLAN_LIMITS[plan][key];
  return { ok: limit === null || currentUsage < limit, limit };
}
