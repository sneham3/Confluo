'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { LoginBody, RegisterBody } from '@confluo/shared';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api-client';
import { track } from '@/lib/analytics';
import { Button, Field, Input } from '@/components/ui';

export function AuthForm({ mode }: { mode: 'login' | 'register' }) {
  const { login, register } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get('next') && params.get('next')!.startsWith('/') ? params.get('next')! : '/docs';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [show, setShow] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const schema = mode === 'login' ? LoginBody : RegisterBody;
    const parsed = schema.safeParse(mode === 'login' ? { email, password } : { email, password, displayName });
    if (!parsed.success) {
      const errs: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0] ?? 'form');
        if (!errs[k]) errs[k] = issue.message;
      }
      setErrors(errs);
      return;
    }
    setErrors({});
    setPending(true);
    try {
      if (mode === 'login') await login(email, password);
      else {
        track('signup_start');
        await register(email, password, displayName);
      }
      router.replace(next);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) setFormError('Email or password is incorrect.');
        else if (err.status === 409) setFormError('An account with this email already exists.');
        else if (err.status === 429) setFormError('Too many attempts. Please wait a minute and try again.');
        else setFormError(err.message);
      } else setFormError('Could not reach the server. Check that the API is running.');
    } finally {
      setPending(false);
    }
  }

  return (
    <main id="main" className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center px-4 py-12">
      <Link href="/" className="mb-8 font-display text-2xl font-semibold">
        Confluo
      </Link>
      <h1 className="font-display text-3xl font-semibold">{mode === 'login' ? 'Welcome back' : 'Create your account'}</h1>
      <p className="mt-2 text-sm text-muted">{mode === 'login' ? 'Log in to open your documents.' : 'Start writing with your team in a minute.'}</p>
      <form onSubmit={onSubmit} className="mt-8 grid gap-5" noValidate>
        {mode === 'register' && (
          <Field label="Display name" htmlFor="displayName" error={errors.displayName}>
            <Input id="displayName" name="displayName" autoComplete="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={80} />
          </Field>
        )}
        <Field label="Email" htmlFor="email" error={errors.email}>
          <Input id="email" name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </Field>
        <Field
          label="Password"
          htmlFor="password"
          error={errors.password}
          hint={mode === 'register' ? (password.length >= 14 ? 'Strong length.' : 'Use at least 10 characters; 14 or more is better.') : undefined}
        >
          <div className="relative">
            <Input
              id="password"
              name="password"
              type={show ? 'text' : 'password'}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={mode === 'register' ? 10 : 1}
              className="pr-10"
            />
            <button
              type="button"
              onClick={() => setShow((s) => !s)}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink"
              aria-label={show ? 'Hide password' : 'Show password'}
              aria-pressed={show}
            >
              {show ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </Field>
        {formError && (
          <p className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 text-sm text-danger" role="alert">
            {formError}
          </p>
        )}
        <Button type="submit" variant="primary" disabled={pending} className="justify-center">
          {pending ? 'Please wait…' : 'Continue'}
        </Button>
      </form>
      <p className="mt-6 text-sm text-muted">
        {mode === 'login' ? (
          <>
            New here?{' '}
            <Link href={`/register${next !== '/docs' ? `?next=${encodeURIComponent(next)}` : ''}`} className="text-accent underline-offset-2 hover:underline">
              Create an account
            </Link>
          </>
        ) : (
          <>
            Already have an account?{' '}
            <Link href={`/login${next !== '/docs' ? `?next=${encodeURIComponent(next)}` : ''}`} className="text-accent underline-offset-2 hover:underline">
              Log in
            </Link>
          </>
        )}
      </p>
    </main>
  );
}
