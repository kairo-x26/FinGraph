'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CASE_TYPES, CASE_TYPE_LABELS, DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABELS, RISK_LEVELS } from '@fingraph/shared';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { fmtDate } from '@/lib/format';
import { Badge, Button, Checkbox, Dialog, Field, IconButton, Input, LoadingRows, Notice, SectionHeader, Select, Sheet, Table, Td, Textarea, Th, useToast } from '@/ui';

const FINDINGS: Record<string, string> = {
  undeclared_beneficial_owner: 'Undeclared beneficial owner',
  ownership_conflict: 'Conflicting ownership claims',
  ownership_exceeds_total: 'Ownership over 100%',
  identifier_mismatch: 'Identifier mismatch',
  name_mismatch: 'Name mismatch',
  missing_control_person: 'No control person',
  missing_evidence: 'Missing required document',
  expired_evidence: 'Out-of-date document',
  unreadable_pages: 'Unreadable pages',
};

interface Rules {
  ubo_threshold_pct: number;
  second_approval_for: string[];
  escalate_on: string[];
  block_approval_on: string[];
  require_critical_fact_review: boolean;
  require_verified_ownership: boolean;
  review_sla_days: number;
}

interface Policy {
  id: string;
  key: string;
  name: string;
  jurisdiction: string;
  version: number;
  case_types: string[];
  rules: Rules;
  notes: string | null;
  status: string;
  effective_from: string;
  created_by_name: string | null;
}

interface Template {
  id: string;
  case_type: string;
  version: number;
  items: { key: string; label: string; category: string; required: boolean; max_age_days?: number }[];
  notes: string | null;
  created_at: string;
}

function toggle(list: string[], v: string, on: boolean) {
  return on ? [...new Set([...list, v])] : list.filter((x) => x !== v);
}

function PolicyEditor({ policy, onClose }: { policy: Policy; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [r, setR] = useState<Rules>(policy.rules);
  const [notes, setNotes] = useState('');
  const publish = useMutation({
    mutationFn: () => api('/v1/policies', { body: { key: policy.key, name: policy.name, jurisdiction: policy.jurisdiction, case_types: policy.case_types, rules: r, notes } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['policies'] });
      toast({ tone: 'success', message: 'New policy version published' });
      onClose();
    },
  });
  return (
    <Dialog open onClose={onClose} title={`Edit ${policy.name}`} description="Publishing creates a new version. Cases opened earlier keep the version they started with." width="max-w-2xl">
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Beneficial ownership threshold (%)">
            {(id) => <Input id={id} type="number" min={1} max={100} value={r.ubo_threshold_pct} onChange={(e) => setR({ ...r, ubo_threshold_pct: Number(e.target.value) })} />}
          </Field>
          <Field label="Review target (days)">
            {(id) => <Input id={id} type="number" min={1} value={r.review_sla_days} onChange={(e) => setR({ ...r, review_sla_days: Number(e.target.value) })} />}
          </Field>
        </div>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-xs font-medium">Second approver required for</legend>
          <div className="flex gap-4">
            {RISK_LEVELS.map((l) => (
              <Checkbox key={l} label={`${l} risk`} checked={r.second_approval_for.includes(l)} onChange={(e) => setR({ ...r, second_approval_for: toggle(r.second_approval_for, l, e.target.checked) })} />
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium">Escalate to a risk manager when</legend>
            {Object.entries(FINDINGS).map(([k, label]) => (
              <Checkbox key={k} label={label} checked={r.escalate_on.includes(k)} onChange={(e) => setR({ ...r, escalate_on: toggle(r.escalate_on, k, e.target.checked) })} />
            ))}
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-medium">Block approval while open</legend>
            {Object.entries(FINDINGS).map(([k, label]) => (
              <Checkbox key={k} label={label} checked={r.block_approval_on.includes(k)} onChange={(e) => setR({ ...r, block_approval_on: toggle(r.block_approval_on, k, e.target.checked) })} />
            ))}
          </fieldset>
        </div>
        <Checkbox label="Critical fields must be reviewed before approval" checked={r.require_critical_fact_review} onChange={(e) => setR({ ...r, require_critical_fact_review: e.target.checked })} />
        <Checkbox label="Ownership of individuals must be verified before approval" checked={r.require_verified_ownership} onChange={(e) => setR({ ...r, require_verified_ownership: e.target.checked })} />
        <Field label="What changed and why">{(id) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        {publish.error && <Notice tone="conflict">{errorMessage(publish.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => publish.mutate()} busy={publish.isPending}>
            Publish version {policy.version + 1}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function TemplateEditor({ t, onClose }: { t: Template; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [items, setItems] = useState(t.items);
  const [notes, setNotes] = useState('');
  const publish = useMutation({
    mutationFn: () => api('/v1/checklist-templates', { body: { case_type: t.case_type, items, notes } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['templates'] });
      toast({ tone: 'success', message: 'Checklist published' });
      onClose();
    },
  });
  const set = (i: number, patch: Partial<Template['items'][number]>) => setItems(items.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Dialog open onClose={onClose} title={`Required documents for ${CASE_TYPE_LABELS[t.case_type as keyof typeof CASE_TYPE_LABELS]}`} description="New cases use the new version; open cases keep theirs." width="max-w-3xl">
      <div className="flex flex-col gap-3">
        {items.map((it, i) => (
          <div key={i} className="grid grid-cols-[1fr_1fr_6rem_auto_auto] items-end gap-2">
            <Field label="Label">{(id) => <Input id={id} value={it.label} onChange={(e) => set(i, { label: e.target.value, key: it.key || e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40) })} />}</Field>
            <Field label="Document type">
              {(id) => (
                <Select id={id} value={it.category} onChange={(e) => set(i, { category: e.target.value })}>
                  {DOCUMENT_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {DOCUMENT_CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Max age (days)">{(id) => <Input id={id} type="number" min={1} value={it.max_age_days ?? ''} onChange={(e) => set(i, { max_age_days: e.target.value ? Number(e.target.value) : undefined })} />}</Field>
            <div className="pb-2">
              <Checkbox label="Required" checked={it.required} onChange={(e) => set(i, { required: e.target.checked })} />
            </div>
            <IconButton label={`Remove ${it.label}`} onClick={() => setItems(items.filter((_, j) => j !== i))} className="mb-0.5">
              <Trash2 className="size-4" />
            </IconButton>
          </div>
        ))}
        <div>
          <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setItems([...items, { key: '', label: '', category: 'other', required: true }])}>
            Add document
          </Button>
        </div>
        <Field label="What changed and why">{(id) => <Textarea id={id} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />}</Field>
        {publish.error && <Notice tone="conflict">{errorMessage(publish.error)}</Notice>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => publish.mutate()} busy={publish.isPending} disabled={!items.length || items.some((x) => !x.key || !x.label)}>
            Publish version {t.version + 1}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function PoliciesAdmin() {
  const policies = useQuery({ queryKey: ['policies'], queryFn: () => api<{ items: Policy[] }>('/v1/policies') });
  const templates = useQuery({ queryKey: ['templates'], queryFn: () => api<{ items: Template[] }>('/v1/checklist-templates') });
  const [editPolicy, setEditPolicy] = useState<Policy | null>(null);
  const [editTemplate, setEditTemplate] = useState<Template | null>(null);
  const current = CASE_TYPES.map((ct) => templates.data?.items.find((t) => t.case_type === ct)).filter((t): t is Template => !!t);
  return (
    <div className="flex flex-col gap-5">
      <Notice tone="candidate">Policy rules encode your organization's procedures. Requirements depend on your regulators and risk assessment; have compliance and legal review changes.</Notice>
      <Sheet>
        <div className="border-b border-rule px-4 py-3">
          <SectionHeader title="Review policies" description="Control escalation, second approval and what blocks an approval." />
        </div>
        {policies.isLoading ? (
          <LoadingRows />
        ) : (
          <Table caption="Policies">
            <thead>
              <tr>
                <Th>Policy</Th>
                <Th>Version</Th>
                <Th>Applies to</Th>
                <Th>Since</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {policies.data?.items.map((p) => (
                <tr key={p.id}>
                  <Td>
                    <p className="font-medium">{p.name}</p>
                    {p.notes && <p className="text-2xs text-ink-muted">{p.notes}</p>}
                  </Td>
                  <Td>
                    v{p.version} {p.status === 'active' ? <Badge tone="verified">Active</Badge> : <Badge>Retired</Badge>}
                  </Td>
                  <Td className="text-xs">{p.case_types.map((c) => CASE_TYPE_LABELS[c as keyof typeof CASE_TYPE_LABELS]).join(', ')}</Td>
                  <Td className="text-xs text-ink-muted">
                    {fmtDate(p.effective_from)}
                    {p.created_by_name ? `, ${p.created_by_name}` : ''}
                  </Td>
                  <Td className="text-right">
                    {p.status === 'active' && (
                      <Button size="sm" onClick={() => setEditPolicy(p)}>
                        Edit rules
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
          <SectionHeader title="Required documents by case type" />
        </div>
        <ul>
          {current.map((t) => (
            <li key={t.id} className="flex flex-wrap items-start justify-between gap-3 border-b border-rule/70 px-4 py-3 last:border-0">
              <div>
                <p className="font-medium">
                  {CASE_TYPE_LABELS[t.case_type as keyof typeof CASE_TYPE_LABELS]} <span className="text-2xs font-normal text-ink-muted">version {t.version}</span>
                </p>
                <p className="mt-0.5 text-xs text-ink-muted">{t.items.map((i) => `${i.label}${i.required ? '' : ' (optional)'}`).join(', ')}</p>
              </div>
              <Button size="sm" onClick={() => setEditTemplate(t)}>
                Edit
              </Button>
            </li>
          ))}
        </ul>
      </Sheet>
      {editPolicy && <PolicyEditor policy={editPolicy} onClose={() => setEditPolicy(null)} />}
      {editTemplate && <TemplateEditor t={editTemplate} onClose={() => setEditTemplate(null)} />}
    </div>
  );
}
