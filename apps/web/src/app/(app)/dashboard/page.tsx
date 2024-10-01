'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useState } from 'react';
import { BarChart } from '@/components/bar-chart';
import { api } from '@/lib/api';
import { caseStatusLabel, fmtDate, fmtRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Badge, LoadingRows, Meter, SectionHeader, Select, Sheet, Table, Td, Th } from '@/ui';

interface Dashboard {
  period_days: number;
  cases_by_status: Record<string, number>;
  open_by_risk: Record<string, number>;
  unassigned: number;
  workload: { user_id: string; display_name: string; open_cases: number; in_review: number; overdue: number }[];
  needs_attention: { id: string; reference: string; subject_name: string; status: string; risk_level: string; updated_at: string }[];
  exceptions: { document_id: string; title: string; case_id: string; reference: string; status: string; created_at: string }[];
  throughput: { week: string; approved: number; rejected: number }[];
  review_time_hours: { median_hours: number | null; p90_hours: number | null; n: number };
  documents_per_day: { day: string; received: number; processed: number; failed: number }[];
  automation: { processed: number; with_extracted_facts: number };
  facts: { pending: number; approved: number; corrected: number; rejected: number };
  ai: { questions: number; answered: number; abstained: number; helpful: number; not_helpful: number };
}

interface Usage {
  storage_bytes: { used: number; limit: number };
  documents_today: { used: number; limit: number };
  ai_tokens_today: { used: number; limit: number };
  ocr_pages_today: { used: number; limit: number };
}

function Stat({ label, value, detail, href }: { label: string; value: string | number; detail?: string; href?: string }) {
  const body = (
    <>
      <p className="text-2xs text-ink-muted">{label}</p>
      <p className="mt-1 text-2xl leading-none font-semibold tabular-nums">{value}</p>
      {detail && <p className="mt-1.5 text-2xs text-ink-muted">{detail}</p>}
    </>
  );
  return href ? (
    <Link href={href} className="block border-l border-rule px-4 py-1 first:border-0 hover:bg-sheet-sunk">
      {body}
    </Link>
  ) : (
    <div className="border-l border-rule px-4 py-1 first:border-0">{body}</div>
  );
}

const hours = (h: number | null) => (h === null ? 'n/a' : h < 1 ? 'under 1 h' : h < 48 ? `${Math.round(h)} h` : `${Math.round(h / 24)} days`);
const rate = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : 'n/a');

export default function DashboardPage() {
  const s = useSession();
  const [days, setDays] = useState(90);
  const q = useQuery({ queryKey: ['dashboard', days], queryFn: () => api<Dashboard>('/v1/dashboard', { query: { days } }) });
  const usage = useQuery({ queryKey: ['usage'], queryFn: () => api<Usage>('/v1/tenant/usage'), enabled: s.can('dashboard:read') });
  if (q.isLoading || !q.data) return <LoadingRows rows={8} />;
  const d = q.data;
  const open = Object.entries(d.cases_by_status)
    .filter(([k]) => !['approved', 'rejected', 'archived'].includes(k))
    .reduce((n, [, v]) => n + v, 0);
  const awaiting = (d.cases_by_status.pending_approval ?? 0) + (d.cases_by_status.escalated ?? 0);
  const overdue = d.workload.reduce((n, w) => n + w.overdue, 0);
  const reviewed = d.facts.approved + d.facts.corrected + d.facts.rejected;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight">Dashboard</h1>
        <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-40">
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
          <option value={365}>Last 12 months</option>
        </Select>
      </div>

      <Sheet className="grid grid-cols-2 gap-y-4 py-4 md:grid-cols-5">
        <Stat label="Open cases" value={open} detail={`${d.open_by_risk.high ?? 0} high risk`} href="/cases" />
        <Stat label="Awaiting approval" value={awaiting} detail={`${d.cases_by_status.escalated ?? 0} escalated`} href="/cases" />
        <Stat label="Overdue" value={overdue} detail="Past due date or review target" />
        <Stat label="Unassigned" value={d.unassigned} href="/cases" />
        <Stat label="Median review time" value={hours(d.review_time_hours.median_hours)} detail={`90th percentile ${hours(d.review_time_hours.p90_hours)}, ${d.review_time_hours.n} case${d.review_time_hours.n === 1 ? '' : 's'}`} />
      </Sheet>

      <div className="grid gap-4 lg:grid-cols-2">
        <Sheet className="p-4">
          <BarChart
            title="Cases closed per week"
            series={[
              { key: 'approved', label: 'Approved', color: 'var(--series-1)' },
              { key: 'rejected', label: 'Rejected', color: 'var(--series-2)' },
            ]}
            data={d.throughput.map((t) => ({ label: fmtDate(t.week).replace(/, \d{4}$/, ''), values: { approved: t.approved, rejected: t.rejected } }))}
            empty="No cases were closed in this period."
          />
        </Sheet>
        <Sheet className="p-4">
          <BarChart
            title="Documents received per day"
            series={[{ key: 'received', label: 'Received', color: 'var(--series-1)' }]}
            data={d.documents_per_day.map((x) => ({
              label: fmtDate(x.day).replace(/, \d{4}$/, ''),
              values: { received: x.received },
              note: `${x.processed} processed, ${x.failed} failed or quarantined`,
            }))}
            empty="No documents in the last 14 days."
          />
        </Sheet>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
        <Sheet>
          <div className="border-b border-rule px-4 py-3">
            <SectionHeader title="Reviewer workload" />
          </div>
          <Table caption="Workload">
            <thead>
              <tr>
                <Th>Reviewer</Th>
                <Th numeric>Open</Th>
                <Th numeric>In review</Th>
                <Th numeric>Overdue</Th>
              </tr>
            </thead>
            <tbody>
              {d.workload.map((w) => (
                <tr key={w.user_id}>
                  <Td>{w.display_name}</Td>
                  <Td numeric>{w.open_cases}</Td>
                  <Td numeric>{w.in_review}</Td>
                  <Td numeric className={w.overdue ? 'font-semibold text-conflict' : ''}>
                    {w.overdue}
                  </Td>
                </tr>
              ))}
              {d.workload.length === 0 && (
                <tr>
                  <Td colSpan={4} className="text-xs text-ink-muted">
                    No open assigned cases.
                  </Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Sheet>
        <Sheet>
          <div className="border-b border-rule px-4 py-3">
            <SectionHeader title="Needs a second person" />
          </div>
          <ul>
            {d.needs_attention.length === 0 && <li className="px-4 py-3 text-xs text-ink-muted">Nothing is waiting for approval.</li>}
            {d.needs_attention.map((c) => (
              <li key={c.id} className="border-b border-rule/70 px-4 py-2.5 last:border-0">
                <Link href={`/cases/${c.id}`} className="flex items-center justify-between gap-2 hover:text-register">
                  <span className="min-w-0 truncate text-sm">
                    <span className="tabular-nums text-ink-muted">{c.reference}</span> {c.subject_name}
                  </span>
                  <Badge tone="candidate">{caseStatusLabel(c.status)}</Badge>
                </Link>
                <p className="text-2xs text-ink-muted">Waiting {fmtRelative(c.updated_at).replace(' ago', '')}</p>
              </li>
            ))}
          </ul>
        </Sheet>
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Sheet className="p-4">
          <SectionHeader title="Extraction quality" level={3} description={`${reviewed} reviewed fields in the period`} />
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-ink-muted">Accepted as extracted</dt>
              <dd className="text-lg font-semibold tabular-nums">{rate(d.facts.approved, reviewed)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Corrected by reviewers</dt>
              <dd className="text-lg font-semibold tabular-nums">{rate(d.facts.corrected, reviewed)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Documents with fields</dt>
              <dd className="text-lg font-semibold tabular-nums">{rate(d.automation.with_extracted_facts, d.automation.processed)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Waiting for review</dt>
              <dd className="text-lg font-semibold tabular-nums">{d.facts.pending}</dd>
            </div>
          </dl>
        </Sheet>
        <Sheet className="p-4">
          <SectionHeader title="Evidence questions" level={3} description={`${d.ai.questions} questions in the period`} />
          <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
            <div>
              <dt className="text-ink-muted">Answered with sources</dt>
              <dd className="text-lg font-semibold tabular-nums">{rate(d.ai.answered, d.ai.questions)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Not enough evidence</dt>
              <dd className="text-lg font-semibold tabular-nums">{rate(d.ai.abstained, d.ai.questions)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted">Rated helpful</dt>
              <dd className="text-lg font-semibold tabular-nums">{rate(d.ai.helpful, d.ai.helpful + d.ai.not_helpful)}</dd>
            </div>
          </dl>
        </Sheet>
        <Sheet className="flex flex-col gap-3 p-4">
          <SectionHeader title="Usage today" level={3} />
          {usage.data && (
            <>
              <Meter label="Documents" value={usage.data.documents_today.used} max={usage.data.documents_today.limit} />
              <Meter label="AI tokens" value={usage.data.ai_tokens_today.used} max={usage.data.ai_tokens_today.limit} />
              <Meter label="OCR pages" value={usage.data.ocr_pages_today.used} max={usage.data.ocr_pages_today.limit} />
              <Meter label="Storage" value={usage.data.storage_bytes.used} max={usage.data.storage_bytes.limit} />
            </>
          )}
        </Sheet>
      </div>

      <Sheet>
        <div className="border-b border-rule px-4 py-3">
          <SectionHeader title="Processing exceptions" description="Files that failed, were rejected or were quarantined in the last 30 days." />
        </div>
        <Table caption="Exceptions">
          <thead>
            <tr>
              <Th>Document</Th>
              <Th>Case</Th>
              <Th>Status</Th>
              <Th>Received</Th>
            </tr>
          </thead>
          <tbody>
            {d.exceptions.map((x) => (
              <tr key={x.document_id + x.created_at}>
                <Td>{x.title}</Td>
                <Td className="tabular-nums">
                  <Link href={`/cases/${x.case_id}?tab=evidence&document=${x.document_id}`} className="text-register hover:underline">
                    {x.reference}
                  </Link>
                </Td>
                <Td>
                  <Badge tone="conflict">{x.status}</Badge>
                </Td>
                <Td className="text-xs text-ink-muted">{fmtRelative(x.created_at)}</Td>
              </tr>
            ))}
            {d.exceptions.length === 0 && (
              <tr>
                <Td colSpan={4} className="text-xs text-ink-muted">
                  No exceptions.
                </Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Sheet>
    </div>
  );
}
