'use client';

import { cn as clsx } from '@/lib/cn';
import { FileText } from 'lucide-react';
import { useEffect, useMemo, useRef, type ReactNode } from 'react';

export interface Highlight {
  start: number;
  end: number;
  /** The highlight the user selected; it is scrolled into view. */
  active?: boolean;
  label?: string;
}

/**
 * One page of extracted document text in the document's own voice (serif), with
 * cited spans marked. Offsets are character positions in `text`.
 */
export function SourcePage({ text, highlights = [], pageNo, ocr }: { text: string; highlights?: Highlight[]; pageNo: number; ocr?: boolean }) {
  const activeRef = useRef<HTMLElement>(null);
  const segments = useMemo(() => {
    const spans = [...highlights].filter((h) => h.end > h.start).sort((a, b) => a.start - b.start);
    const out: { text: string; h?: Highlight }[] = [];
    let cursor = 0;
    for (const h of spans) {
      const start = Math.max(h.start, cursor);
      if (start >= h.end) continue;
      if (start > cursor) out.push({ text: text.slice(cursor, start) });
      out.push({ text: text.slice(start, h.end), h });
      cursor = h.end;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor) });
    return out;
  }, [text, highlights]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [highlights]);

  return (
    <article aria-label={`Page ${pageNo}`} className="relative rounded-[var(--radius-sheet)] border border-rule bg-sheet px-7 py-6 shadow-[var(--shadow-sheet)]">
      <span className="absolute top-2 right-3 text-2xs text-ink-faint tabular-nums">
        Page {pageNo}
        {ocr ? ' (OCR)' : ''}
      </span>
      <div className="source-text max-w-[72ch]">
        {segments.map((s, i) =>
          s.h ? (
            <mark key={i} ref={s.h.active ? activeRef : undefined} className="evidence" data-active={s.h.active ? 'true' : undefined} title={s.h.label}>
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
        {!text.trim() && <span className="font-sans text-xs text-ink-muted">No text could be read from this page.</span>}
      </div>
    </article>
  );
}

/** A short quotation from a document, with its source line. */
export function EvidenceQuote({ quote, source, onOpen, className }: { quote: string; source: ReactNode; onOpen?: () => void; className?: string }) {
  return (
    <figure className={clsx('border-l-2 border-marker pl-3', className)}>
      <blockquote className="source-text text-[0.875rem] text-ink">
        <mark className="evidence">{quote.trim()}</mark>
      </blockquote>
      <figcaption className="mt-1 flex items-center gap-1 text-2xs text-ink-muted">
        <FileText className="size-3" aria-hidden />
        {onOpen ? (
          <button type="button" onClick={onOpen} className="underline decoration-rule-strong underline-offset-2 hover:text-register">
            {source}
          </button>
        ) : (
          source
        )}
      </figcaption>
    </figure>
  );
}

/** Inline citation marker that opens the cited source. */
export function CitationChip({ label, onClick, title }: { label: string; onClick?: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="mx-0.5 inline-flex h-4.5 items-center rounded-sm border border-marker bg-marker-soft px-1 align-[1px] text-[10px] font-semibold text-ink tabular-nums hover:bg-marker"
    >
      {label}
    </button>
  );
}
