'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { ADMIN_SECTIONS } from '@/components/admin/sections';
import { useSession } from '@/lib/session';
import { EmptyState } from '@/ui';

export default function AdminIndex() {
  const s = useSession();
  const router = useRouter();
  const first = ADMIN_SECTIONS.find((x) => x.allowed(s.can));
  useEffect(() => {
    if (first) router.replace(`/admin/${first.id}`);
  }, [first, router]);
  return first ? null : <EmptyState title="Nothing to administer">Your role has no administration rights.</EmptyState>;
}
