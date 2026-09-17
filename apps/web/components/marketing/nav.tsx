'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Menu, X } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import { LogoMark } from './logo-mark';

const LINKS = [
  { href: '#product', label: 'Product' },
  { href: '#how', label: 'How it works' },
  { href: '#security', label: 'Security' },
];

export function Nav() {
  const { status } = useAuth();
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    const onClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, [open]);

  const pill = 'inline-flex h-9 items-center rounded-full px-5 text-[11px] font-bold uppercase tracking-[0.16em] transition-colors';

  return (
    <header
      className={cn('sticky z-30 h-16 bg-paper/85 backdrop-blur transition-colors', scrolled ? 'border-b border-line' : 'border-b border-transparent')}
      style={{ top: 'env(safe-area-inset-top, 0px)' }}
    >
      <nav className="mx-auto flex h-full max-w-6xl items-center justify-between gap-6 px-4" aria-label="Primary">
        <Link href="/" className="flex items-center gap-2.5 font-display text-[15px] font-bold uppercase leading-none tracking-[0.12em]">
          <LogoMark size={30} />
          Confluo
        </Link>

        <div className="hidden items-center gap-8 text-[11px] font-bold uppercase tracking-[0.16em] text-ink/90 md:flex">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="hover:text-accent">
              {l.label}
            </a>
          ))}
        </div>

        <div className="relative flex items-center gap-3" ref={menuRef}>
          {status === 'signed-in' ? (
            <Link href="/docs" className={cn(pill, 'bg-accent text-on-accent hover:bg-accent-hover')}>
              Open documents
            </Link>
          ) : (
            <Link href="/login" className={cn(pill, 'bg-accent text-on-accent hover:bg-accent-hover')}>
              Sign in
            </Link>
          )}
          <button
            type="button"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            aria-controls="site-menu"
            onClick={() => setOpen((v) => !v)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-full text-ink hover:bg-white/10"
          >
            {open ? <X size={22} /> : <Menu size={24} />}
          </button>

          {open && (
            <div
              id="site-menu"
              className="absolute right-0 top-12 z-40 w-60 rounded-lg border border-line bg-surface p-2 shadow-xl"
            >
              <ul className="flex flex-col">
                {LINKS.map((l) => (
                  <li key={l.href}>
                    <a
                      href={l.href}
                      onClick={() => setOpen(false)}
                      className="block rounded-md px-3 py-2 text-[12px] font-bold uppercase tracking-[0.14em] text-ink hover:bg-accent-soft"
                    >
                      {l.label}
                    </a>
                  </li>
                ))}
                <li className="my-1 border-t border-line" role="presentation" />
                {status === 'signed-in' ? (
                  <li>
                    <Link href="/docs" onClick={() => setOpen(false)} className="block rounded-md px-3 py-2 text-sm text-ink hover:bg-accent-soft">
                      Open documents
                    </Link>
                  </li>
                ) : (
                  <>
                    <li>
                      <Link href="/login" onClick={() => setOpen(false)} className="block rounded-md px-3 py-2 text-sm text-ink hover:bg-accent-soft">
                        Log in
                      </Link>
                    </li>
                    <li>
                      <Link
                        href="/register"
                        onClick={() => {
                          setOpen(false);
                          track('cta_click', { location: 'nav' });
                        }}
                        className="block rounded-md px-3 py-2 text-sm font-medium text-accent hover:bg-accent-soft"
                      >
                        Start writing — free
                      </Link>
                    </li>
                  </>
                )}
              </ul>
            </div>
          )}
        </div>
      </nav>
    </header>
  );
}
