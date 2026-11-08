/** Product-facing account verification statuses (dual-signup gate). */
export type AccountVerificationStatus =
  | 'PENDING_VERIFICATION'
  | 'VERIFIED'
  | 'REJECTED';

/** Product-facing account roles. */
export type AccountAppRole = 'PARENT' | 'ADMIN';

export type AccountVerificationSnapshot = {
  accountStatus: AccountVerificationStatus;
  accountRole: AccountAppRole;
  schoolId: string | null;
  invitationCodePresent: boolean;
  verifiedAt: string | null;
  suburb: string | null;
  schoolLabel: string | null;
  displayName: string;
};

export type PendingAccountVerification = {
  userId: string;
  displayName: string;
  accountStatus: AccountVerificationStatus;
  accountRole: AccountAppRole;
  schoolId: string | null;
  suburb: string | null;
  schoolLabel: string | null;
  invitationCodePresent: boolean;
  createdAt: string;
};

export function normalizeAccountStatus(value: unknown): AccountVerificationStatus {
  const raw = String(value ?? '').trim().toUpperCase();
  if (raw === 'VERIFIED') return 'VERIFIED';
  if (raw === 'REJECTED') return 'REJECTED';
  return 'PENDING_VERIFICATION';
}

export function normalizeAccountRole(value: unknown): AccountAppRole {
  return String(value ?? '').trim().toUpperCase() === 'ADMIN' ? 'ADMIN' : 'PARENT';
}

export function isAccountPending(status: AccountVerificationStatus | null | undefined): boolean {
  return status === 'PENDING_VERIFICATION';
}

export function isAccountRejected(status: AccountVerificationStatus | null | undefined): boolean {
  return status === 'REJECTED';
}

export function isAccountVerified(status: AccountVerificationStatus | null | undefined): boolean {
  return status === 'VERIFIED';
}

/** Pending account verification blocks Instant Pickup / Marketplace ready access. */
export function accountGateBlocksFeatures(status: AccountVerificationStatus | null | undefined): boolean {
  return isAccountPending(status) || isAccountRejected(status);
}

export const PENDING_VERIFICATION_NOTICE =
  'Your profile is under verification by your school admin.';
