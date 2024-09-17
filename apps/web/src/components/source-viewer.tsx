'use client';

import { useQuery } from '@tanstack/react-query';
import { Download, ExternalLink } from 'lucide-react';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { categoryLabel, fmtDate } from '@/lib/format';
import type { DocumentSummary, Page } from '@/lib/types';
import { Badge, Drawer, LoadingRows, Notice, SourcePage, type Highlight } from '@/ui';

export interface SourceTarget {
  documentId: string;
  versionId?: string | null;
  page?: number | null;
  start?: number | null;
  end?: number | null;
  /** Shown above the page so the reader knows why it opened. */
  label?: string;
  /** Plain-text excerpt to find when no character offsets are available. */
  quote?: string | null;
}

const SourceContext = createContext<(t: SourceTarget) => void>(() => undefined);
export const useSource = () => useContext(SourceContext);

function locate(pages: Page[], t: SourceTarget): { page: number; start: number; end: number } | null {
  if (t.page && t.start !== null && t.start !== undefined && t.end !== null && t.end !== undefined) return { page: t.page, start: t.start, end: t.end };
  if (t.quote) {
    const needle = t.quote.trim().slice(0, 120);
    for (const p of pages) {
      const i = p.text.indexOf(needle);
      if (i >= 0) return { page: p.page_no, start: i, end: i + needle.length };
    }
  }
  return null;
}

function SourceBody({ target }: { target: SourceTarget }) {
  const doc = useQuery({ queryKey: ['document', target.documentId], queryFn: () => api<DocumentSummary>(`/v1/documents/${target.documentId}`) });
  const pages = useQuery({
    queryKey: ['pages', target.documentId, target.versionId ?? 'current'],
    queryFn: () => api<{ version_id: string; pages: Page[] }>(`/v1/documents/${target.documentId}/pages`, { query: { version_id: target.versionId ?? undefined } }),
  });
  const hit = useMemo(() => (pages.data ? locate(pages.data.pages, target) : null), [pages.data, target]);
  if (pages.isLoading || doc.isLoading) return <LoadingRows rows={8} />;
  if (pages.error || !pages.data) {
    return (
      <div className="p-5">
        <Notice tone="conflict">This document is not available to you, or it was deleted.</Notice>
      </div>
    );
  }
  const d = doc.data;
  const notCurrent = d && pages.data.version_id !== d.current_version_id;
  return (
    <div className="flex flex-col gap-4 bg-paper p-5">
      {d && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <Badge>{categoryLabel(d.category)}</Badge>
            {d.evidence_date && <span className="text-ink-muted">Dated {fmtDate(d.evidence_date)}</span>}
            {notCurrent && <Badge tone="candidate">Older version</Badge>}
          </div>
          <div className="flex gap-3">
            <a className="inline-flex items-center gap-1 text-register hover:underline" href={`/api/v1/documents/${d.id}/content?disposition=inline`} target="_blank" rel="noreferrer">
              <ExternalLink className="size-3.5" /> Original
            </a>
            <a className="inline-flex items-center gap-1 text-register hover:underline" href={`/api/v1/documents/${d.id}/content`}>
              <Download className="size-3.5" /> Download
            </a>
          </div>
        </div>
      )}
      {target.label && <p className="text-xs text-ink-muted">{target.label}</p>}
      {target.quote && !hit && <Notice tone="candidate">The cited passage could not be located in this version of the document.</Notice>}
      {pages.data.pages.map((p) => {
        const highlights: Highlight[] = hit && hit.page === p.page_no ? [{ start: hit.start, end: hit.end, active: true }] : [];
        return <SourcePage key={p.page_no} pageNo={p.page_no} text={p.text} ocr={p.ocr} highlights={highlights} />;
      })}
    </div>
  );
}

/** Provides `useSource()` so any citation can open the document at the cited span. */
export function SourceViewerProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<SourceTarget | null>(null);
  const open = useCallback((t: SourceTarget) => setTarget(t), []);
  const title = useQuery({
    queryKey: ['document', target?.documentId],
    queryFn: () => api<DocumentSummary>(`/v1/documents/${target!.documentId}`),
    enabled: !!target,
  });
  return (
    <SourceContext.Provider value={open}>
      {children}
      <Drawer open={!!target} onClose={() => setTarget(null)} title={title.data?.title ?? 'Source document'}>
        {target && <SourceBody key={`${target.documentId}:${target.versionId}:${target.start}:${target.quote}`} target={target} />}
      </Drawer>
    </SourceContext.Provider>
  );
}
