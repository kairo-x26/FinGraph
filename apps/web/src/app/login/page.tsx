'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Input, Notice } from '@/ui';

const ERRORS: Record<string, string> = {
  unknown_organization: 'We could not find that organization. Check the name your administrator gave you.',
  access_denied: 'Sign-in was cancelled at your identity provider.',
  invalid_state: 'The sign-in link expired or was already used. Start again.',
  invalid_issuer: 'The identity provider response did not match your organization. Start again.',
  mfa_required: 'Your organization requires multi-factor authentication. Enroll a second factor with your identity provider, then sign in again.',
  not_provisioned: 'Your account is not set up in this organization yet. Ask an administrator to invite you.',
  account_deactivated: 'Your account has been deactivated. Contact your administrator.',
  network_not_allowed: 'Your organization only allows sign-in from approved networks.',
  idp_unavailable: 'Your identity provider is not responding. Try again in a few minutes.',
  token_exchange_failed: 'Sign-in could not be completed with your identity provider. Try again.',
  invalid_id_token: 'The identity provider returned an invalid sign-in token.',
  invalid_nonce: 'The sign-in response could not be verified. Start again.',
};

function LoginForm() {
  const params = useSearchParams();
  const [org, setOrg] = useState(params.get('tenant') ?? '');
  const [isLocal, setIsLocal] = useState(false);
  const error = params.get('error');
  const next = params.get('next') ?? '/cases';
  const hint = params.get('login_hint') ?? undefined;

  useEffect(() => {
    try {
      if (!org) setOrg(localStorage.getItem('fg-org') ?? '');
    } catch {
      /* ignore */
    }
    setIsLocal(['localhost', '127.0.0.1'].includes(window.location.hostname));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const slug = org.trim().toLowerCase();
    try {
      localStorage.setItem('fg-org', slug);
    } catch {
      /* ignore */
    }
    const url = new URLSearchParams({ tenant: slug, redirect_to: next.startsWith('/') ? next : '/cases' });
    if (hint) url.set('login_hint', hint);
    window.location.href = `/api/v1/auth/login?${url}`;
  };

  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col justify-center px-4 py-10">
      <p className="font-serif text-2xl font-semibold tracking-tight">FinGraph</p>
      <p className="mt-1 mb-8 font-serif text-[0.95rem] leading-relaxed text-ink-muted">Every fact, back to the page it came from.</p>

      {params.get('signed_out') && (
        <div className="mb-4">
          <Notice tone="verified">You are signed out.</Notice>
        </div>
      )}
      {error && (
        <div className="mb-4">
          <Notice tone="conflict" title="Sign-in failed">
            {ERRORS[error] ?? 'Sign-in could not be completed. Try again.'}
          </Notice>
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-4 rounded-[var(--radius-sheet)] border border-rule bg-sheet p-5">
        <Field label="Organization" hint="The short name of your organization, for example acme.">
          {(id, describedBy) => (
            <Input
              id={id}
              aria-describedby={describedBy}
              value={org}
              onChange={(e) => setOrg(e.target.value)}
              required
              minLength={3}
              autoComplete="organization"
              autoCapitalize="none"
              spellCheck={false}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={org.trim().length < 3}>
          Continue with single sign-on
        </Button>
      </form>

      {isLocal && (
        <div className="mt-6 rounded-[var(--radius-control)] border border-dashed border-rule-strong px-3 py-2.5 text-2xs text-ink-muted">
          <p className="font-medium text-ink">Local sandbox</p>
          <p className="mt-0.5">
            Organization <code>acme</code>. Pick any demo account on the sandbox sign-in page; the password is <code>password</code> and the one-time code is{' '}
            <code>246810</code>.
          </p>
        </div>
      )}
    </main>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
