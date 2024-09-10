'use client';

import { cn as clsx } from '@/lib/cn';
import { Loader2 } from 'lucide-react';
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  busy?: boolean;
  icon?: ReactNode;
}

const variants: Record<Variant, string> = {
  primary: 'bg-register text-register-ink border-register hover:brightness-110',
  secondary: 'bg-sheet text-ink border-rule-strong hover:bg-sheet-sunk',
  ghost: 'bg-transparent text-ink border-transparent hover:bg-sheet-sunk',
  danger: 'bg-sheet text-conflict border-conflict/50 hover:bg-conflict-soft',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', busy, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      className={clsx(
        'inline-flex items-center justify-center gap-1.5 rounded-[var(--radius-control)] border font-medium whitespace-nowrap transition-[filter,background-color] disabled:cursor-not-allowed disabled:opacity-55',
        size === 'sm' ? 'h-7 px-2.5 text-xs' : 'h-8.5 px-3.5 text-sm',
        variants[variant],
        className,
      )}
      {...rest}
    >
      {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : icon}
      {children}
    </button>
  );
});

export function IconButton({ label, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={clsx('inline-flex size-8 items-center justify-center rounded-[var(--radius-control)] text-ink-muted hover:bg-sheet-sunk hover:text-ink', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

interface FieldProps {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  children: (id: string, describedBy?: string) => ReactNode;
  className?: string;
}

export function Field({ label, hint, error, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div className={clsx('flex flex-col gap-1', className)}>
      <label htmlFor={id} className="text-xs font-medium text-ink">
        {label}
      </label>
      {children(id, hintId)}
      {(error || hint) && (
        <p id={hintId} className={clsx('text-2xs', error ? 'text-conflict' : 'text-ink-muted')}>
          {error ?? hint}
        </p>
      )}
    </div>
  );
}

const control =
  'w-full rounded-[var(--radius-control)] border border-rule-strong bg-sheet px-2.5 text-sm text-ink placeholder:text-ink-faint focus:border-register focus:outline-none focus:ring-2 focus:ring-register/25 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={clsx(control, 'h-8.5', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={clsx(control, 'h-8.5 pr-7', className)} {...rest}>
      {children}
    </select>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={clsx(control, 'min-h-20 py-2 leading-relaxed', className)} {...rest} />;
});

export function Checkbox({ label, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode }) {
  const id = useId();
  return (
    <div className="flex items-start gap-2">
      <input id={id} type="checkbox" className="mt-0.5 size-4 accent-[var(--register)]" {...rest} />
      <label htmlFor={id} className="text-sm">
        {label}
        {hint && <span className="block text-2xs text-ink-muted">{hint}</span>}
      </label>
    </div>
  );
}
