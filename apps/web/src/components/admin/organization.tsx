'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button, Checkbox, Field, Input, LoadingRows, Notice, SectionHeader, Sheet, Textarea, useToast } from '@/ui';

interface Tenant {
  id: string;
  slug: string;
  name: string;
  settings: {
    require_mfa: boolean;
    session_idle_minutes?: number;
    session_absolute_hours?: number;
    allowed_email_domains: string[];
    ip_allowlist: string[];
    default_retention_days: number;
    exports_require_approval: boolean;
    quotas: { documents_per_day: number; storage_bytes: number; ai_tokens_per_day: number; ocr_pages_per_day: number };
  };
  sso: { issuer: string | null; client_id: string | null; custom: boolean };
}

const lines = (s: string) =>
  s
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function OrganizationAdmin() {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['tenant'], queryFn: () => api<Tenant>('/v1/tenant') });
  const [f, setF] = useState<null | {
    require_mfa: boolean;
    idle: string;
    absolute: string;
    domains: string;
    ips: string;
    retention: string;
    exportsApproval: boolean;
    docs: string;
    tokens: string;
    ocr: string;
    storageGb: string;
  }>(null);
  const [sso, setSso] = useState({ issuer: '', client_id: '', client_secret: '' });
  useEffect(() => {
    if (!q.data || f) return;
    const st = q.data.settings;
    setF({
      require_mfa: st.require_mfa,
      idle: String(st.session_idle_minutes ?? ''),
      absolute: String(st.session_absolute_hours ?? ''),
      domains: st.allowed_email_domains.join('\n'),
      ips: st.ip_allowlist.join('\n'),
      retention: String(st.default_retention_days),
      exportsApproval: st.exports_require_approval,
      docs: String(st.quotas.documents_per_day),
      tokens: String(st.quotas.ai_tokens_per_day),
      ocr: String(st.quotas.ocr_pages_per_day),
      storageGb: String(Math.round(st.quotas.storage_bytes / 1024 ** 3)),
    });
    setSso({ issuer: q.data.sso.issuer ?? '', client_id: q.data.sso.client_id ?? '', client_secret: '' });
  }, [q.data, f]);

  const save = useMutation({
    mutationFn: () =>
      api('/v1/tenant/settings', {
        method: 'PATCH',
        body: {
          require_mfa: f!.require_mfa,
          ...(f!.idle ? { session_idle_minutes: Number(f!.idle) } : {}),
          ...(f!.absolute ? { session_absolute_hours: Number(f!.absolute) } : {}),
          allowed_email_domains: lines(f!.domains),
          ip_allowlist: lines(f!.ips),
          default_retention_days: Number(f!.retention),
          exports_require_approval: f!.exportsApproval,
          quotas: { documents_per_day: Number(f!.docs), ai_tokens_per_day: Number(f!.tokens), ocr_pages_per_day: Number(f!.ocr), storage_bytes: Number(f!.storageGb) * 1024 ** 3 },
        },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant'] });
      toast({ tone: 'success', message: 'Settings saved' });
    },
  });
  const saveSso = useMutation({
    mutationFn: (clear: boolean) => api('/v1/tenant/sso', { method: 'PUT', body: clear ? { issuer: null } : sso }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['tenant'] });
      toast({ tone: 'success', message: 'Single sign-on updated' });
    },
    onError: (e) => toast({ tone: 'error', message: errorMessage(e) }),
  });
  if (q.isLoading || !f) return <LoadingRows rows={8} />;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };
  const num = (k: keyof typeof f) => ({ value: String(f[k]), onChange: (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value }), type: 'number', min: 1 });
  return (
    <div className="flex flex-col gap-5">
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Sheet className="flex flex-col gap-4 p-4">
          <SectionHeader title="Sign-in and sessions" description={`Organization short name: ${q.data!.slug}`} />
          <Checkbox
            label="Require multi-factor authentication"
            hint="People whose identity provider does not report a second factor cannot sign in."
            checked={f.require_mfa}
            onChange={(e) => setF({ ...f, require_mfa: e.target.checked })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sign out after inactivity (minutes)" hint="Default 30">
              {(id, d) => <Input id={id} aria-describedby={d} {...num('idle')} placeholder="30" />}
            </Field>
            <Field label="Maximum session length (hours)" hint="Default 12">
              {(id, d) => <Input id={id} aria-describedby={d} {...num('absolute')} placeholder="12" />}
            </Field>
            <Field label="Allowed email domains" hint="One per line. Leave empty to allow any domain.">
              {(id, d) => <Textarea id={id} aria-describedby={d} rows={3} value={f.domains} onChange={(e) => setF({ ...f, domains: e.target.value })} />}
            </Field>
            <Field label="Allowed networks" hint="IP ranges in CIDR form, one per line. Leave empty to allow any network.">
              {(id, d) => <Textarea id={id} aria-describedby={d} rows={3} value={f.ips} onChange={(e) => setF({ ...f, ips: e.target.value })} placeholder="203.0.113.0/24" />}
            </Field>
          </div>
        </Sheet>
        <Sheet className="flex flex-col gap-4 p-4">
          <SectionHeader title="Evidence governance" />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Keep closed cases for (days)" hint="Then documents and derived data are deleted, unless a legal hold applies.">
              {(id, d) => <Input id={id} aria-describedby={d} {...num('retention')} min={30} />}
            </Field>
            <div className="pt-5">
              <Checkbox
                label="Evidence exports need approval"
                hint="A second person with approval rights must release each export."
                checked={f.exportsApproval}
                onChange={(e) => setF({ ...f, exportsApproval: e.target.checked })}
              />
            </div>
          </div>
        </Sheet>
        <Sheet className="flex flex-col gap-4 p-4">
          <SectionHeader title="Daily limits" description="Protect costs and keep one workload from crowding out others." />
          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Documents per day">{(id) => <Input id={id} {...num('docs')} />}</Field>
            <Field label="AI tokens per day">{(id) => <Input id={id} {...num('tokens')} />}</Field>
            <Field label="OCR pages per day">{(id) => <Input id={id} {...num('ocr')} />}</Field>
            <Field label="Storage (GB)">{(id) => <Input id={id} {...num('storageGb')} />}</Field>
          </div>
        </Sheet>
        {save.error && <Notice tone="conflict">{errorMessage(save.error)}</Notice>}
        <div>
          <Button type="submit" variant="primary" busy={save.isPending}>
            Save settings
          </Button>
        </div>
      </form>

      <Sheet className="flex flex-col gap-4 p-4">
        <SectionHeader
          title="Your identity provider"
          description={q.data!.sso.custom ? 'People sign in through your own OpenID Connect provider.' : 'People sign in through the platform default provider. Connect your own to use your MFA and lifecycle policies.'}
        />
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Issuer URL">{(id) => <Input id={id} value={sso.issuer} onChange={(e) => setSso({ ...sso, issuer: e.target.value })} placeholder="https://login.example.com" />}</Field>
          <Field label="Client ID">{(id) => <Input id={id} value={sso.client_id} onChange={(e) => setSso({ ...sso, client_id: e.target.value })} />}</Field>
          <Field label="Client secret" hint="Stored encrypted. Leave empty to keep the current one.">
            {(id, d) => <Input id={id} aria-describedby={d} type="password" value={sso.client_secret} onChange={(e) => setSso({ ...sso, client_secret: e.target.value })} />}
          </Field>
        </div>
        <p className="text-2xs text-ink-muted">Redirect URI to register with your provider: {typeof window === 'undefined' ? '' : `${window.location.origin}/api/v1/auth/callback`}</p>
        <div className="flex gap-2">
          <Button onClick={() => saveSso.mutate(false)} disabled={!sso.issuer || !sso.client_id || !sso.client_secret} busy={saveSso.isPending}>
            Save provider
          </Button>
          {q.data!.sso.custom && (
            <Button variant="ghost" onClick={() => saveSso.mutate(true)}>
              Use platform default
            </Button>
          )}
        </div>
      </Sheet>
    </div>
  );
}
