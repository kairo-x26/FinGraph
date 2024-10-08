'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { fmtDateTime, fmtRelative } from '@/lib/format';
import { Badge, Button, Checkbox, Dialog, EmptyState, Field, Input, LoadingRows, Notice, SectionHeader, Sheet, Table, Td, Th, useToast } from '@/ui';

interface Client {
  id: string;
  name: string;
  client_id: string;
  scopes: string[];
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface Hook {
  id: string;
  url: string;
  description: string | null;
  event_types: string[];
  status: string;
  consecutive_failures: number;
  dead_deliveries: number;
  last_delivered_at: string | null;
}

interface Delivery {
  id: string;
  event_type: string;
  status: string;
  attempts: number;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
}

function useMut<V>(fn: (v: V) => Promise<unknown>, keys: string[][], success?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      keys.forEach((k) => qc.invalidateQueries({ queryKey: k }));
      if (success) toast({ tone: 'success', message: success });
    },
    onError: (e) => toast({ tone: 'error', message: errorMessage(e) }),
  });
}

function Deliveries({ hook }: { hook: Hook }) {
  const q = useQuery({ queryKey: ['deliveries', hook.id], queryFn: () => api<{ items: Delivery[] }>(`/v1/webhooks/${hook.id}/deliveries`), refetchInterval: 3000 });
  const redeliver = useMut((id: string) => api(`/v1/webhooks/${hook.id}/deliveries/${id}/redeliver`, { method: 'POST' }), [['deliveries', hook.id]], 'Queued for delivery');
  if (q.isLoading) return <LoadingRows rows={3} />;
  if (!q.data?.items.length) return <p className="px-4 py-3 text-xs text-ink-muted">No deliveries yet.</p>;
  return (
    <Table caption="Deliveries">
      <thead>
        <tr>
          <Th>Event</Th>
          <Th>Result</Th>
          <Th numeric>Attempts</Th>
          <Th>Created</Th>
          <Th />
        </tr>
      </thead>
      <tbody>
        {q.data.items.map((d) => (
          <tr key={d.id}>
            <Td className="text-xs">{d.event_type}</Td>
            <Td>
              <Badge tone={d.status === 'succeeded' ? 'verified' : d.status === 'dead' || d.status === 'failed' ? 'conflict' : 'candidate'}>{d.status === 'dead' ? 'gave up' : d.status}</Badge>
              {d.last_status_code ? <span className="ml-1 text-2xs text-ink-muted">HTTP {d.last_status_code}</span> : d.last_error ? <span className="ml-1 text-2xs text-ink-muted">{d.last_error}</span> : null}
            </Td>
            <Td numeric>{d.attempts}</Td>
            <Td className="text-xs text-ink-muted">{fmtDateTime(d.created_at)}</Td>
            <Td className="text-right">
              {d.status !== 'succeeded' && d.status !== 'pending' && (
                <Button size="sm" variant="ghost" onClick={() => redeliver.mutate(d.id)}>
                  Send again
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

export function DevelopersAdmin() {
  const clients = useQuery({ queryKey: ['api-clients'], queryFn: () => api<{ items: Client[]; available_scopes: string[] }>('/v1/api-clients') });
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api<{ items: Hook[]; event_types: string[] }>('/v1/webhooks') });
  const [newClient, setNewClient] = useState<{ name: string; scopes: string[] } | null>(null);
  const [secret, setSecret] = useState<{ client_id: string; client_secret: string; token_url: string } | null>(null);
  const [newHook, setNewHook] = useState<{ url: string; event_types: string[] } | null>(null);
  const [hookSecret, setHookSecret] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const createClient = useMut((v: { name: string; scopes: string[] }) => api<{ client_id: string; client_secret: string; token_url: string }>('/v1/api-clients', { body: v }).then(setSecret), [['api-clients']]);
  const revokeClient = useMut((id: string) => api(`/v1/api-clients/${id}`, { method: 'DELETE' }), [['api-clients']], 'Client revoked');
  const createHook = useMut((v: { url: string; event_types: string[] }) => api<{ secret: string }>('/v1/webhooks', { body: v }).then((r) => setHookSecret(r.secret)), [['webhooks']]);
  const testHook = useMut((id: string) => api(`/v1/webhooks/${id}/test`, { method: 'POST' }), [['deliveries']], 'Test event sent');
  const rotate = useMut((id: string) => api<{ secret: string }>(`/v1/webhooks/${id}/rotate-secret`, { method: 'POST' }).then((r) => setHookSecret(r.secret)), [['webhooks']]);
  const toggleHook = useMut((h: Hook) => api(`/v1/webhooks/${h.id}`, { method: 'PATCH', body: { status: h.status === 'active' ? 'disabled' : 'active' } }), [['webhooks']]);
  const deleteHook = useMut((id: string) => api(`/v1/webhooks/${id}`, { method: 'DELETE' }), [['webhooks']], 'Webhook deleted');

  const submitClient = (e: FormEvent) => {
    e.preventDefault();
    createClient.mutate(newClient!);
  };
  const submitHook = (e: FormEvent) => {
    e.preventDefault();
    createHook.mutate(newHook!);
  };

  return (
    <div className="flex flex-col gap-5">
      <Sheet>
        <div className="border-b border-rule px-4 py-3">
          <SectionHeader
            title="API clients"
            description="Server-to-server access with OAuth 2.0 client credentials. Tokens last 15 minutes. API reference: /api/docs"
            actions={
              <Button variant="primary" onClick={() => (setSecret(null), setNewClient({ name: '', scopes: ['cases:read', 'documents:write'] }))}>
                New client
              </Button>
            }
          />
        </div>
        {clients.isLoading ? (
          <LoadingRows />
        ) : !clients.data?.items.length ? (
          <div className="p-4">
            <EmptyState title="No API clients" />
          </div>
        ) : (
          <Table caption="API clients">
            <thead>
              <tr>
                <Th>Name</Th>
                <Th>Client ID</Th>
                <Th>Scopes</Th>
                <Th>Last used</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {clients.data.items.map((c) => (
                <tr key={c.id}>
                  <Td className="font-medium">{c.name}</Td>
                  <Td className="font-mono text-2xs">{c.client_id}</Td>
                  <Td className="text-2xs text-ink-muted">{c.scopes.join(' ')}</Td>
                  <Td className="text-xs text-ink-muted">{c.revoked_at ? 'Revoked' : c.last_used_at ? fmtRelative(c.last_used_at) : 'Never'}</Td>
                  <Td className="text-right">
                    {!c.revoked_at && (
                      <Button size="sm" variant="ghost" onClick={() => confirm(`Revoke ${c.name}? Its tokens stop working immediately.`) && revokeClient.mutate(c.id)}>
                        Revoke
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Sheet>

      <Sheet>
        <div className="border-b border-rule px-4 py-3">
          <SectionHeader
            title="Webhooks"
            description="Signed HTTPS callbacks for case and document events. Verify the FinGraph-Signature header with your endpoint secret."
            actions={
              <Button variant="primary" onClick={() => (setHookSecret(null), setNewHook({ url: '', event_types: ['document.processed', 'case.review_completed'] }))}>
                New webhook
              </Button>
            }
          />
        </div>
        {hookSecret && !newHook && (
          <div className="flex flex-col gap-2 p-4">
            <Notice tone="verified" title="New signing secret">
              Copy it now; it is not shown again.
            </Notice>
            <Input readOnly value={hookSecret} onFocus={(e) => e.target.select()} aria-label="Signing secret" />
          </div>
        )}
        {hooks.isLoading ? (
          <LoadingRows />
        ) : !hooks.data?.items.length ? (
          <div className="p-4">
            <EmptyState title="No webhooks" />
          </div>
        ) : (
          <ul>
            {hooks.data.items.map((h) => (
              <li key={h.id} className="border-b border-rule/70 last:border-0">
                <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-mono text-xs">{h.url}</p>
                    <div className="mt-1 flex flex-wrap gap-2 text-2xs text-ink-muted">
                      <Badge tone={h.status === 'active' ? 'verified' : 'neutral'}>{h.status}</Badge>
                      {h.dead_deliveries > 0 && <Badge tone="conflict">{h.dead_deliveries} undelivered</Badge>}
                      <span>{h.event_types.join(', ')}</span>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    <Button size="sm" variant="ghost" onClick={() => setOpen(open === h.id ? null : h.id)} aria-expanded={open === h.id}>
                      Deliveries
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => testHook.mutate(h.id)}>
                      Send test
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => rotate.mutate(h.id)}>
                      Rotate secret
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => toggleHook.mutate(h)}>
                      {h.status === 'active' ? 'Pause' : 'Resume'}
                    </Button>
                    <Button size="sm" variant="ghost" className="text-conflict" onClick={() => confirm('Delete this webhook?') && deleteHook.mutate(h.id)}>
                      Delete
                    </Button>
                  </div>
                </div>
                {open === h.id && (
                  <div className="border-t border-rule bg-sheet-sunk">
                    <Deliveries hook={h} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Sheet>

      <Dialog open={!!newClient} onClose={() => setNewClient(null)} title="New API client">
        {secret ? (
          <div className="flex flex-col gap-3">
            <Notice tone="verified" title="Copy the secret now">
              It is shown only once. Exchange it at {secret.token_url}.
            </Notice>
            <Field label="Client ID">{(id) => <Input id={id} readOnly value={secret.client_id} />}</Field>
            <Field label="Client secret">{(id) => <Input id={id} readOnly value={secret.client_secret} onFocus={(e) => e.target.select()} />}</Field>
            <div className="flex justify-end">
              <Button onClick={() => setNewClient(null)}>Done</Button>
            </div>
          </div>
        ) : (
          newClient && (
            <form onSubmit={submitClient} className="flex flex-col gap-4">
              <Field label="Name">{(id) => <Input id={id} required value={newClient.name} onChange={(e) => setNewClient({ ...newClient, name: e.target.value })} placeholder="Onboarding portal" />}</Field>
              <fieldset className="grid grid-cols-2 gap-1.5">
                <legend className="mb-1 text-xs font-medium">Scopes</legend>
                {clients.data?.available_scopes.map((sc) => (
                  <Checkbox
                    key={sc}
                    label={sc}
                    checked={newClient.scopes.includes(sc)}
                    onChange={(e) => setNewClient({ ...newClient, scopes: e.target.checked ? [...newClient.scopes, sc] : newClient.scopes.filter((x) => x !== sc) })}
                  />
                ))}
              </fieldset>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setNewClient(null)}>Cancel</Button>
                <Button type="submit" variant="primary" busy={createClient.isPending} disabled={!newClient.scopes.length}>
                  Create client
                </Button>
              </div>
            </form>
          )
        )}
      </Dialog>

      <Dialog open={!!newHook} onClose={() => setNewHook(null)} title="New webhook" width="max-w-xl">
        {hookSecret && newHook ? (
          <div className="flex flex-col gap-3">
            <Notice tone="verified" title="Copy the signing secret now">
              It is shown only once.
            </Notice>
            <Input readOnly value={hookSecret} onFocus={(e) => e.target.select()} aria-label="Signing secret" />
            <div className="flex justify-end">
              <Button onClick={() => (setNewHook(null), setHookSecret(null))}>Done</Button>
            </div>
          </div>
        ) : (
          newHook && (
            <form onSubmit={submitHook} className="flex flex-col gap-4">
              <Field label="Endpoint URL" hint="Must be HTTPS and publicly reachable.">
                {(id, d) => <Input id={id} aria-describedby={d} type="url" required value={newHook.url} onChange={(e) => setNewHook({ ...newHook, url: e.target.value })} placeholder="https://example.com/fingraph" />}
              </Field>
              <fieldset className="grid grid-cols-2 gap-1.5">
                <legend className="mb-1 text-xs font-medium">Events</legend>
                {hooks.data?.event_types.map((t) => (
                  <Checkbox
                    key={t}
                    label={t}
                    checked={newHook.event_types.includes(t)}
                    onChange={(e) => setNewHook({ ...newHook, event_types: e.target.checked ? [...newHook.event_types, t] : newHook.event_types.filter((x) => x !== t) })}
                  />
                ))}
              </fieldset>
              <div className="flex justify-end gap-2">
                <Button onClick={() => setNewHook(null)}>Cancel</Button>
                <Button type="submit" variant="primary" busy={createHook.isPending} disabled={!newHook.event_types.length}>
                  Create webhook
                </Button>
              </div>
            </form>
          )
        )}
      </Dialog>
    </div>
  );
}
