'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth';

/** Client-side auth gate for every authenticated route. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  const { status } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (status === 'signed-out') router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [status, router, pathname]);

  if (status !== 'signed-in') {
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted" role="status" aria-live="polite">
        {status === 'loading' ? 'Loading your session…' : 'Redirecting to log in…'}
      </div>
    );
  }
  return <>{children}</>;
}
