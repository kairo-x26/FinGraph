/**
 * Roles map to the user groups in the requirements (section 3). Permissions are
 * checked on every request in addition to tenant, case and document scoping.
 */
export const ROLES = [
  'admin',
  'analyst',
  'risk_manager',
  'onboarding',
  'auditor',
  'developer',
] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = [
  'case:read',
  'case:create',
  'case:update',
  'case:assign',
  'case:review',
  'case:approve',
  'document:read',
  'document:upload',
  'document:download',
  'document:delete',
  'fact:review',
  'graph:read',
  'graph:edit',
  'rag:query',
  'audit:read',
  'audit:export',
  'dashboard:read',
  'admin:users',
  'admin:settings',
  'admin:policies',
  'admin:retention',
  'admin:integrations',
  'webhook:manage',
  'api_client:manage',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const analystBase: Permission[] = [
  'case:read',
  'case:create',
  'case:update',
  'case:review',
  'document:read',
  'document:upload',
  'document:download',
  'fact:review',
  'graph:read',
  'graph:edit',
  'rag:query',
  'dashboard:read',
];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  admin: [
    'case:read',
    'dashboard:read',
    'audit:read',
    'admin:users',
    'admin:settings',
    'admin:policies',
    'admin:retention',
    'admin:integrations',
    'webhook:manage',
    'api_client:manage',
    'document:delete',
  ],
  analyst: analystBase,
  risk_manager: [...analystBase, 'case:assign', 'case:approve', 'admin:policies', 'audit:read'],
  onboarding: ['case:read', 'case:create', 'case:update', 'case:assign', 'document:read', 'document:upload'],
  auditor: [
    'case:read',
    'document:read',
    'document:download',
    'graph:read',
    'audit:read',
    'audit:export',
    'dashboard:read',
  ],
  developer: ['case:read', 'document:read', 'webhook:manage', 'api_client:manage'],
};

export function permissionsFor(roles: readonly Role[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const role of roles) {
    for (const p of ROLE_PERMISSIONS[role] ?? []) out.add(p);
  }
  return out;
}

export function isRole(value: string): value is Role {
  return (ROLES as readonly string[]).includes(value);
}

export const ROLE_LABELS: Record<Role, string> = {
  admin: 'Platform administrator',
  analyst: 'Compliance analyst',
  risk_manager: 'Risk manager',
  onboarding: 'Onboarding specialist',
  auditor: 'Internal auditor',
  developer: 'Integration developer',
};

/** OAuth scopes for API clients and the permissions each grants. */
export const API_SCOPES = {
  'cases:read': ['case:read'],
  'cases:write': ['case:read', 'case:create', 'case:update', 'case:assign'],
  'documents:read': ['document:read', 'document:download'],
  'documents:write': ['document:read', 'document:upload'],
  'facts:review': ['fact:review', 'document:read'],
  'graph:read': ['graph:read'],
  'rag:query': ['rag:query'],
  'audit:read': ['audit:read'],
  'audit:export': ['audit:export'],
  'webhooks:manage': ['webhook:manage'],
} as const satisfies Record<string, readonly Permission[]>;
export type ApiScope = keyof typeof API_SCOPES;
export const API_SCOPE_LIST = Object.keys(API_SCOPES) as ApiScope[];

export function permissionsForScopes(scopes: readonly string[]): Set<Permission> {
  const out = new Set<Permission>();
  for (const s of scopes) for (const p of API_SCOPES[s as ApiScope] ?? []) out.add(p);
  return out;
}
