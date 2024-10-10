'use client';

import { useQuery } from '@tanstack/react-query';
import { DOCUMENT_CATEGORIES, DOCUMENT_CATEGORY_LABELS } from '@fingraph/shared';
import { Check, Lock, RotateCw, ShieldAlert, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, errorMessage, uploadFile } from '@/lib/api';
import { cn } from '@/lib/cn';
import { categoryLabel, factStatus, fmtBytes, fmtDate, pct, versionStatus } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { CaseSummary, DocumentSummary, Fact, Page } from '@/lib/types';
import { Badge, Button, EmptyState, Field, IconButton, Input, LoadingRows, Notice, Select, SourcePage, Textarea, useToast, type Highlight } from '@/ui';
import { useCaseMutation, useDocuments, useFacts } from './hooks';

const GROUP_LABELS: Record<string, string> = { beneficial_owner: 'Beneficial owner', director: 'Director or officer', ownership_edge: 'Ownership interest' };

function Dropzone({ c, onUploaded }: { c: CaseSummary; onUploaded: (docId: string) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState<string[]>([]);
  const upload = useCaseMutation(c.id, async (files: File[]) => {
    for (const f of files) {
      setBusy((b) => [...b, f.name]);
      try {
        const r = await uploadFile(c.id, f);
        if (r.duplicate) toast({ tone: 'info', message: `${f.name} is already in this case.` });
        onUploaded(r.document_id);
      } catch (err) {
        toast({ tone: 'error', message: `${f.name}: ${errorMessage(err)}` });
      } finally {
        setBusy((b) => b.filter((n) => n !== f.name));
      }
    }
  });
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    const files = [...e.dataTransfer.files];
    if (files.length) upload.mutate(files);
  };
  return (
    <div
      onDragOver={(e) => (e.preventDefault(), setOver(true))}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
      className={cn(
        'flex flex-col items-start gap-1.5 rounded-[var(--radius-control)] border border-dashed px-3 py-3 text-xs',
        over ? 'border-register bg-register-soft' : 'border-rule-strong',
      )}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="text-ink-muted">Drop PDFs, images, Word or text files here</span>
        <Button size="sm" icon={<Upload className="size-3.5" />} onClick={() => input.current?.click()} busy={busy.length > 0}>
          Upload
        </Button>
      </div>
      {busy.length > 0 && <p className="text-2xs text-register">Uploading {busy.join(', ')}</p>}
      <input
        ref={input}
        type="file"
        multiple
        hidden
        accept=".pdf,.png,.jpg,.jpeg,.docx,.txt,.csv"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) upload.mutate(files);
          e.target.value = '';
        }}
      />
    </div>
  );
}

function DocumentRow({ d, selected, onSelect, factCount }: { d: DocumentSummary; selected: boolean; onSelect: () => void; factCount: { pending: number; total: number } }) {
  const st = versionStatus(d.latest_status);
  return (
    <li>
      <button
        onClick={onSelect}
        aria-current={selected ? 'true' : undefined}
        className={cn('flex w-full items-start gap-2 border-b border-rule/70 px-3 py-2.5 text-left hover:bg-sheet-sunk', selected && 'bg-register-soft/60 shadow-[inset_3px_0_0_var(--register)]')}
      >
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm font-medium">
            {d.restricted && <Lock className="size-3 shrink-0 text-ink-muted" aria-label="Restricted" />}
            <span className="truncate">{d.title}</span>
          </p>
          <p className="truncate text-2xs text-ink-muted">
            {categoryLabel(d.category)}
            {d.evidence_date ? `, dated ${fmtDate(d.evidence_date)}` : ''}
            {d.latest_version_no > 1 ? `, version ${d.latest_version_no}` : ''}
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {d.latest_status !== 'processed' ? (
            <Badge tone={st.tone}>{st.label}</Badge>
          ) : factCount.pending > 0 ? (
            <Badge tone="candidate" dashed>
              {factCount.pending} to review
            </Badge>
          ) : factCount.total > 0 ? (
            <Badge tone="verified">Reviewed</Badge>
          ) : null}
        </div>
      </button>
    </li>
  );
}

function FactRow({ caseId, f, active, onSelect, readOnly }: { caseId: string; f: Fact; active: boolean; onSelect: () => void; readOnly: boolean }) {
  const [mode, setMode] = useState<'idle' | 'correct' | 'reject'>('idle');
  const [value, setValue] = useState(f.value_text ?? '');
  const [comment, setComment] = useState('');
  const review = useCaseMutation(caseId, (body: Record<string, string>) => api(`/v1/extracted-facts/${f.id}/reviews`, { body }));
  const s = factStatus(f.status);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    review.mutate(mode === 'correct' ? { action: 'correct', value, comment } : { action: 'reject', comment }, { onSuccess: () => setMode('idle') });
  };
  return (
    <li className={cn('border-b border-rule/70', active && 'bg-marker-soft/50')}>
      <div className="flex items-start gap-2 px-3 py-2">
        <button onClick={onSelect} className="min-w-0 flex-1 text-left">
          <p className="text-2xs text-ink-muted">
            {f.field_label}
            {f.critical && <span className="ml-1 text-candidate">(critical)</span>}
          </p>
          <p className={cn('text-sm font-medium break-words', f.status === 'rejected' && 'text-ink-muted line-through')}>{f.value_text ?? String(f.value)}</p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-ink-muted">
            <Badge tone={s.tone} dashed={f.status === 'candidate'}>
              {s.label}
            </Badge>
            {f.status === 'candidate' && <span>Confidence {pct(f.confidence)}</span>}
            {f.reviewed_by_name && <span>by {f.reviewed_by_name}</span>}
            {f.evidence_page && <span>Page {f.evidence_page}</span>}
          </p>
        </button>
        {!readOnly && f.status === 'candidate' && mode === 'idle' && (
          <div className="flex shrink-0 gap-0.5">
            <IconButton label={`Approve ${f.field_label}`} onClick={() => review.mutate({ action: 'approve' })} className="text-verified">
              <Check className="size-4" />
            </IconButton>
            <IconButton label={`Correct ${f.field_label}`} onClick={() => setMode('correct')}>
              <span className="text-2xs font-semibold">Edit</span>
            </IconButton>
            <IconButton label={`Reject ${f.field_label}`} onClick={() => setMode('reject')} className="text-conflict">
              <X className="size-4" />
            </IconButton>
          </div>
        )}
      </div>
      {mode !== 'idle' && (
        <form onSubmit={submit} className="flex flex-col gap-2 px-3 pb-3">
          {mode === 'correct' && (
            <Field label="Corrected value">
              {(id) => <Input id={id} value={value} onChange={(e) => setValue(e.target.value)} required autoFocus />}
            </Field>
          )}
          <Field label={mode === 'correct' ? 'Why is it different?' : 'Why reject it?'}>
            {(id) => <Textarea id={id} rows={2} value={comment} onChange={(e) => setComment(e.target.value)} required minLength={3} autoFocus={mode === 'reject'} />}
          </Field>
          {review.error && <Notice tone="conflict">{errorMessage(review.error)}</Notice>}
          <div className="flex gap-2">
            <Button size="sm" type="submit" variant={mode === 'reject' ? 'danger' : 'primary'} busy={review.isPending}>
              {mode === 'correct' ? 'Save correction' : 'Reject value'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode('idle')}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </li>
  );
}

function DocumentPanel({ c, d, facts }: { c: CaseSummary; d: DocumentSummary; facts: Fact[] }) {
  const s = useSession();
  const toast = useToast();
  const [active, setActive] = useState<string | null>(null);
  const pages = useQuery({
    queryKey: ['pages', d.id, d.current_version_id],
    queryFn: () => api<{ pages: Page[] }>(`/v1/documents/${d.id}/pages`),
    enabled: d.status === 'processed',
  });
  const reprocess = useCaseMutation(c.id, () => api(`/v1/documents/${d.id}/reprocess`, { method: 'POST' }), 'Processing again');
  const reclassify = useCaseMutation(c.id, (category: string) => api(`/v1/documents/${d.id}`, { method: 'PATCH', body: { category } }), 'Category updated');
  const replaceInput = useRef<HTMLInputElement>(null);
  const replace = useCaseMutation(
    c.id,
    (file: File) => uploadFile(c.id, file, { replaces_document_id: d.id, replaced_reason: 'New version uploaded by reviewer' }),
    'New version uploaded',
  );
  const readOnly = !s.can('fact:review') || !!c.closed_at;
  const grouped = useMemo(() => {
    const single = facts.filter((f) => !f.group_key);
    const groups = new Map<string, Fact[]>();
    for (const f of facts.filter((x) => x.group_key)) groups.set(f.group_key!, [...(groups.get(f.group_key!) ?? []), f]);
    return { single, groups: [...groups.entries()] };
  }, [facts]);

  const highlights = (pageNo: number): Highlight[] =>
    facts
      .filter((f) => f.evidence_page === pageNo && f.evidence_start !== null && f.status !== 'rejected')
      .map((f) => ({ start: f.evidence_start!, end: f.evidence_end!, active: f.id === active, label: f.field_label }));

  const quarantined = d.latest_status === 'quarantined';
  const failed = d.latest_status === 'failed' || d.latest_status === 'rejected';

  return (
    <div className="grid min-h-[60vh] gap-4 xl:grid-cols-[minmax(320px,400px)_minmax(0,1fr)]">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-ink-muted">
            {d.filename}, {fmtBytes(d.size_bytes)}
            {d.page_count ? `, ${d.page_count} page${d.page_count > 1 ? 's' : ''}` : ''}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {s.can('document:upload') && !c.closed_at && (
            <>
              <Select
                aria-label="Document category"
                value={d.category ?? 'other'}
                onChange={(e) => reclassify.mutate(e.target.value)}
                className="h-7 w-auto text-xs"
              >
                {DOCUMENT_CATEGORIES.map((k) => (
                  <option key={k} value={k}>
                    {DOCUMENT_CATEGORY_LABELS[k]}
                  </option>
                ))}
              </Select>
              <Button size="sm" icon={<RotateCw className="size-3.5" />} onClick={() => reprocess.mutate(undefined)} busy={reprocess.isPending}>
                Process again
              </Button>
              <Button size="sm" onClick={() => replaceInput.current?.click()} busy={replace.isPending}>
                Upload new version
              </Button>
              <input
                ref={replaceInput}
                type="file"
                hidden
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) replace.mutate(f, { onError: (err) => toast({ tone: 'error', message: errorMessage(err) }) });
                  e.target.value = '';
                }}
              />
            </>
          )}
        </div>
        {d.category_source !== 'user' && d.category_confidence !== null && d.category_confidence < 0.7 && (
          <Notice tone="candidate">The document type was uncertain ({pct(d.category_confidence)}). Check the category above.</Notice>
        )}
        {d.scan_result?.warnings?.length ? <Notice tone="candidate">Scanner warnings: {d.scan_result.warnings.join(', ').replace(/_/g, ' ')}</Notice> : null}
        {facts.length === 0 ? (
          <EmptyState title={d.status === 'processed' ? 'No fields were extracted' : 'Waiting for processing'}>
            {d.status === 'processed' ? 'This document type has no extraction schema, or the text could not be read.' : 'Fields appear here once processing finishes.'}
          </EmptyState>
        ) : (
          <ul className="overflow-hidden rounded-[var(--radius-sheet)] border border-rule bg-sheet">
            {grouped.single.map((f) => (
              <FactRow key={f.id} caseId={c.id} f={f} active={active === f.id} onSelect={() => setActive(f.id)} readOnly={readOnly} />
            ))}
            {grouped.groups.map(([g, items]) => (
              <li key={g}>
                <p className="border-b border-rule bg-sheet-sunk px-3 py-1.5 text-2xs font-semibold text-ink-muted">
                  {GROUP_LABELS[g.split(':')[0]!] ?? 'Group'} {g.split(':')[1]}
                </p>
                <ul>
                  {items.map((f) => (
                    <FactRow key={f.id} caseId={c.id} f={f} active={active === f.id} onSelect={() => setActive(f.id)} readOnly={readOnly} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="min-w-0 xl:sticky xl:top-16 xl:self-start">
        {quarantined ? (
          <Notice tone="conflict" title="Quarantined">
            <span className="flex items-center gap-1.5">
              <ShieldAlert className="size-4" /> The malware scanner flagged this file ({d.scan_result?.threats.join(', ')}). It cannot be opened or downloaded.
            </span>
          </Notice>
        ) : failed ? (
          <Notice tone="conflict" title="Processing failed">
            {d.error?.type === 'unsupported_or_mismatched_type' ? 'The file type is not supported.' : (d.error?.message ?? 'The document could not be processed.')}
          </Notice>
        ) : pages.isLoading || d.status !== 'processed' ? (
          <LoadingRows rows={10} />
        ) : (
          <div data-scroll-panel className="flex max-h-[calc(100vh-90px)] flex-col gap-4 overflow-y-auto pr-1">
            {pages.data?.pages.map((p) => (
              <SourcePage key={p.page_no} pageNo={p.page_no} text={p.text} ocr={p.ocr} highlights={highlights(p.page_no)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function Evidence({ c, initialDocument }: { c: CaseSummary; initialDocument?: string | null }) {
  const s = useSession();
  const docs = useDocuments(c.id);
  const facts = useFacts(c.id);
  const [selected, setSelected] = useState<string | null>(initialDocument ?? null);
  useEffect(() => {
    if (!selected && docs.data?.length) setSelected(docs.data[0]!.id);
  }, [docs.data, selected]);
  const factsByDoc = useMemo(() => {
    const m = new Map<string, Fact[]>();
    for (const f of facts.data?.items ?? []) m.set(f.document_id, [...(m.get(f.document_id) ?? []), f]);
    return m;
  }, [facts.data]);
  const current = docs.data?.find((d) => d.id === selected);

  return (
    <div className="grid gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <aside className="flex flex-col gap-3">
        {s.can('document:upload') && !c.closed_at && <Dropzone c={c} onUploaded={(id) => setSelected((cur) => cur ?? id)} />}
        <div className="overflow-hidden rounded-[var(--radius-sheet)] border border-rule bg-sheet">
          {docs.isLoading ? (
            <LoadingRows />
          ) : docs.data?.length ? (
            <ul aria-label="Documents">
              {docs.data.map((d) => {
                const f = factsByDoc.get(d.id) ?? [];
                return (
                  <DocumentRow
                    key={d.id}
                    d={d}
                    selected={d.id === selected}
                    onSelect={() => setSelected(d.id)}
                    factCount={{ pending: f.filter((x) => x.status === 'candidate').length, total: f.length }}
                  />
                );
              })}
            </ul>
          ) : (
            <div className="p-3">
              <EmptyState title="No documents yet">Upload the customer's documents to start.</EmptyState>
            </div>
          )}
        </div>
      </aside>
      <section aria-label="Document review" className="min-w-0">
        {current ? <DocumentPanel key={current.id + current.current_version_id + current.latest_status} c={c} d={current} facts={factsByDoc.get(current.id) ?? []} /> : null}
      </section>
    </div>
  );
}
