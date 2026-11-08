import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  accountGateBlocksFeatures,
  isAccountPending,
  normalizeAccountRole,
  normalizeAccountStatus,
  PENDING_VERIFICATION_NOTICE,
} from '../../shared/account-verification';
import { onboardingAccessState } from '../../shared/onboarding';

describe('account verification dual-signup helpers', () => {
  it('normalises statuses and roles for the product gate', () => {
    expect(normalizeAccountStatus('pending_verification')).toBe('PENDING_VERIFICATION');
    expect(normalizeAccountStatus('VERIFIED')).toBe('VERIFIED');
    expect(normalizeAccountStatus('rejected')).toBe('REJECTED');
    expect(normalizeAccountRole('admin')).toBe('ADMIN');
    expect(normalizeAccountRole('parent')).toBe('PARENT');
    expect(isAccountPending('PENDING_VERIFICATION')).toBe(true);
    expect(accountGateBlocksFeatures('PENDING_VERIFICATION')).toBe(true);
    expect(accountGateBlocksFeatures('VERIFIED')).toBe(false);
    expect(PENDING_VERIFICATION_NOTICE).toMatch(/under verification/i);
  });

  it('blocks ready access while account verification is pending', () => {
    expect(onboardingAccessState({
      membershipStatus: 'verified',
      hasCurrentConsents: true,
      hasChild: true,
      hasSafetyDeclaration: true,
      accountStatus: 'PENDING_VERIFICATION',
    })).toBe('waiting');

    expect(onboardingAccessState({
      membershipStatus: 'verified',
      hasCurrentConsents: true,
      hasChild: true,
      hasSafetyDeclaration: true,
      accountStatus: 'VERIFIED',
    })).toBe('ready');
  });

  it('ships migration 0063 and admin verify route wiring', async () => {
    const migration = await readFile(resolve('db/migrations/0063_day15_account_verification_roles.sql'), 'utf8');
    const adminRouter = await readFile(resolve('server/admin-router.ts'), 'utf8');
    const app = await readFile(resolve('src/App.tsx'), 'utf8');
    const allowlist = await readFile(resolve('db/function_allowlist.json'), 'utf8');

    expect(migration).toMatch(/account_verification_status/);
    expect(migration).toMatch(/complete_parent_signup/);
    expect(migration).toMatch(/verify_account_user/);
    expect(migration).toMatch(/list_pending_account_verifications/);
    expect(adminRouter).toContain("router.post('/signup'");
    expect(adminRouter).toContain("router.post('/users/:userId/verify'");
    expect(adminRouter).toContain('ADMIN_SECRET_KEY');
    expect(app).toContain('Pending Verification');
    expect(app).toContain('AdminSignupScreen');
    expect(app).toContain('AdminVerificationDashboard');
    expect(app).toContain('/signup');
    expect(app).toContain('/admin/signup');
    expect(app).toContain('/admin/dashboard');
    expect(allowlist).toContain('complete_parent_signup');
    expect(allowlist).toContain('verify_account_user');
  });
});
