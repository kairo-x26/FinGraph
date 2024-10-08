'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { fmtBytes, fmtRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { CaseSummary, Paged } from '@/lib/types';
import { Badge, Button, Checkbox, Dialog, EmptyState, Field, LoadingRows, Notice, SectionHeader, Select, Sheet, useToast } from '@/ui';

interface Connection {
  id: string;
  provider: string;
  status: string;
  account_label: string | null;
  scopes: string[];
  last_sync_at: string | null;
  last_error: string | null;
  sync_state: { imported?: number; skipped?: number; case_id?: string };
  imported_files: number;
  created_at: string;
}

interface RemoteFile {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  size: number | null;
  supported: boolean;
}

const CONNECT_ERRORS: Record<string, string> = {
  access_denied: 'Access was not granted at the provider. Nothing was connected.',
  invalid_state: 'The connection request expired. Start again.',
  token_exchange_failed: 'The provider did not accept the authorization. Start again.',
  provider_error: 'The provider returned an error.',
};

function ImportDialog({ c, onClose }: { c: Connection; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [caseId, setCaseId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const files = useQuery({ queryKey: ['connection-files', c.id], queryFn: async () => {
    const out: RemoteFile[] = [];
    let token: string | null | undefined;
    do {
      const page: { items: RemoteFile[]; next_page_token: string | null } = await api(`/v1/connections/${c.id}/files`, { query: { page_token: token ?? undefined } });
      out.push(...page.items);
      token = page.next_page_token;
    } while (token && out.length < 500);
    return out;
  } });
  const cases = useQuery({ queryKey: ['cases', 'open-for-import'], queryFn: () => api<Paged<CaseSummary>>('/v1/cases', { query: { open: 'true', limit: 200 } }) });
  const sync = useMutation({
    mutationFn: () => api(`/v1/connections/${c.id}/sync`, { body: { case_id: caseId, file_ids: selected.length ? selected : undefined } }),
    onSuccess: () => {
      toast({ tone: 'success', message: 'Import started. Files appear in the case as they are processed.' });
      qc.invalidateQueries({ queryKey: ['connections'] });
      onClose();
    },
    onError: (e) => toast({ tone: 'error', message: errorMessage(e) }),
  });
  return (
    <Dialog open onClose={onClose} title="Import files into a case" description="Only new and changed files are imported. Changed files become new versions." width="max-w-2xl">
      <div className="flex flex-col gap-4">
        <Field label="Case">
          {(id) => (
            <Select id={id} value={caseId} onChange={(e) => setCaseId(e.target.value)} required>
              <option value="">Choose an open case</option>
              {cases.data?.items.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.reference} {k.subject_name}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <fieldset>
          <legend className="mb-2 text-xs font-medium">Files (leave all unticked to import everything)</legend>
          {files.isLoading ? (
            <LoadingRows />
          ) : files.error ? (
            <Notice tone="conflict">{errorMessage(files.error)}</Notice>
          ) : (
            <ul className="max-h-72 overflow-y-auto rounded-[var(--radius-control)] border border-rule">
              {files.data?.map((f) => (
                <li key={f.id} className="flex items-center justify-between gap-2 border-b border-rule/70 px-3 py-2 last:border-0">
                  <Checkbox
                    label={f.name}
                    hint={`${fmtBytes(f.size)}, changed ${fmtRelative(f.modifiedTime)}`}
                    disabled={!f.supported}
                    checked={selected.includes(f.id)}
                    onChange={(e) => setSelected(e.target.checked ? [...selected, f.id] : selected.filter((x) => x !== f.id))}
                  />
                  {!f.supported && <Badge>Unsupported type</Badge>}
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!caseId} busy={sync.isPending} onClick={() => sync.mutate()}>
            {selected.length ? `Import ${selected.length} file${selected.length > 1 ? 's' : ''}` : 'Import all files'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function IntegrationsAdmin() {
  const s = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const params = useSearchParams();
  const [importing, setImporting] = useState<Connection | null>(null);
  const providers = useQuery({ queryKey: ['providers'], queryFn: () => api<{ items: { id: string; label: string; scopes: string[] }[] }>('/v1/connections/providers'), enabled: s.can('admin:integrations') });
  const conns = useQuery({ queryKey: ['connections'], queryFn: () => api<{ items: Connection[] }>('/v1/connections') });
  const connect = useMutation({
    mutationFn: (provider: string) => api<{ authorization_url: string }>(`/v1/connections/${provider}/authorize`, { method: 'POST' }),
    onSuccess: (r) => {
      window.location.href = r.authorization_url;
    },
    onError: (e) => toast({ tone: 'error', message: errorMessage(e) }),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api(`/v1/connections/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['connections'] });
      toast({ tone: 'success', message: 'Disconnected. Access at the provider was revoked.' });
    },
  });
  const label = (p: string) => providers.data?.items.find((x) => x.id === p)?.label ?? p.replace('_', ' ');
  const err = params.get('error');
  return (
    <div className="flex flex-col gap-5">
      {params.get('connected') && <Notice tone="verified">{label(params.get('connected')!)} is connected.</Notice>}
      {err && <Notice tone="conflict">{CONNECT_ERRORS[err] ?? 'The connection could not be completed.'}</Notice>}
      {s.can('admin:integrations') && (
        <Sheet className="flex flex-col gap-3 p-4">
          <SectionHeader title="Connect a document repository" description="FinGraph asks for read-only access. You approve it at the provider; no passwords are shared." />
          <div className="flex flex-wrap gap-2">
            {providers.data?.items.map((p) => (
              <Button key={p.id} onClick={() => connect.mutate(p.id)} busy={connect.isPending && connect.variables === p.id}>
                Connect {p.label}
              </Button>
            ))}
            {providers.data?.items.length === 0 && <p className="text-xs text-ink-muted">No providers are configured for this deployment.</p>}
          </div>
        </Sheet>
      )}
      <Sheet>
        <div className="border-b border-rule px-4 py-3">
          <SectionHeader title="Connections" />
        </div>
        {conns.isLoading ? (
          <LoadingRows />
        ) : !conns.data?.items.length ? (
          <div className="p-4">
            <EmptyState title="Nothing connected" />
          </div>
        ) : (
          <ul>
            {conns.data.items.map((c) => (
              <li key={c.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-rule/70 px-4 py-3 last:border-0">
                <div>
                  <p className="font-medium">
                    {label(c.provider)} {c.account_label && c.account_label !== label(c.provider) ? <span className="font-normal text-ink-muted">({c.account_label})</span> : null}
                  </p>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-2xs text-ink-muted">
                    <Badge tone={c.status === 'active' ? 'verified' : c.status === 'expired' ? 'candidate' : 'neutral'}>{c.status === 'expired' ? 'Needs reconnecting' : c.status}</Badge>
                    <span>{c.imported_files} files imported</span>
                    {c.last_sync_at && <span>Last import {fmtRelative(c.last_sync_at)}</span>}
                    <span>Access: {c.scopes.join(', ')}</span>
                  </div>
                  {c.last_error && <p className="mt-1 text-2xs text-candidate">{c.last_error}</p>}
                </div>
                <div className="flex gap-2">
                  {c.status === 'active' && s.can('document:upload') && (
                    <Button size="sm" variant="primary" onClick={() => setImporting(c)}>
                      Import files
                    </Button>
                  )}
                  {c.status === 'expired' && s.can('admin:integrations') && (
                    <Button size="sm" onClick={() => connect.mutate(c.provider)}>
                      Reconnect
                    </Button>
                  )}
                  {c.status !== 'revoked' && s.can('admin:integrations') && (
                    <Button size="sm" variant="danger" onClick={() => confirm('Disconnect? Future imports stop; documents already imported stay in their cases.') && revoke.mutate(c.id)}>
                      Disconnect
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Sheet>
      {importing && <ImportDialog c={importing} onClose={() => setImporting(null)} />}
    </div>
  );
}
