'use client';

import { cn as clsx } from '@/lib/cn';
import { X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { IconButton } from './controls';

/** Modal dialog built on <dialog> (focus trap, Escape and inert background for free). */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = 'max-w-lg',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      aria-labelledby="dialog-title"
      className={clsx('m-auto w-[calc(100%-2rem)] rounded-[var(--radius-sheet)] border border-rule bg-sheet p-0 text-ink shadow-[var(--shadow-sheet)]', width)}
    >
      {open && (
        <div className="flex max-h-[85vh] flex-col">
          <header className="flex items-start justify-between gap-4 border-b border-rule px-5 py-4">
            <div>
              <h2 id="dialog-title" className="text-base font-semibold">
                {title}
              </h2>
              {description && <p className="mt-0.5 text-xs text-ink-muted">{description}</p>}
            </div>
            <IconButton label="Close" onClick={onClose}>
              <X className="size-4" />
            </IconButton>
          </header>
          <div className="overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex justify-end gap-2 border-t border-rule px-5 py-3">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

/** Right-side panel for document sources and details. */
export function Drawer({ open, onClose, title, children, width = 'w-[min(720px,100vw)]' }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; width?: string }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="presentation">
      <button aria-label="Close panel" className="absolute inset-0 bg-ink/25" onClick={onClose} />
      <aside
        role="dialog"
        aria-modal="true"
        className={clsx('relative flex h-full flex-col border-l border-rule bg-sheet shadow-[var(--shadow-sheet)] animate-[drawer-in_180ms_ease-out]', width)}
      >
        <header className="flex items-center justify-between gap-4 border-b border-rule px-5 py-3">
          <div className="min-w-0 text-sm font-semibold">{title}</div>
          <IconButton label="Close" onClick={onClose}>
            <X className="size-4" />
          </IconButton>
        </header>
        <div data-scroll-panel className="min-h-0 flex-1 overflow-y-auto">
          {children}
        </div>
      </aside>
      <style>{`@keyframes drawer-in { from { transform: translateX(24px); opacity: .6 } to { transform: none; opacity: 1 } }`}</style>
    </div>
  );
}

interface Toast {
  id: number;
  tone: 'success' | 'error' | 'info';
  message: string;
}

const ToastContext = createContext<(t: Omit<Toast, 'id'>) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((t: Omit<Toast, 'id'>) => {
    const id = Date.now() + Math.random();
    setToasts((all) => [...all, { ...t, id }]);
    setTimeout(() => setToasts((all) => all.filter((x) => x.id !== id)), t.tone === 'error' ? 8000 : 4000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-50 flex w-[min(380px,calc(100vw-2rem))] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={clsx(
              'pointer-events-auto rounded-[var(--radius-control)] border bg-sheet px-3.5 py-2.5 text-sm shadow-[var(--shadow-sheet)]',
              t.tone === 'error' ? 'border-conflict/50 text-conflict' : t.tone === 'success' ? 'border-verified/40' : 'border-rule',
            )}
          >
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

export function Tabs<T extends string>({ tabs, value, onChange, label }: { tabs: { id: T; label: ReactNode; count?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="flex gap-1 overflow-x-auto border-b border-rule">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={clsx(
            '-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap',
            value === t.id ? 'border-register font-semibold text-ink' : 'border-transparent text-ink-muted hover:text-ink',
          )}
        >
          {t.label}
          {t.count !== undefined && <span className="rounded-full bg-sheet-sunk px-1.5 text-2xs tabular-nums text-ink-muted">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}
