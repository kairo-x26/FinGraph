'use client';

import type { ReactNode } from 'react';
import { Shell } from '@/components/shell';
import { SourceViewerProvider } from '@/components/source-viewer';
import { SessionGate } from '@/lib/session';

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <SessionGate
      fallback={
        <div className="flex min-h-dvh items-center justify-center text-sm text-ink-muted" role="status">
          Loading your workspace…
        </div>
      }
    >
      <SourceViewerProvider>
        <Shell>{children}</Shell>
      </SourceViewerProvider>
    </SessionGate>
  );
}
