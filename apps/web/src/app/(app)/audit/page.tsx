'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { ShieldCheck, ShieldX } from 'lucide-react';
import { Fragment, useState } from 'react';
import { describeAction } from '@/components/case/records';
import { api } from '@/lib/api';
import { fmtDateTime } from '@/lib/format';
import { Button, Input, LoadingRows, Notice, Sheet, Table, Td, Th } from '@/ui';

interface AuditEvent {
  id: string;
  seq: number;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  actor_name: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  correlation_id: string | null;
  ip: string | null;
  details: Record<string, unknown>;
  hash: string;
}

export default function AuditPage() {
  const [action, setAction] = useState('');
  const [resource, setResource] = useState('');
  const verify = useQuery({ queryKey: ['audit-verify'], queryFn: () => api<{ valid: boolean; checked: number; broken_at_seq: number | null; head: string }>('/v1/audit/verify') });
  const list = useInfiniteQuery({
    queryKey: ['audit', action, resource],
    queryFn: ({ pageParam }) =>
      api<{ items: AuditEvent[]; next_cursor: string | null }>('/v1/audit/events', {
        query: { action: action || undefined, resource_id: resource || undefined, cursor: pageParam ?? undefined, limit: 100 },
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (l) => l.next_cursor,
  });
  const [open, setOpen] = useState<string | null>(null);
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Audit log</h1>
      {verify.data &&
        (verify.data.valid ? (
          <Notice tone="verified" title="Integrity verified">
            <span className="flex items-center gap-1.5">
              <ShieldCheck className="size-4" /> All {verify.data.checked} events form an unbroken hash chain. Head <code className="text-2xs">{verify.data.head.slice(0, 16)}…</code>
            </span>
          </Notice>
        ) : (
          <Notice tone="conflict" title="Integrity check failed">
            <span className="flex items-center gap-1.5">
              <ShieldX className="size-4" /> The chain breaks at event {verify.data.broken_at_seq}. Records from that point may have been altered. Escalate to security.
            </span>
          </Notice>
        ))}
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Action" placeholder="Action starts with, e.g. case. or fact.approved" value={action} onChange={(e) => setAction(e.target.value)} className="max-w-xs" />
        <Input aria-label="Resource ID" placeholder="Resource ID" value={resource} onChange={(e) => setResource(e.target.value.trim())} className="max-w-xs" />
      </div>
      <Sheet>
        {list.isLoading ? (
          <LoadingRows rows={8} />
        ) : (
          <Table caption="Audit events">
            <thead>
              <tr>
                <Th numeric>#</Th>
                <Th>When</Th>
                <Th>Who</Th>
                <Th>What</Th>
                <Th>Resource</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <Fragment key={e.id}>
                  <tr className="cursor-pointer hover:bg-sheet-sunk" onClick={() => setOpen(open === e.id ? null : e.id)} aria-expanded={open === e.id}>
                    <Td numeric className="text-2xs text-ink-muted">
                      {e.seq}
                    </Td>
                    <Td className="text-xs whitespace-nowrap">{fmtDateTime(e.occurred_at)}</Td>
                    <Td className="text-xs">{e.actor_name ?? (e.actor_type === 'system' ? `FinGraph (${e.actor_id ?? 'system'})` : `${e.actor_type} ${e.actor_id ?? ''}`)}</Td>
                    <Td className="text-xs">
                      {describeAction(e)}
                      <span className="block text-2xs text-ink-faint">{e.action}</span>
                    </Td>
                    <Td className="max-w-[14rem] truncate text-2xs text-ink-muted">
                      {e.resource_type} {e.resource_id}
                    </Td>
                  </tr>
                  {open === e.id && (
                    <tr>
                      <Td colSpan={5} className="bg-sheet-sunk">
                        <pre className="overflow-x-auto text-2xs whitespace-pre-wrap">
                          {JSON.stringify({ details: e.details, correlation_id: e.correlation_id, ip: e.ip, hash: e.hash }, null, 2)}
                        </pre>
                      </Td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </Table>
        )}
        {list.hasNextPage && (
          <div className="border-t border-rule p-3">
            <Button size="sm" onClick={() => list.fetchNextPage()} busy={list.isFetchingNextPage}>
              Load older events
            </Button>
          </div>
        )}
      </Sheet>
    </div>
  );
}
