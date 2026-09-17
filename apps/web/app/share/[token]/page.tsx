'use client';

import { useEffect, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/lib/auth';
import { acceptShare } from '@/lib/queries';
import { ApiError } from '@/lib/api-client';

export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const { status } = useAuth();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (status === 'loading' || started.current) return;
    if (status === 'signed-out') {
      router.replace(`/login?next=${encodeURIComponent(`/share/${token}`)}`);
      return;
    }
    started.current = true;
    acceptShare(token)
      .then((r) => router.replace(`/docs/${r.docId}`))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) setError('This link is invalid, expired or was revoked.');
        else setError(e instanceof Error ? e.message : 'Could not accept the invitation.');
      });
  }, [status, token, router]);

  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 text-center">
      {error ? (
        <>
          <h1 className="font-display text-2xl font-semibold">Link not accepted</h1>
          <p className="mt-2 text-muted">{error}</p>
          <Link href="/docs" className="mt-6 text-accent underline-offset-2 hover:underline">
            Back to documents
          </Link>
        </>
      ) : (
        <p className="text-muted" role="status">
          Opening the shared document…
        </p>
      )}
    </main>
  );
}
