'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ROLES, ROLE_LABELS, type Role } from '@fingraph/shared';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { fmtDate, fmtRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, Badge, Button, Checkbox, Dialog, EmptyState, Field, Input, LoadingRows, Notice, SectionHeader, Sheet, Table, Td, Th, useToast } from '@/ui';

interface User {
  id: string;
  email: string;
  display_name: string;
  roles: Role[];
  status: 'invited' | 'active' | 'deactivated';
  last_login_at: string | null;
  created_at: string;
}

function useAdminMutation<V>(fn: (v: V) => Promise<unknown>, success: string, keys: string[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      toast({ tone: 'success', message: success });
    },
    onError: (err) => toast({ tone: 'error', message: errorMessage(err) }),
  });
}

function RolesEditor({ value, onChange }: { value: Role[]; onChange: (r: Role[]) => void }) {
  return (
    <fieldset className="flex flex-col gap-1.5">
      <legend className="mb-1 text-xs font-medium">Roles</legend>
      {ROLES.map((r) => (
        <Checkbox
          key={r}
          label={ROLE_LABELS[r]}
          checked={value.includes(r)}
          onChange={(e) => onChange(e.target.checked ? [...value, r] : value.filter((x) => x !== r))}
        />
      ))}
    </fieldset>
  );
}

export function UsersAdmin() {
  const s = useSession();
  const users = useQuery({ queryKey: ['admin-users'], queryFn: () => api<{ items: User[] }>('/v1/users') });
  const invites = useQuery({ queryKey: ['admin-invites'], queryFn: () => api<{ items: { id: string; email: string; roles: Role[]; expires_at: string }[] }>('/v1/invitations') });
  const tokens = useQuery({ queryKey: ['scim-tokens'], queryFn: () => api<{ items: { id: string; name: string; last_used_at: string | null; revoked_at: string | null; created_at: string }[] }>('/v1/tenant/provisioning-tokens') });
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ email: '', display_name: '', roles: ['analyst'] as Role[] });
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [editing, setEditing] = useState<User | null>(null);
  const [roles, setRoles] = useState<Role[]>([]);
  const [scim, setScim] = useState<{ token: string; scim_base_url: string } | null>(null);

  const invite = useAdminMutation((f: typeof form) => api<{ invitation: { url: string } }>('/v1/invitations', { body: f }).then((r) => setInviteUrl(r.invitation.url)), 'Invitation created', [['admin-users'], ['admin-invites']]);
  const update = useAdminMutation((v: { id: string; roles: Role[] }) => api(`/v1/users/${v.id}`, { method: 'PATCH', body: { roles: v.roles } }), 'Roles updated', [['admin-users']]);
  const deactivate = useAdminMutation((id: string) => api(`/v1/users/${id}/deactivate`, { method: 'POST' }), 'User deactivated and signed out', [['admin-users']]);
  const reactivate = useAdminMutation((id: string) => api(`/v1/users/${id}/reactivate`, { method: 'POST' }), 'User reactivated', [['admin-users']]);
  const revokeInvite = useAdminMutation((id: string) => api(`/v1/invitations/${id}/revoke`, { method: 'POST' }), 'Invitation revoked', [['admin-users'], ['admin-invites']]);
  const createToken = useAdminMutation(
    (name: string) => api<{ token: string; scim_base_url: string }>('/v1/tenant/provisioning-tokens', { body: { name } }).then(setScim),
    'Provisioning token created',
    [['scim-tokens']],
  );
  const revokeToken = useAdminMutation((id: string) => api(`/v1/tenant/provisioning-tokens/${id}`, { method: 'DELETE' }), 'Token revoked', [['scim-tokens']]);

  const submitInvite = (e: FormEvent) => {
    e.preventDefault();
    invite.mutate(form);
  };

  return (
    <div className="flex flex-col gap-5">
      <Sheet>
        <div className="border-b border-rule px-4 py-3">
          <SectionHeader
            title="People"
            description="Everyone signs in through your identity provider. Roles control what they can do in FinGraph."
            actions={
              <Button variant="primary" onClick={() => (setInviting(true), setInviteUrl(null), setForm({ email: '', display_name: '', roles: ['analyst'] }))}>
                Invite person
              </Button>
            }
          />
        </div>
        {users.isLoading ? (
          <LoadingRows />
        ) : (
          <Table caption="Users">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Roles</Th>
                <Th>Status</Th>
                <Th>Last sign-in</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {users.data?.items.map((u) => (
                <tr key={u.id}>
                  <Td>
                    <div className="flex items-center gap-2">
                      <Avatar name={u.display_name} />
                      <div>
                        <p className="text-sm font-medium">{u.display_name}</p>
                        <p className="text-2xs text-ink-muted">{u.email}</p>
                      </div>
                    </div>
                  </Td>
                  <Td className="text-xs">{u.roles.map((r) => ROLE_LABELS[r]).join(', ')}</Td>
                  <Td>
                    <Badge tone={u.status === 'active' ? 'verified' : u.status === 'invited' ? 'candidate' : 'neutral'}>{u.status}</Badge>
                  </Td>
                  <Td className="text-xs text-ink-muted">{u.last_login_at ? fmtRelative(u.last_login_at) : 'Never'}</Td>
                  <Td className="text-right whitespace-nowrap">
                    <Button size="sm" variant="ghost" onClick={() => (setEditing(u), setRoles(u.roles))}>
                      Change roles
                    </Button>
                    {u.id !== s.user.id &&
                      (u.status === 'deactivated' ? (
                        <Button size="sm" variant="ghost" onClick={() => reactivate.mutate(u.id)}>
                          Reactivate
                        </Button>
                      ) : u.status === 'active' ? (
                        <Button size="sm" variant="ghost" className="text-conflict" onClick={() => confirm(`Deactivate ${u.display_name}? They are signed out immediately.`) && deactivate.mutate(u.id)}>
                          Deactivate
                        </Button>
                      ) : null)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Sheet>

      {(invites.data?.items.length ?? 0) > 0 && (
        <Sheet>
          <div className="border-b border-rule px-4 py-3">
            <SectionHeader title="Pending invitations" description="Invited people become active the first time they sign in with this email address." />
          </div>
          <ul>
            {invites.data!.items.map((i) => (
              <li key={i.id} className="flex items-center justify-between border-b border-rule/70 px-4 py-2.5 last:border-0">
                <span className="text-sm">
                  {i.email} <span className="text-2xs text-ink-muted">expires {fmtDate(i.expires_at)}</span>
                </span>
                <Button size="sm" variant="ghost" onClick={() => revokeInvite.mutate(i.id)}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </Sheet>
      )}

      <Sheet>
        <div className="border-b border-rule px-4 py-3">
          <SectionHeader
            title="Automatic provisioning (SCIM)"
            description="Let your identity provider create, update and deactivate FinGraph accounts."
            actions={<Button onClick={() => createToken.mutate('Identity provider')}>Create token</Button>}
          />
        </div>
        {scim && (
          <div className="flex flex-col gap-2 p-4">
            <Notice tone="verified" title="Copy this token now">
              It will not be shown again. Base URL: <code>{scim.scim_base_url}</code>
            </Notice>
            <Input readOnly value={scim.token} onFocus={(e) => e.target.select()} aria-label="SCIM token" />
          </div>
        )}
        {tokens.data?.items.length ? (
          <ul>
            {tokens.data.items.map((t) => (
              <li key={t.id} className="flex items-center justify-between border-t border-rule/70 px-4 py-2.5">
                <span className="text-sm">
                  {t.name}{' '}
                  <span className="text-2xs text-ink-muted">
                    created {fmtDate(t.created_at)}, {t.last_used_at ? `last used ${fmtRelative(t.last_used_at)}` : 'never used'}
                  </span>
                </span>
                {t.revoked_at ? (
                  <Badge>Revoked</Badge>
                ) : (
                  <Button size="sm" variant="ghost" onClick={() => revokeToken.mutate(t.id)}>
                    Revoke
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          !scim && <div className="p-4 text-xs text-ink-muted">No provisioning tokens.</div>
        )}
      </Sheet>

      <Dialog open={inviting} onClose={() => setInviting(false)} title="Invite a person">
        {inviteUrl ? (
          <div className="flex flex-col gap-3">
            <Notice tone="verified" title="Invitation created">
              Send this sign-in link to {form.email}. It is valid for 7 days.
            </Notice>
            <Input readOnly value={inviteUrl} onFocus={(e) => e.target.select()} aria-label="Invitation link" />
            <div className="flex justify-end">
              <Button onClick={() => setInviting(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submitInvite} className="flex flex-col gap-4">
            <Field label="Work email">
              {(id) => <Input id={id} type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}
            </Field>
            <Field label="Name">
              {(id) => <Input id={id} required value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />}
            </Field>
            <RolesEditor value={form.roles} onChange={(r) => setForm({ ...form, roles: r })} />
            <div className="flex justify-end gap-2">
              <Button onClick={() => setInviting(false)}>Cancel</Button>
              <Button type="submit" variant="primary" busy={invite.isPending} disabled={!form.roles.length}>
                Create invitation
              </Button>
            </div>
          </form>
        )}
      </Dialog>

      <Dialog open={!!editing} onClose={() => setEditing(null)} title={`Roles for ${editing?.display_name}`} description="Changes apply to their current session immediately.">
        <div className="flex flex-col gap-4">
          <RolesEditor value={roles} onChange={setRoles} />
          <div className="flex justify-end gap-2">
            <Button onClick={() => setEditing(null)}>Cancel</Button>
            <Button variant="primary" disabled={!roles.length} busy={update.isPending} onClick={() => update.mutate({ id: editing!.id, roles }, { onSuccess: () => setEditing(null) })}>
              Save roles
            </Button>
          </div>
        </div>
      </Dialog>
      {users.error && <EmptyState title="You cannot manage people">Ask an administrator.</EmptyState>}
    </div>
  );
}
