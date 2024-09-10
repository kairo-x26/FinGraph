import { cn as clsx } from '@/lib/cn';
import type { HTMLAttributes, ReactNode, TdHTMLAttributes, ThHTMLAttributes } from 'react';

export function Table({ children, className, caption }: { children: ReactNode; className?: string; caption?: string }) {
  return (
    <div className="overflow-x-auto">
      <table className={clsx('w-full border-collapse text-left text-sm', className)}>
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function Th({ className, numeric, ...rest }: ThHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return (
    <th
      scope="col"
      className={clsx('border-b border-rule px-3 py-2 text-2xs font-medium whitespace-nowrap text-ink-muted', numeric && 'text-right', className)}
      {...rest}
    />
  );
}

export function Td({ className, numeric, ...rest }: TdHTMLAttributes<HTMLTableCellElement> & { numeric?: boolean }) {
  return <td className={clsx('border-b border-rule/70 px-3 py-2.5 align-top', numeric && 'text-right tabular-nums', className)} {...rest} />;
}

export function Tr({ className, interactive, ...rest }: HTMLAttributes<HTMLTableRowElement> & { interactive?: boolean }) {
  return <tr className={clsx(interactive && 'cursor-pointer hover:bg-sheet-sunk', className)} {...rest} />;
}
