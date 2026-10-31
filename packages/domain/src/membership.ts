/**
 * Rules for changing who belongs to an organisation and with which role.
 * Pure functions; the API calls them inside a transaction with fresh data.
 */
import { OrgRole } from './permissions';

export type MembershipDecision = { ok: true } | { ok: false; reason: string };

const allow: MembershipDecision = { ok: true };
const deny = (reason: string): MembershipDecision => ({ ok: false, reason });

const isManager = (r: OrgRole | null | undefined) => r === 'OWNER' || r === 'ADMIN';

/** Roles that can be offered in an invitation. Ownership is granted later by an owner, never by invitation. */
export const INVITABLE_ROLES: readonly OrgRole[] = ['ADMIN', 'MEMBER', 'GUEST'];

export function canInvite(actorRole: OrgRole | null | undefined, invitedRole: OrgRole): MembershipDecision {
  if (!isManager(actorRole)) return deny('Only organisation owners and admins can invite people.');
  if (!INVITABLE_ROLES.includes(invitedRole)) return deny('Invitations cannot grant ownership. Invite as admin, then transfer ownership.');
  return allow;
}

export interface RoleChangeInput {
  actorRole: OrgRole | null | undefined;
  targetCurrentRole: OrgRole;
  newRole: OrgRole;
  ownerCount: number;
}

export function canChangeRole({ actorRole, targetCurrentRole, newRole, ownerCount }: RoleChangeInput): MembershipDecision {
  if (!isManager(actorRole)) return deny('Only organisation owners and admins can change roles.');
  if (actorRole !== 'OWNER' && (targetCurrentRole === 'OWNER' || newRole === 'OWNER')) {
    return deny('Only an owner can grant or change ownership.');
  }
  if (targetCurrentRole === 'OWNER' && newRole !== 'OWNER' && ownerCount <= 1) {
    return deny('An organisation must keep at least one owner.');
  }
  return allow;
}

export interface RemovalInput {
  actorRole: OrgRole | null | undefined;
  targetRole: OrgRole;
  isSelf: boolean;
  ownerCount: number;
}

export function canRemoveMember({ actorRole, targetRole, isSelf, ownerCount }: RemovalInput): MembershipDecision {
  if (targetRole === 'OWNER' && ownerCount <= 1) return deny('An organisation must keep at least one owner.');
  if (isSelf) return actorRole ? allow : deny('You are not a member of this organisation.');
  if (!isManager(actorRole)) return deny('Only organisation owners and admins can remove members.');
  if (actorRole !== 'OWNER' && targetRole === 'OWNER') return deny('Only an owner can remove another owner.');
  return allow;
}

/** When an existing member accepts an invitation, never downgrade them. */
const RANK: Record<OrgRole, number> = { GUEST: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };
export function higherOrgRole(a: OrgRole, b: OrgRole): OrgRole {
  return RANK[a] >= RANK[b] ? a : b;
}
