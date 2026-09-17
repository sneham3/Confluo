'use client';

import Link from 'next/link';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';

export function CtaLink({
  location,
  secondary,
  href = '/register',
  children,
  className,
}: {
  location: string;
  secondary?: boolean;
  href?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      onClick={() => track('cta_click', { location, secondary: !!secondary })}
      className={cn(
        'inline-flex h-11 items-center justify-center rounded-md px-5 text-[15px] font-medium transition-colors',
        secondary ? 'border border-line-strong bg-surface text-ink hover:border-accent' : 'bg-accent text-on-accent hover:bg-accent-hover',
        className,
      )}
    >
      {children}
    </Link>
  );
}
