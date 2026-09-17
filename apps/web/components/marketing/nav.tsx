'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAuth } from '@/lib/auth';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

export function Nav() {
  const { status } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
  return (
    <header
      className={cn(
        'sticky z-30 h-14 border-b bg-paper/85 backdrop-blur transition-colors',
        scrolled ? 'border-line' : 'border-transparent',
      )}
      style={{ top: 'env(safe-area-inset-top, 0px)' }}
    >
      <nav className="mx-auto flex h-full max-w-6xl items-center justify-between gap-6 px-4" aria-label="Primary">
        <Link href="/" className="font-display text-xl font-semibold tracking-tight">
          Confluo
        </Link>
        <div className="hidden items-center gap-6 text-sm text-muted md:flex">
          <a href="#product" className="hover:text-ink">
            Product
          </a>
          <a href="#how" className="hover:text-ink">
            How it works
          </a>
          <a href="#security" className="hover:text-ink">
            Security
          </a>
        </div>
        <div className="flex items-center gap-2">
          {status === 'signed-in' ? (
            <Link href="/docs" className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover">
              Open documents
            </Link>
          ) : (
            <>
              <Link href="/login" className="inline-flex h-9 items-center rounded-md px-3 text-sm font-medium text-ink hover:bg-accent-soft">
                Log in
              </Link>
              <Link
                href="/register"
                onClick={() => track('cta_click', { location: 'nav' })}
                className="inline-flex h-9 items-center rounded-md bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover"
              >
                Start writing — free
              </Link>
            </>
          )}
        </div>
      </nav>
    </header>
  );
}
