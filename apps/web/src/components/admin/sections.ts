import type { Permission } from '@fingraph/shared';

type Can = (...p: Permission[]) => boolean;

export const ADMIN_SECTIONS: { id: string; label: string; description: string; allowed: (can: Can) => boolean }[] = [
  { id: 'people', label: 'People', description: 'Accounts, roles and provisioning', allowed: (can) => can('admin:users') },
  { id: 'organization', label: 'Organization', description: 'Sign-in, sessions, retention and limits', allowed: (can) => can('admin:settings') },
  { id: 'policies', label: 'Policies', description: 'Review rules and required documents', allowed: (can) => can('admin:policies') },
  { id: 'integrations', label: 'Integrations', description: 'Connected document repositories', allowed: (can) => can('admin:integrations') || can('document:upload') },
  { id: 'developers', label: 'Developers', description: 'API clients and webhooks', allowed: (can) => can('webhook:manage') || can('api_client:manage') },
  { id: 'governance', label: 'Governance', description: 'Legal holds, retention and system health', allowed: (can) => can('admin:retention') || can('admin:settings') },
];
