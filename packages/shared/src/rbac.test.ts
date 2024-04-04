import { describe, expect, it } from 'vitest';
import { permissionsFor, ROLES, ROLE_PERMISSIONS } from './rbac';

describe('rbac', () => {
  it('gives every role at least one permission', () => {
    for (const role of ROLES) expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
  });

  it('keeps auditors read-only', () => {
    const p = permissionsFor(['auditor']);
    expect(p.has('audit:export')).toBe(true);
    expect(p.has('fact:review')).toBe(false);
    expect(p.has('case:update')).toBe(false);
    expect(p.has('document:upload')).toBe(false);
  });

  it('only lets risk managers approve cases', () => {
    const approvers = ROLES.filter((r) => ROLE_PERMISSIONS[r].includes('case:approve'));
    expect(approvers).toEqual(['risk_manager']);
  });

  it('merges permissions across roles', () => {
    const p = permissionsFor(['onboarding', 'developer']);
    expect(p.has('document:upload')).toBe(true);
    expect(p.has('webhook:manage')).toBe(true);
  });
});
