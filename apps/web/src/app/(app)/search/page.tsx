'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type FormEvent, type ReactNode } from 'react';
import { useSource } from '@/components/source-viewer';
import { api, errorMessage } from '@/lib/api';
import { categoryLabel } from '@/lib/format';
import { Button, EmptyState, Input, LoadingRows, Notice, Select, Sheet } from '@/ui';

interface Hit {
  chunk_id: string;
  case_id: string;
  case_reference: string;
  document_id: string;
  document_title: string;
  document_category: string | null;
  version_id: string;
  page_no: number;
  char_start: number;
  char_end: number;
  text: string;
  highlight: string | null;
  keyword_rank: number | null;
  vector_rank: number | null;
}

/** ts_headline marks matches with << >>; render them as evidence marks, never as HTML. */
function Highlighted({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  const re = /<<(.*?)>>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    parts.push(
      <mark key={m.index} className="evidence">
        {m[1]}
      </mark>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <>{parts}</>;
}

function SearchResults() {
  const params = useSearchParams();
  const router = useRouter();
  const open = useSource();
  const q = params.get('q') ?? '';
  const mode = params.get('mode') ?? 'hybrid';
  const [input, setInput] = useState(q);
  const results = useQuery({
    queryKey: ['search', q, mode],
    queryFn: () => api<{ items: Hit[] }>('/v1/search', { query: { q, mode, limit: 30 } }),
    enabled: q.length >= 2,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    router.push(`/search?q=${encodeURIComponent(input.trim())}&mode=${mode}`);
  };
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Search</h1>
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <Input aria-label="Search terms" value={input} onChange={(e) => setInput(e.target.value)} placeholder="Names, identifiers, phrases" className="max-w-md flex-1" autoFocus />
        <Select aria-label="Search mode" value={mode} onChange={(e) => router.push(`/search?q=${encodeURIComponent(q)}&mode=${e.target.value}`)} className="w-48">
          <option value="hybrid">Words and meaning</option>
          <option value="keyword">Exact words</option>
          <option value="semantic">Meaning only</option>
        </Select>
        <Button type="submit" variant="primary">
          Search
        </Button>
      </form>
      <p className="text-xs text-ink-muted">Searches every case and document you have access to.</p>
      {q.length < 2 ? null : results.isLoading ? (
        <LoadingRows />
      ) : results.error ? (
        <Notice tone="conflict">{errorMessage(results.error)}</Notice>
      ) : !results.data?.items.length ? (
        <EmptyState title={`Nothing found for "${q}"`}>Try other words, or switch to meaning-based search.</EmptyState>
      ) : (
        <Sheet as="div">
          <ol>
            {results.data.items.map((h) => (
              <li key={h.chunk_id} className="border-b border-rule/70 px-4 py-3 last:border-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <button
                    className="text-left text-sm font-medium text-register hover:underline"
                    onClick={() => open({ documentId: h.document_id, versionId: h.version_id, page: h.page_no, start: h.char_start, end: h.char_end })}
                  >
                    {h.document_title}, page {h.page_no}
                  </button>
                  <Link href={`/cases/${h.case_id}`} className="text-2xs text-ink-muted tabular-nums hover:text-ink">
                    {h.case_reference}
                  </Link>
                </div>
                <p className="text-2xs text-ink-muted">{categoryLabel(h.document_category)}</p>
                <p className="source-text mt-1.5 line-clamp-4 text-[0.875rem]">
                  {h.highlight ? <Highlighted text={h.highlight} /> : h.text.slice(0, 320)}
                </p>
              </li>
            ))}
          </ol>
        </Sheet>
      )}
    </div>
  );
}

export default function SearchPage() {
  return (
    <Suspense fallback={<LoadingRows />}>
      <SearchResults />
    </Suspense>
  );
}
