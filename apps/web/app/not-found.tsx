import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 text-center">
      <h1 className="font-display text-3xl font-semibold">Page not found</h1>
      <p className="mt-2 text-muted">The page you are looking for does not exist or you no longer have access.</p>
      <Link href="/docs" className="mt-6 text-accent underline-offset-2 hover:underline">
        Back to documents
      </Link>
    </main>
  );
}
