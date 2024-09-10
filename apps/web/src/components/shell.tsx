'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { cn as clsx } from '@/lib/cn';
import { Bell, BriefcaseBusiness, ChartColumn, LogOut, Moon, ScrollText, Search, Settings, Sun, Waypoints } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import { Avatar, IconButton } from '@/ui';

interface NavItem {
  href: string;
  label: string;
  icon: ReactNode;
  show: boolean;
}

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null);
  useEffect(() => {
    try {
      const saved = localStorage.getItem('fg-theme') as 'light' | 'dark' | null;
      if (saved) {
        document.documentElement.dataset.theme = saved;
        setTheme(saved);
      }
    } catch {
      /* storage unavailable */
    }
  }, []);
  const toggle = () => {
    const current = theme ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    setTheme(next);
    try {
      localStorage.setItem('fg-theme', next);
    } catch {
      /* ignore */
    }
  };
  return { theme, toggle };
}

interface Notification {
  id: string;
  type: string;
  title: string;
  body: string | null;
  link: string | null;
  read_at: string | null;
  created_at: string;
}

function Notifications() {
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<{ items: Notification[]; unread: number }>('/v1/notifications'),
    refetchInterval: 30_000,
  });
  const readAll = useMutation({
    mutationFn: () => api('/v1/notifications/read-all', { method: 'POST' }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const unread = q.data?.unread ?? 0;
  return (
    <div className="relative" ref={ref}>
      <IconButton label={unread ? `Notifications (${unread} unread)` : 'Notifications'} onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <Bell className="size-4" />
        {unread > 0 && <span className="absolute top-1 right-1 size-2 rounded-full bg-conflict" aria-hidden />}
      </IconButton>
      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[min(380px,calc(100vw-1rem))] rounded-[var(--radius-sheet)] border border-rule bg-sheet shadow-[var(--shadow-sheet)]">
          <div className="flex items-center justify-between border-b border-rule px-3 py-2">
            <span className="text-xs font-semibold">Notifications</span>
            {unread > 0 && (
              <button className="text-2xs text-register hover:underline" onClick={() => readAll.mutate()}>
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-96 overflow-y-auto">
            {(q.data?.items ?? []).length === 0 && <li className="px-3 py-6 text-center text-xs text-ink-muted">Nothing new.</li>}
            {q.data?.items.map((n) => (
              <li key={n.id}>
                <button
                  className={clsx('flex w-full flex-col items-start gap-0.5 border-b border-rule/60 px-3 py-2.5 text-left hover:bg-sheet-sunk', !n.read_at && 'bg-register-soft/40')}
                  onClick={async () => {
                    setOpen(false);
                    if (!n.read_at) {
                      await api(`/v1/notifications/${n.id}/read`, { method: 'POST' }).catch(() => undefined);
                      qc.invalidateQueries({ queryKey: ['notifications'] });
                    }
                    if (n.link) router.push(n.link);
                  }}
                >
                  <span className="text-xs font-medium">{n.title}</span>
                  {n.body && <span className="line-clamp-2 text-2xs text-ink-muted">{n.body}</span>}
                  <span className="text-2xs text-ink-faint">{fmtRelative(n.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function Shell({ children }: { children: ReactNode }) {
  const s = useSession();
  const path = usePathname();
  const router = useRouter();
  const { theme, toggle } = useTheme();
  const [query, setQuery] = useState('');

  const nav: NavItem[] = [
    { href: '/cases', label: 'Cases', icon: <BriefcaseBusiness className="size-4" />, show: s.can('case:read') },
    { href: '/search', label: 'Search', icon: <Search className="size-4" />, show: s.can('document:read') },
    { href: '/entities', label: 'Entities', icon: <Waypoints className="size-4" />, show: s.can('graph:read') },
    { href: '/dashboard', label: 'Dashboard', icon: <ChartColumn className="size-4" />, show: s.can('dashboard:read') },
    { href: '/audit', label: 'Audit log', icon: <ScrollText className="size-4" />, show: s.can('audit:read') },
    {
      href: '/admin',
      label: 'Administration',
      icon: <Settings className="size-4" />,
      show: s.can('admin:users') || s.can('admin:policies') || s.can('webhook:manage') || s.can('admin:integrations'),
    },
  ];

  const signOut = async () => {
    const r = await api<{ logout_url: string | null }>('/v1/auth/logout', { method: 'POST' }).catch(() => ({ logout_url: null }));
    window.location.href = r.logout_url ?? '/login?signed_out=1';
  };

  const search = (e: FormEvent) => {
    e.preventDefault();
    if (query.trim().length >= 2) router.push(`/search?q=${encodeURIComponent(query.trim())}`);
  };

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 focus:rounded focus:bg-sheet focus:px-3 focus:py-2">
        Skip to content
      </a>
      <nav aria-label="Main" className="sticky top-0 hidden h-dvh w-52 shrink-0 flex-col border-r border-rule bg-sheet-sunk md:flex">
        <div className="px-4 pt-4 pb-5">
          <Link href="/cases" className="flex items-baseline gap-1.5">
            <span className="font-serif text-lg font-semibold tracking-tight text-ink">FinGraph</span>
          </Link>
          <p className="mt-0.5 truncate text-2xs text-ink-muted">{s.tenant.name}</p>
        </div>
        <ul className="flex flex-col gap-0.5 px-2">
          {nav
            .filter((n) => n.show)
            .map((n) => {
              const active = path === n.href || path.startsWith(`${n.href}/`);
              return (
                <li key={n.href}>
                  <Link
                    href={n.href}
                    aria-current={active ? 'page' : undefined}
                    className={clsx(
                      'flex items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 py-1.5 text-sm',
                      active ? 'bg-sheet font-semibold text-ink shadow-[inset_2px_0_0_var(--register)]' : 'text-ink-muted hover:bg-sheet hover:text-ink',
                    )}
                  >
                    {n.icon}
                    {n.label}
                  </Link>
                </li>
              );
            })}
        </ul>
        <div className="mt-auto border-t border-rule p-3">
          <div className="flex items-center gap-2">
            <Avatar name={s.user.display_name} size={28} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-medium">{s.user.display_name}</p>
              <p className="truncate text-2xs text-ink-muted">{s.user.roles.map((r) => r.label).join(', ')}</p>
            </div>
          </div>
          <div className="mt-2 flex gap-1">
            <IconButton label={theme === 'dark' ? 'Use light theme' : 'Use dark theme'} onClick={toggle}>
              {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
            </IconButton>
            <IconButton label="Sign out" onClick={signOut}>
              <LogOut className="size-4" />
            </IconButton>
          </div>
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 flex h-12 items-center gap-3 border-b border-rule bg-paper/95 px-4 backdrop-blur">
          <Link href="/cases" className="font-serif text-base font-semibold md:hidden">
            FinGraph
          </Link>
          {s.can('document:read') && (
            <form role="search" onSubmit={search} className="relative w-full max-w-md">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-ink-faint" aria-hidden />
              <input
                aria-label="Search documents"
                placeholder="Search documents, names, identifiers"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="h-8 w-full rounded-[var(--radius-control)] border border-rule bg-sheet pr-3 pl-8 text-sm placeholder:text-ink-faint focus:border-register focus:outline-none"
              />
            </form>
          )}
          <div className="ml-auto flex items-center gap-1">
            <Notifications />
            <span className="md:hidden">
              <IconButton label="Sign out" onClick={signOut}>
                <LogOut className="size-4" />
              </IconButton>
            </span>
          </div>
        </header>
        <nav aria-label="Sections" className="flex gap-1 overflow-x-auto border-b border-rule bg-sheet-sunk px-2 py-1 md:hidden">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <Link key={n.href} href={n.href} className={clsx('rounded px-2 py-1 text-xs whitespace-nowrap', path.startsWith(n.href) ? 'bg-sheet font-semibold' : 'text-ink-muted')}>
                {n.label}
              </Link>
            ))}
        </nav>
        <main id="main" className="min-w-0 flex-1 px-4 py-5 md:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
