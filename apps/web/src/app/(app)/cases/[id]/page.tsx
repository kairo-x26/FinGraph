'use client';

import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { CaseHeader } from '@/components/case/header';
import { Evidence } from '@/components/case/evidence';
import { useCase, useDocuments, useFacts } from '@/components/case/hooks';
import { Overview } from '@/components/case/overview';
import { ApiError } from '@/lib/api';
import { LoadingRows, Notice, Tabs } from '@/ui';

const TABS = ['overview', 'evidence'] as const;
type Tab = (typeof TABS)[number];

function CaseWorkspace() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const tab = (TABS.includes(params.get('tab') as Tab) ? params.get('tab') : 'overview') as Tab;
  const c = useCase(id);
  const docs = useDocuments(id);
  const facts = useFacts(id);

  if (c.isLoading) return <LoadingRows rows={6} />;
  if (c.error || !c.data) {
    return (
      <div className="mx-auto max-w-xl">
        <Notice tone="conflict" title="Case not available">
          {c.error instanceof ApiError && c.error.status === 404 ? 'This case does not exist, or you do not have access to it.' : 'The case could not be loaded.'}
        </Notice>
      </div>
    );
  }
  const setTab = (t: Tab) => {
    const q = new URLSearchParams(params);
    q.set('tab', t);
    q.delete('document');
    router.replace(`/cases/${id}?${q}`, { scroll: false });
  };
  return (
    <div className="mx-auto flex max-w-[1500px] flex-col gap-4">
      <CaseHeader c={c.data} />
      <Tabs
        label="Case sections"
        value={tab}
        onChange={setTab}
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'evidence', label: 'Evidence', count: facts.data?.counts.candidate ?? docs.data?.length },
        ]}
      />
      {tab === 'overview' && <Overview c={c.data} />}
      {tab === 'evidence' && <Evidence c={c.data} initialDocument={params.get('document')} />}
    </div>
  );
}

export default function CasePage() {
  return (
    <Suspense fallback={<LoadingRows rows={6} />}>
      <CaseWorkspace />
    </Suspense>
  );
}
