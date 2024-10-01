'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { useSession } from '@/lib/session';
import { Badge, Button, EmptyState, Input, LoadingRows, SectionHeader, Sheet, Table, Td, Th, useToast } from '@/ui';

interface EntityHit {
  id: string;
  kind: string;
  display_name: string;
  jurisdiction: string | null;
  identifiers: Record<string, string>;
  case_count: number;
}

interface Duplicate {
  id: string;
  entity_a: string;
  entity_b: string;
  a_name: string;
  b_name: string;
  a_attributes: Record<string, unknown>;
  b_attributes: Record<string, unknown>;
  score: number;
  reasons: string[];
}

export default function EntitiesPage() {
  const s = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const results = useQuery({ queryKey: ['entities', q], queryFn: () => api<{ items: EntityHit[] }>('/v1/entities', { query: { q } }), enabled: q.trim().length >= 2 });
  const dups = useQuery({ queryKey: ['entity-duplicates'], queryFn: () => api<{ items: Duplicate[] }>('/v1/entities/duplicates') });
  const resolve = useMutation({
    mutationFn: ({ id, action, keep }: { id: string; action: 'merge' | 'dismiss'; keep?: string }) => api(`/v1/entities/duplicates/${id}/resolve`, { body: { action, keep } }),
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ['entity-duplicates'] });
      toast({ tone: 'success', message: v.action === 'merge' ? 'Entities merged' : 'Suggestion dismissed' });
    },
    onError: (err) => toast({ tone: 'error', message: errorMessage(err) }),
  });
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <h1 className="text-xl font-semibold tracking-tight">Entities</h1>
      <div className="flex flex-col gap-3">
        <Input aria-label="Find a person or company" placeholder="Find a person or company" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-md" />
        {q.trim().length >= 2 && (
          <Sheet>
            {results.isLoading ? (
              <LoadingRows />
            ) : !results.data?.items.length ? (
              <div className="p-4 text-xs text-ink-muted">No people or companies match.</div>
            ) : (
              <Table caption="Entities">
                <thead>
                  <tr>
                    <Th>Name</Th>
                    <Th>Type</Th>
                    <Th>Identifiers</Th>
                    <Th numeric>Cases</Th>
                  </tr>
                </thead>
                <tbody>
                  {results.data.items.map((e) => (
                    <tr key={e.id}>
                      <Td>
                        <Link href={`/entities/${e.id}`} className="font-medium text-register hover:underline">
                          {e.display_name}
                        </Link>
                      </Td>
                      <Td className="text-xs">{e.kind}</Td>
                      <Td className="text-xs text-ink-muted">
                        {Object.entries(e.identifiers)
                          .map(([k, v]) => `${k.replace('_', ' ')} ${v}`)
                          .join(', ')}
                      </Td>
                      <Td numeric>{e.case_count}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Sheet>
        )}
      </div>

      <section className="flex flex-col gap-3">
        <SectionHeader title="Possible duplicates" description="Names that are close but not identical are never merged automatically. Decide whether they are the same." />
        <Sheet>
          {dups.isLoading ? (
            <LoadingRows />
          ) : !dups.data?.items.length ? (
            <div className="p-4">
              <EmptyState title="Nothing to resolve" />
            </div>
          ) : (
            <ul>
              {dups.data.items.map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 border-b border-rule/70 px-4 py-3 last:border-0">
                  <div className="text-sm">
                    <Link className="font-medium text-register hover:underline" href={`/entities/${d.entity_a}`}>
                      {d.a_name}
                    </Link>{' '}
                    and{' '}
                    <Link className="font-medium text-register hover:underline" href={`/entities/${d.entity_b}`}>
                      {d.b_name}
                    </Link>
                    <div className="mt-0.5 flex gap-2">
                      <Badge tone="candidate">{Math.round(Number(d.score) * 100)}% similar</Badge>
                      {d.reasons.includes('same_name_conflicting_attributes') && <Badge tone="conflict">Same name, different details</Badge>}
                    </div>
                  </div>
                  {s.can('graph:edit') && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => resolve.mutate({ id: d.id, action: 'merge', keep: d.entity_a })}>
                        Merge into {d.a_name}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: d.id, action: 'dismiss' })}>
                        Not the same
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Sheet>
      </section>
    </div>
  );
}
