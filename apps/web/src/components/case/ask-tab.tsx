'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ShieldAlert, Sparkles, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSource } from '@/components/source-viewer';
import { api, errorMessage } from '@/lib/api';
import { fmtRelative } from '@/lib/format';
import { useSession } from '@/lib/session';
import type { Answer, CaseSummary, Citation } from '@/lib/types';
import { Button, CitationChip, Checkbox, EmptyState, EvidenceQuote, IconButton, LoadingRows, Notice, Sheet, Textarea, useToast } from '@/ui';
import { keys, useQuestions } from './hooks';

const SUGGESTIONS = [
  'Which individuals are listed as beneficial owners of this company, and which documents support those relationships?',
  'Who are the directors and when were they appointed?',
  'What is the EIN and does it match across documents?',
  'What period does the latest bank statement cover?',
];

const FLAG_TEXT: Record<string, string> = {
  prompt_injection_suspected: 'A passage that tried to instruct the AI was found and left out of the answer. Check the case documents for tampering.',
  unsupported_claims_removed: 'Statements the cited sources did not support were removed.',
  model_refused: 'The model declined to answer this question.',
  source_purged: 'A source this answer cited has since been deleted.',
};

function AnswerView({ a, caseId }: { a: Answer; caseId: string }) {
  const open = useSource();
  const qc = useQueryClient();
  const byId = new Map(a.citations.map((c) => [c.passage_id, c]));
  const order = new Map<string, number>();
  a.claims.forEach((cl) => cl.citations.forEach((id) => order.has(id) || order.set(id, order.size + 1)));
  const openCitation = (c: Citation) =>
    open({
      documentId: c.document_id,
      versionId: c.version_id,
      page: c.kind === 'document' ? c.page_no : undefined,
      start: c.kind === 'document' ? c.char_start : undefined,
      end: c.kind === 'document' ? c.char_end : undefined,
      quote: c.kind === 'graph' ? c.excerpt : undefined,
      label: `Cited in answer to: ${a.question}`,
    });
  const feedback = useMutation({
    mutationFn: (f: 'helpful' | 'not_helpful') => api(`/v1/ai-interactions/${a.id}/feedback`, { body: { feedback: f } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.questions(caseId) }),
  });
  return (
    <article className="flex flex-col gap-3 border-b border-rule px-4 py-4 last:border-0">
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium">{a.question}</p>
        <span className="shrink-0 text-2xs text-ink-faint">
          {a.asked_by ? `${a.asked_by}, ` : ''}
          {fmtRelative(a.created_at)}
        </span>
      </div>
      {a.flags.map((f) => (
        <Notice key={f} tone={f === 'prompt_injection_suspected' ? 'conflict' : 'candidate'}>
          <span className="flex items-start gap-1.5">
            {f === 'prompt_injection_suspected' && <ShieldAlert className="mt-px size-3.5 shrink-0" />}
            {FLAG_TEXT[f] ?? f}
          </span>
        </Notice>
      ))}
      {a.status === 'answered' ? (
        <div className="flex flex-col gap-1.5 text-sm leading-relaxed">
          {a.claims.map((cl, i) => (
            <p key={i}>
              {cl.text}
              {cl.citations.map((id) => {
                const c = byId.get(id);
                return c ? <CitationChip key={id} label={String(order.get(id))} title={`${c.document_title}${c.page_no ? `, page ${c.page_no}` : ''}`} onClick={() => openCitation(c)} /> : null;
              })}
            </p>
          ))}
        </div>
      ) : (
        <div className="rounded-[var(--radius-control)] border border-dashed border-rule-strong px-3 py-2.5 text-sm">
          <p className="font-medium">{a.status === 'failed' ? 'No answer' : 'Not enough evidence to answer'}</p>
          <p className="mt-0.5 text-xs text-ink-muted">{a.answer}</p>
          {a.missing.length > 0 && <p className="mt-1 text-xs text-ink-muted">{a.missing.join(' ')}</p>}
        </div>
      )}
      {a.citations.length > 0 && (
        <details className="group">
          <summary className="cursor-pointer text-xs text-register">Sources ({order.size})</summary>
          <ol className="mt-2 flex flex-col gap-3">
            {[...order.entries()].map(([id, n]) => {
              const c = byId.get(id)!;
              return (
                <li key={id} className="flex gap-2">
                  <span className="mt-0.5 text-2xs font-semibold tabular-nums">{n}</span>
                  <EvidenceQuote
                    className="min-w-0 flex-1"
                    quote={c.excerpt.length > 400 ? `${c.excerpt.slice(0, 400)}…` : c.excerpt}
                    source={`${c.document_title}${c.page_no ? `, page ${c.page_no}` : ''}${c.kind === 'graph' ? ' (via relationship graph)' : ''}`}
                    onOpen={() => openCitation(c)}
                  />
                </li>
              );
            })}
          </ol>
        </details>
      )}
      <div className="flex items-center justify-between gap-2">
        <p className="text-2xs text-ink-faint">AI summary of case evidence. Check the sources before relying on it; it is not a decision.</p>
        <div className="flex items-center">
          <IconButton label="Helpful" aria-pressed={a.feedback === 'helpful'} onClick={() => feedback.mutate('helpful')} className={a.feedback === 'helpful' ? 'text-verified' : ''}>
            <ThumbsUp className="size-3.5" />
          </IconButton>
          <IconButton label="Not helpful" aria-pressed={a.feedback === 'not_helpful'} onClick={() => feedback.mutate('not_helpful')} className={a.feedback === 'not_helpful' ? 'text-conflict' : ''}>
            <ThumbsDown className="size-3.5" />
          </IconButton>
        </div>
      </div>
    </article>
  );
}

export function AskTab({ c }: { c: CaseSummary }) {
  const s = useSession();
  const toast = useToast();
  const qc = useQueryClient();
  const history = useQuestions(c.id);
  const [question, setQuestion] = useState('');
  const [useGraph, setUseGraph] = useState(true);
  const ask = useMutation({
    mutationFn: (q: string) => api<Answer>(`/v1/cases/${c.id}/questions`, { body: { question: q, use_graph: useGraph } }),
    onSuccess: () => {
      setQuestion('');
      qc.invalidateQueries({ queryKey: keys.questions(c.id) });
    },
    onError: (err) => toast({ tone: 'error', message: errorMessage(err) }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (question.trim().length >= 5) ask.mutate(question.trim());
  };
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-4">
      {s.can('rag:query') && (
        <Sheet className="p-4">
          <form onSubmit={submit} className="flex flex-col gap-3">
            <label htmlFor="question" className="flex items-center gap-1.5 text-sm font-semibold">
              <Sparkles className="size-4 text-register" /> Ask about this case's evidence
            </label>
            <Textarea
              id="question"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              placeholder="For example: who controls the company, and which document says so?"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
              }}
            />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <Checkbox label="Include the relationship graph" checked={useGraph} onChange={(e) => setUseGraph(e.target.checked)} />
              <Button type="submit" variant="primary" busy={ask.isPending} disabled={question.trim().length < 5}>
                Ask
              </Button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SUGGESTIONS.map((sug) => (
                <button key={sug} type="button" onClick={() => setQuestion(sug)} className="rounded-full border border-rule px-2.5 py-1 text-left text-2xs text-ink-muted hover:border-register hover:text-ink">
                  {sug}
                </button>
              ))}
            </div>
            <p className="text-2xs text-ink-muted">Answers use only documents you can open in this case. Each statement links to its source.</p>
          </form>
        </Sheet>
      )}
      <Sheet>
        {history.isLoading ? (
          <LoadingRows />
        ) : history.data?.items.length ? (
          history.data.items.map((a) => <AnswerView key={a.id} a={a} caseId={c.id} />)
        ) : (
          <div className="p-4">
            <EmptyState title="No questions yet">Questions and answers are kept with the case, including which sources were used.</EmptyState>
          </div>
        )}
      </Sheet>
    </div>
  );
}
