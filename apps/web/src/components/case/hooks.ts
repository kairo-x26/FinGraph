'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, errorMessage } from '@/lib/api';
import type { Answer, CaseSummary, ChecklistItem, DocumentSummary, Fact, Finding, GraphEdge, GraphNode, Readiness } from '@/lib/types';
import { useToast } from '@/ui';

export const keys = {
  case: (id: string) => ['case', id] as const,
  documents: (id: string) => ['case', id, 'documents'] as const,
  facts: (id: string) => ['case', id, 'facts'] as const,
  checklist: (id: string) => ['case', id, 'checklist'] as const,
  readiness: (id: string) => ['case', id, 'readiness'] as const,
  graph: (id: string) => ['case', id, 'graph'] as const,
  ownership: (id: string) => ['case', id, 'ownership'] as const,
  questions: (id: string) => ['case', id, 'questions'] as const,
  decisions: (id: string) => ['case', id, 'decisions'] as const,
  timeline: (id: string) => ['case', id, 'timeline'] as const,
};

export const useCase = (id: string) => useQuery({ queryKey: keys.case(id), queryFn: () => api<CaseSummary>(`/v1/cases/${id}`) });

export const useDocuments = (id: string) =>
  useQuery({
    queryKey: keys.documents(id),
    queryFn: () => api<{ items: DocumentSummary[] }>('/v1/documents', { query: { case_id: id } }).then((r) => r.items),
    // keep polling while something is still being processed
    refetchInterval: (q) => (q.state.data?.some((d) => ['queued', 'processing', 'uploaded'].includes(d.latest_status)) ? 2000 : false),
  });

export const useFacts = (id: string) =>
  useQuery({ queryKey: keys.facts(id), queryFn: () => api<{ items: Fact[]; counts: Record<string, number> }>(`/v1/cases/${id}/facts`) });

export const useChecklist = (id: string) =>
  useQuery({
    queryKey: keys.checklist(id),
    queryFn: () => api<{ template: { version: number } | null; items: ChecklistItem[]; complete: boolean }>(`/v1/cases/${id}/checklist`),
  });

export const useReadiness = (id: string) => useQuery({ queryKey: keys.readiness(id), queryFn: () => api<Readiness>(`/v1/cases/${id}/readiness`) });

export const useGraph = (id: string, historical = false) =>
  useQuery({
    queryKey: [...keys.graph(id), historical],
    queryFn: () =>
      api<{ subject_entity_id: string | null; nodes: GraphNode[]; edges: GraphEdge[] }>(`/v1/cases/${id}/graph`, { query: { include_historical: historical } }),
  });

export interface Owner {
  entity_id: string;
  display_name: string;
  kind: string;
  effective_pct: number;
  direct_pct: number;
  declared: boolean;
  verified: boolean;
  chains: { path: { entity_id: string; pct: number }[]; effective_pct: number }[];
}

export const useOwnership = (id: string) =>
  useQuery({ queryKey: keys.ownership(id), queryFn: () => api<{ threshold: number; owners: Owner[] }>(`/v1/cases/${id}/ownership`) });

export const useQuestions = (id: string) => useQuery({ queryKey: keys.questions(id), queryFn: () => api<{ items: Answer[] }>(`/v1/cases/${id}/questions`) });

export const useFindings = (id: string) => {
  const r = useReadiness(id);
  return { ...r, data: r.data?.findings as Finding[] | undefined };
};

/** Mutation that refreshes everything about the case on success and reports errors as toasts. */
export function useCaseMutation<TVars, TResult = unknown>(caseId: string, fn: (v: TVars) => Promise<TResult>, success?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['case', caseId] });
      qc.invalidateQueries({ queryKey: ['cases'] });
      qc.invalidateQueries({ queryKey: ['notifications'] });
      if (success) toast({ tone: 'success', message: success });
    },
    onError: (err) => toast({ tone: 'error', message: errorMessage(err) }),
  });
}
