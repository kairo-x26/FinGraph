'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Suspense } from 'react';
import { DevelopersAdmin } from '@/components/admin/developers';
import { GovernanceAdmin } from '@/components/admin/governance';
import { IntegrationsAdmin } from '@/components/admin/integrations';
import { OrganizationAdmin } from '@/components/admin/organization';
import { PoliciesAdmin } from '@/components/admin/policies';
import { ADMIN_SECTIONS } from '@/components/admin/sections';
import { UsersAdmin } from '@/components/admin/users';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';
import { LoadingRows, Notice } from '@/ui';

const VIEWS: Record<string, () => React.ReactNode> = {
  people: () => <UsersAdmin />,
  organization: () => <OrganizationAdmin />,
  policies: () => <PoliciesAdmin />,
  integrations: () => <IntegrationsAdmin />,
  developers: () => <DevelopersAdmin />,
  governance: () => <GovernanceAdmin />,
};

export default function AdminSection() {
  const { section } = useParams<{ section: string }>();
  const s = useSession();
  const sections = ADMIN_SECTIONS.filter((x) => x.allowed(s.can));
  const current = sections.find((x) => x.id === section);
  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-4">
      <h1 className="text-xl font-semibold tracking-tight">Administration</h1>
      <div className="grid gap-5 md:grid-cols-[200px_minmax(0,1fr)]">
        <nav aria-label="Administration">
          <ul className="flex gap-1 overflow-x-auto md:flex-col">
            {sections.map((x) => (
              <li key={x.id}>
                <Link
                  href={`/admin/${x.id}`}
                  aria-current={x.id === section ? 'page' : undefined}
                  className={cn('block rounded-[var(--radius-control)] px-3 py-2 whitespace-nowrap md:whitespace-normal', x.id === section ? 'bg-sheet font-semibold shadow-[inset_2px_0_0_var(--register)]' : 'text-ink-muted hover:bg-sheet')}
                >
                  <span className="block text-sm">{x.label}</span>
                  <span className="hidden text-2xs font-normal text-ink-muted md:block">{x.description}</span>
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <section className="min-w-0">
          {current ? <Suspense fallback={<LoadingRows />}>{VIEWS[current.id]!()}</Suspense> : <Notice tone="conflict">This section does not exist or your role cannot open it.</Notice>}
        </section>
      </div>
    </div>
  );
}
