'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { track } from '@/lib/analytics';

/** Accepts a full share URL or a bare token and returns the token, or null. */
function parseShareToken(value: string): string | null {
  const v = value.trim();
  const m = /\/share\/([A-Za-z0-9_-]{10,})/.exec(v);
  if (m) return m[1]!;
  if (/^[A-Za-z0-9_-]{20,}$/.test(v)) return v;
  return null;
}

/** Hero controls: open a shared document by link, start writing, or scroll to the explanation. */
export function HeroActions() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const open = (e: React.FormEvent) => {
    e.preventDefault();
    const token = parseShareToken(value);
    if (!token) {
      setError('That does not look like a Confluo share link.');
      return;
    }
    setError(null);
    track('share_link_open', { location: 'hero' });
    router.push(`/share/${token}`);
  };

  return (
    <div className="mt-10 max-w-md">
      <form onSubmit={open} className="relative" role="search" aria-label="Open a shared document">
        <label htmlFor="hero-share-link" className="sr-only">
          Paste a share link to open a document
        </label>
        <input
          id="hero-share-link"
          type="text"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          placeholder="Paste a share link to open a document"
          aria-invalid={!!error}
          aria-describedby={error ? 'hero-share-error' : undefined}
          className="h-12 w-full rounded-full border-2 border-white/80 bg-transparent pl-6 pr-14 text-[15px] text-ink placeholder:text-white/45 focus:border-white focus:outline-none"
        />
        <button
          type="submit"
          aria-label="Open shared document"
          className="absolute right-1.5 top-1/2 inline-flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-full text-white hover:bg-white/10"
        >
          <ArrowRight size={20} />
        </button>
      </form>
      <p id="hero-share-error" role="status" aria-live="polite" className="mt-2 min-h-5 text-[13px] text-[#ff8fa3]">
        {error}
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Link
          href="/register"
          onClick={() => track('cta_click', { location: 'hero' })}
          className="inline-flex h-10 items-center rounded-full bg-[#1e9dff] px-6 text-[12px] font-bold uppercase tracking-[0.18em] text-white transition-colors hover:bg-[#45aeff]"
        >
          Start writing
        </Link>
        <a
          href="#how"
          onClick={() => track('cta_click', { location: 'hero', secondary: true })}
          className="inline-flex h-10 items-center rounded-full border border-white/70 px-6 text-[15px] tracking-[0.08em] text-white transition-colors hover:border-white hover:bg-white/5"
        >
          see more
        </a>
      </div>
    </div>
  );
}
