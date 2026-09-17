'use client';

export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 text-center">
      <h1 className="font-display text-3xl font-semibold">Something went wrong</h1>
      <p className="mt-2 text-muted">{error.message || 'An unexpected error occurred.'}</p>
      <button type="button" onClick={reset} className="mx-auto mt-6 rounded-md bg-accent px-4 py-2 text-sm font-medium text-on-accent">
        Try again
      </button>
    </main>
  );
}
