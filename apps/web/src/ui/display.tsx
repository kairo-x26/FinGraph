'use client';

import { cn as clsx } from '@/lib/cn';
import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'register' | 'verified' | 'candidate' | 'conflict';

const tones: Record<Tone, string> = {
  neutral: 'bg-sheet-sunk text-ink-muted border-rule',
  register: 'bg-register-soft text-register border-register/30',
  verified: 'bg-verified-soft text-verified border-verified/30',
  candidate: 'bg-candidate-soft text-candidate border-candidate/35',
  conflict: 'bg-conflict-soft text-conflict border-conflict/35',
};

export function Badge({ tone = 'neutral', children, className, dashed }: { tone?: Tone; children: ReactNode; className?: string; dashed?: boolean }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 rounded-full border px-2 py-px text-2xs font-medium whitespace-nowrap',
        dashed && 'border-dashed',
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Sheet({ children, className, as: As = 'section' }: { children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' }) {
  return <As className={clsx('rounded-[var(--radius-sheet)] border border-rule bg-sheet', className)}>{children}</As>;
}

export function SectionHeader({ title, description, actions, level = 2 }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; level?: 2 | 3 }) {
  const H = level === 2 ? 'h2' : 'h3';
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <H className={clsx('font-semibold text-ink', level === 2 ? 'text-base' : 'text-sm')}>{title}</H>
        {description && <p className="mt-0.5 max-w-[72ch] text-xs text-ink-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-start gap-2 rounded-[var(--radius-sheet)] border border-dashed border-rule-strong px-5 py-6">
      <p className="text-sm font-medium">{title}</p>
      {children && <div className="max-w-[60ch] text-xs text-ink-muted">{children}</div>}
      {action}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={clsx('animate-pulse rounded bg-rule/60', className)} />;
}

export function LoadingRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 p-4" role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-5 w-full" />
      ))}
    </div>
  );
}

export function Notice({ tone = 'register', title, children, action }: { tone?: Tone; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div role={tone === 'conflict' ? 'alert' : 'status'} className={clsx('flex items-start gap-3 rounded-[var(--radius-control)] border px-3 py-2.5 text-xs', tones[tone])}>
      <div className="min-w-0 flex-1">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={clsx(title && 'mt-0.5', 'text-ink')}>{children}</div>}
      </div>
      {action}
    </div>
  );
}

export function Avatar({ name, size = 24 }: { name: string | null | undefined; size?: number }) {
  const initials = (name ?? '?')
    .split(/\s+/)
    .map((p) => p[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();
  return (
    <span
      aria-hidden
      style={{ width: size, height: size, fontSize: size * 0.42 }}
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-register-soft font-semibold text-register"
    >
      {initials}
    </span>
  );
}

/** Horizontal meter for quota and progress values. */
export function Meter({ value, max, label }: { value: number; max: number; label: string }) {
  const pct = Math.min(100, Math.round((value / Math.max(1, max)) * 100));
  const tone = pct >= 100 ? 'bg-conflict' : pct >= 80 ? 'bg-candidate' : 'bg-register';
  return (
    <div>
      <div className="flex justify-between text-2xs text-ink-muted">
        <span>{label}</span>
        <span className="tabular-nums">{pct}%</span>
      </div>
      <div role="meter" aria-label={label} aria-valuenow={value} aria-valuemin={0} aria-valuemax={max} className="mt-1 h-1.5 overflow-hidden rounded-full bg-rule">
        <div className={clsx('h-full rounded-full', tone)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-rule-strong bg-sheet-sunk px-1 font-sans text-2xs text-ink-muted">{children}</kbd>;
}

export function DefinitionList({ items }: { items: [ReactNode, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[minmax(7rem,auto)_1fr] gap-x-4 gap-y-1.5 text-xs">
      {items.map(([k, v], i) => (
        <div key={i} className="contents">
          <dt className="text-ink-muted">{k}</dt>
          <dd className="min-w-0 text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}
