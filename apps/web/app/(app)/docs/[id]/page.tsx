'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useDoc } from '@/lib/queries';
import { ApiError } from '@/lib/api-client';
import { EditorScreen } from '@/components/editor/editor-screen';

export default function DocPage() {
  const { id } = useParams<{ id: string }>();
  const doc = useDoc(id);

  if (doc.isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted" role="status">
        Opening document…
      </div>
    );
  }
  if (doc.isError || !doc.data) {
    const err = doc.error;
    const status = err instanceof ApiError ? err.status : 0;
    return (
      <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 text-center">
        <h1 className="font-display text-2xl font-semibold">{status === 403 ? 'No access' : status === 404 ? 'Document not found' : 'Could not open document'}</h1>
        <p className="mt-2 text-muted">
          {status === 403
            ? 'Ask the owner to share this document with you.'
            : status === 404
              ? 'It may have been deleted.'
              : err instanceof Error
                ? err.message
                : ''}
        </p>
        <Link href="/docs" className="mt-6 text-accent underline-offset-2 hover:underline">
          Back to documents
        </Link>
      </main>
    );
  }
  return <EditorScreen detail={doc.data} />;
}
