'use client';

import { useQuery } from '@tanstack/react-query';
import type { Permission } from '@fingraph/shared';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { api, ApiError } from './api';

export interface Session {
  user: { id: string; email: string; display_name: string; roles: { id: string; label: string }[] };
  tenant: { id: string; slug: string; name: string };
  permissions: Permission[];
  csrf_token: string;
}

interface SessionValue extends Session {
  can: (...p: Permission[]) => boolean;
}

const SessionContext = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionGate');
  return s;
}

/** Loads the session; sends signed-out users to /login and remembers where they were. */
export function SessionGate({ children, fallback }: { children: ReactNode; fallback: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const q = useQuery({
    queryKey: ['session'],
    queryFn: () => api<Session>('/v1/auth/session'),
    retry: (n, err) => !(err instanceof ApiError && err.status === 401) && n < 2,
    staleTime: 60_000,
  });
  const unauthorized = q.error instanceof ApiError && (q.error.status === 401 || q.error.status === 403);
  useEffect(() => {
    if (unauthorized) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [unauthorized, path, router]);
  if (!q.data) return <>{fallback}</>;
  const set = new Set(q.data.permissions);
  return <SessionContext.Provider value={{ ...q.data, can: (...p) => p.every((x) => set.has(x)) }}>{children}</SessionContext.Provider>;
}
